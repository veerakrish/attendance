const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const moment = require('moment');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 8080;
console.log('Using port:', port);

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Configure multer for file upload
const upload = multer({ dest: 'uploads/' });

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Database setup
// Ensure data directory exists
const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'attendance.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
        // Don't exit the process, just log the error
    } else {
        console.log('Connected to the attendance database.');
    }
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY,
        roll_no TEXT UNIQUE,
        name TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY,
        student_id INTEGER,
        date TEXT,
        type TEXT,
        status TEXT,
        hours INTEGER,
        FOREIGN KEY(student_id) REFERENCES students(id)
    )`);
});

// Function to load students from CSV
function loadStudentsFromCSV(filePath) {
    return new Promise((resolve, reject) => {
        // First, clear existing students
        db.run('DELETE FROM students', [], (err) => {
            if (err) {
                console.error('Error clearing students table:', err);
                reject(err);
                return;
            }

            let insertedCount = 0;
            let errorCount = 0;
            let duplicates = [];
            let processedRollNumbers = new Set();

            fs.createReadStream(filePath)
                .pipe(csv())
                .on('data', (row) => {
                    const rollNo = row['RegdNo'];
                    const name = row['NameoftheStudent'];
                    
                    if (rollNo && name) {
                        if (processedRollNumbers.has(rollNo)) {
                            duplicates.push({ rollNo, name });
                            return;
                        }
                        
                        processedRollNumbers.add(rollNo);
                        db.run('INSERT INTO students (roll_no, name) VALUES (?, ?)',
                            [rollNo, name], (err) => {
                                if (err) {
                                    console.error(`Error inserting student ${rollNo}:`, err);
                                    errorCount++;
                                } else {
                                    insertedCount++;
                                }
                            });
                    }
                })
                .on('end', () => {
                    // Verify the data after loading
                    db.all('SELECT roll_no, name FROM students ORDER BY roll_no', [], (err, rows) => {
                        if (err) {
                            console.error('Error verifying students:', err);
                            reject(err);
                        } else {
                            console.log('\nSuccessfully loaded student data:');
                            console.log(`Total students loaded: ${insertedCount}`);
                            
                            if (duplicates.length > 0) {
                                console.log('\nWARNING: Found duplicate roll numbers:');
                                duplicates.forEach(dup => {
                                    console.log(`Roll No ${dup.rollNo}: ${dup.name} (skipped)`);
                                });
                            }
                            
                            console.log('\nFirst few students loaded:');
                            rows.slice(0, 5).forEach(student => {
                                console.log(`${student.roll_no}: ${student.name}`);
                            });
                            resolve(rows);
                        }
                    });
                })
                .on('error', (error) => {
                    console.error('Error reading CSV:', error);
                    reject(error);
                });
        });
    });
}

// Add upload route
app.get('/upload', (req, res) => {
    res.render('upload');
});

app.post('/upload', upload.single('csvFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    loadStudentsFromCSV(req.file.path)
        .then(() => {
            // Delete the uploaded file after processing
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
            res.redirect('/');
        })
        .catch(err => {
            res.status(500).send('Error processing file: ' + err.message);
        });
});

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Initialize without CSV
console.log('Server initialized without initial student data.');

// Routes
app.get('/', (req, res) => {
    db.all("SELECT * FROM students ORDER BY roll_no", [], (err, students) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }
        res.render('index', { students });
    });
});

app.post('/save-attendance', (req, res) => {
    const { date, type, presentStudents, mode } = req.body;
    const hours = 4; // 4 hours per attendance

    db.all("SELECT id FROM students", [], (err, students) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }

        const presentSet = new Set(presentStudents);
        
        students.forEach(student => {
            const status = mode === 'present' ? 
                (presentSet.has(student.id.toString()) ? 'present' : 'absent') :
                (presentSet.has(student.id.toString()) ? 'absent' : 'present');

            db.run(
                'INSERT INTO attendance (student_id, date, type, status, hours) VALUES (?, ?, ?, ?, ?)',
                [student.id, date, type, status, status === 'present' ? hours : 0]
            );
        });

        res.json({ success: true });
    });
});

app.get('/attendance-report', (req, res) => {
    db.all(`
        SELECT 
            s.roll_no,
            s.name,
            COUNT(CASE WHEN a.status = 'present' THEN 1 END) as present_days,
            SUM(CASE WHEN a.status = 'present' THEN a.hours ELSE 0 END) as total_hours,
            COUNT(DISTINCT a.date) as total_days
        FROM students s
        LEFT JOIN attendance a ON s.id = a.student_id
        GROUP BY s.id
        ORDER BY s.roll_no
    `, [], (err, report) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const reportWithPercentage = report.map(student => ({
            ...student,
            percentage: student.total_days ? 
                ((student.present_days / student.total_days) * 100).toFixed(2) : 0
        }));

        res.render('report', { report: reportWithPercentage });
    });
});

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('Database connection closed');
            }
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('Database connection closed');
            }
            process.exit(0);
        });
    });
});
