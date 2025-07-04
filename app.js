const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const moment = require('moment');

const app = express();
const port = 3000;

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Database setup
const db = new sqlite3.Database('attendance.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to the attendance database.');
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
function loadStudentsFromCSV() {
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

            fs.createReadStream('rolllist.csv')
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

// Load students when the application starts
loadStudentsFromCSV().then(() => {
    console.log('Initial student data load completed.');
}).catch(err => {
    console.error('Failed to load student data:', err);
});

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

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
