import { useState, useEffect, useRef, useMemo } from 'react';
import Papa from 'papaparse';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LabelList } from 'recharts';
import './App.css';

import * as pdfjsLib from 'pdfjs-dist';
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

// 🔥 DYNAMIC PRODUCTION API ROUTING (Bypasses hardcoded localhost barriers)
const API_BASE_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:5000' 
  : 'https://oaici-project-backend.onrender.com';

function CustomCursor() {
  const dotRef  = useRef(null);
  const ringRef = useRef(null);
  const trailsRef = useRef([]); 
  const pos = useRef({ x: 0, y: 0 });
  const ringPos = useRef({ x: 0, y: 0 });
  const rafRef = useRef(null);

  useEffect(() => {
    const TRAIL_COUNT = 8;
    const container = document.body;
    const trails = Array.from({ length: TRAIL_COUNT }, (_, i) => {
      const el = document.createElement('div');
      el.className = 'cursor-trail';
      const size = 8 - i * 0.7;
      el.style.cssText = `width:${size}px;height:${size}px;background:rgba(255,215,0,${0.55 - i * 0.06});`;
      container.appendChild(el);
      return el;
    });
    trailsRef.current = trails;

    const onMove = (e) => {
      pos.current = { x: e.clientX, y: e.clientY };
      if (dotRef.current) {
        dotRef.current.style.left = e.clientX + 'px';
        dotRef.current.style.top  = e.clientY + 'px';
      }
      const t = document.createElement('div');
      t.className = 'cursor-trail';
      const s = Math.random() * 5 + 3;
      const hue = Math.random() > 0.5 ? '51' : '0'; 
      t.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX}px;top:${e.clientY}px;background:hsla(${hue},100%,50%,0.7);`;
      container.appendChild(t);
      setTimeout(() => t.remove(), 480);
    };

    const animate = () => {
      ringPos.current.x += (pos.current.x - ringPos.current.x) * 0.12;
      ringPos.current.y += (pos.current.y - ringPos.current.y) * 0.12;
      if (ringRef.current) {
        ringRef.current.style.left = ringPos.current.x + 'px';
        ringRef.current.style.top  = ringPos.current.y + 'px';
      }
      rafRef.current = requestAnimationFrame(animate);
    };

    window.addEventListener('mousemove', onMove);
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(rafRef.current);
      trails.forEach(t => t.remove());
    };
  }, []);

  return (
    <>
      <div className="cursor-dot"  ref={dotRef}  />
      <div className="cursor-ring" ref={ringRef} />
    </>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [loginError, setLoginError] = useState('');

  const [activeTab, setActiveTab] = useState('analytics');
  const [evaluations, setEvaluations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiScoring, setAiScoring] = useState(false);

  // --- SEARCH & FILTER CONTROLLER STATES ---
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [courseFilter, setCourseFilter] = useState('all');

  const [csvCourseCode, setCsvCourseCode] = useState('');
  const [groundedMasterText, setGroundedMasterText] = useState('');
  const [groundedFilesList, setGroundedFilesList] = useState([]);

  const [activeTarget, setActiveTarget] = useState(null);
  const [aiJustification, setAiJustification] = useState('');
  const [manualEntry, setManualEntry] = useState({
    student_email: '', course_code: '', student_prompt: '', walter_response: ''
  });
  
  const [isEditingRecord, setIsEditingRecord] = useState(false);
  const [editFormData, setEditFormData] = useState({
    student_email: '', course_code: '', student_prompt: '', walter_response: ''
  });

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginForm)
      });
      const json = await res.json();
      if (json.success) {
        setCurrentUser(json.user);
        fetchEvaluations();
      } else {
        setLoginError(json.message);
      }
    } catch (error) {
      setLoginError("Failed to connect to authentication server.");
    }
    setLoading(false);
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setEvaluations([]);
    clearGroundingContext();
  };

  useEffect(() => {
    const scriptAssetElement = document.createElement('script');
    scriptAssetElement.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    scriptAssetElement.async = true;
    scriptAssetElement.onload = () => {
      const runtimePdfEngine = window['pdfjs-dist/build/pdf'];
      if (runtimePdfEngine) {
        runtimePdfEngine.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      }
    };
    document.head.appendChild(scriptAssetElement);
    return () => { scriptAssetElement.remove(); };
  }, []);

  const handleContextDocumentUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const pdfjsLib = window['pdfjs-dist/build/pdf'];
    if (!pdfjsLib) {
      alert("Grounding engine is still establishing network connection assets. Please try again in 2 seconds.");
      return;
    }

    if (groundedFilesList.includes(file.name)) {
      alert("This document is already currently active in browser state.");
      return;
    }

    setLoading(true);
    const fileReader = new FileReader();
    
    fileReader.onload = async (event) => {
      const arrayBufferContents = new Uint8Array(event.target.result);
      try {
        const rawPdfMatrix = await pdfjsLib.getDocument(arrayBufferContents).promise;
        let runningTextStreamAccumulator = `\n\n=== START OF SOURCE: ${file.name} ===\n`;

        for (let pageNum = 1; pageNum <= rawPdfMatrix.numPages; pageNum++) {
          const activePage = await rawPdfMatrix.getPage(pageNum);
          const rawTextContent = await activePage.getTextContent();
          const pageStringsCompiled = rawTextContent.items.map(item => item.str).join(' ');
          runningTextStreamAccumulator += pageStringsCompiled + '\n';
        }

        runningTextStreamAccumulator += `=== END OF SOURCE: ${file.name} ===\n`;

        setGroundedMasterText(prev => prev + runningTextStreamAccumulator);
        setGroundedFilesList(prev => [...prev, file.name]);
        alert(`📚 Successfully grounded text layers from "${file.name}" (${rawPdfMatrix.numPages} Pages).`);
      } catch (error) {
        console.error(error);
        alert("Exception parsing content matrices from target PDF binary stream.");
      } finally {
        setLoading(false);
        e.target.value = ""; 
      }
    };
    fileReader.readAsArrayBuffer(file);
  };

  const clearGroundingContext = () => {
    setGroundedMasterText('');
    setGroundedFilesList([]);
    alert("Ephemeral browser context layers purged cleanly.");
  };

  const fetchEvaluations = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/evaluations`);
      const json = await res.json();
      if (json.success) setEvaluations(json.data);
    } catch (error) {
      console.error("Failed fetching database matrix.", error);
    }
    setLoading(false);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!csvCourseCode.trim()) {
      alert("Action Blocked: Please enter the Target Course Code (e.g. DCPE701) before selecting your CSV file.");
      e.target.value = ""; 
      return;
    }

    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: async (results) => {
        const mappedData = results.data.map(row => ({
          student_email: row.author_email || row.student_email || 'anonymous',
          course_code: csvCourseCode.trim(), 
          student_prompt: row.question_text || row.student_prompt || '',
          walter_response: row.reply_text || row.walter_response || ''
        }));
        await uploadDataToBackend(mappedData);
        setCsvCourseCode(''); 
      }
    });
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    await uploadDataToBackend([manualEntry]);
    setManualEntry({ student_email: '', course_code: '', student_prompt: '', walter_response: '' });
  };

  const uploadDataToBackend = async (dataArray) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/evaluations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evaluations: dataArray })
      });
      const json = await res.json();
      if (json.success) { alert(json.message); fetchEvaluations(); setActiveTab('list'); }
    } catch (error) { alert("Network exception communicating with server."); }
    setLoading(false);
  };

  const deleteActiveRecord = async () => {
    if (!window.confirm(`⚠️ WARNING: Are you sure you want to permanently delete record ${activeTarget.eval_id}? This action cannot be undone.`)) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/evaluations/${activeTarget.eval_id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setActiveTarget(null); 
        setAiJustification('');
        fetchEvaluations(); 
      } else alert(json.message);
    } catch (error) { alert("Failed connecting to deletion server endpoint."); }
    setLoading(false);
  };

  const saveRecordEdits = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/evaluations/edit-transcript`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eval_id: activeTarget.eval_id,
          student_email: editFormData.student_email,
          course_code: editFormData.course_code,
          student_prompt: editFormData.student_prompt,
          walter_response: editFormData.walter_response
        })
      });
      const json = await res.json();
      if (json.success) {
        setActiveTarget(prev => ({ ...prev, ...editFormData }));
        setIsEditingRecord(false);
        fetchEvaluations();
      } else {
        alert(json.message);
      }
    } catch (error) {
      alert("Failed connecting to the update API.");
    }
    setLoading(false);
  };

  const triggerAiEvaluation = async () => {
    setAiScoring(true);
    setAiJustification('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/evaluations/ai-judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          student_prompt: activeTarget.student_prompt, 
          walter_response: activeTarget.walter_response,
          reference_material: groundedMasterText 
        })
      });
      const json = await res.json();
      if (json.success) {
        setActiveTarget(prev => ({
          ...prev,
          accuracy: String(json.evaluation.accuracy),
          alignment: String(json.evaluation.alignment),
          hallucination: String(json.evaluation.hallucination),
          pedagogy: String(json.evaluation.pedagogy)
        }));
        setAiJustification(json.evaluation.reason);
      } else { alert(json.message); }
    } catch (error) { alert("Failed connecting to Gemini routing channel."); }
    setAiScoring(false);
  };

  const saveFinalEvaluation = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/evaluations/submit-grade`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eval_id: activeTarget.eval_id, accuracy: activeTarget.accuracy,
          alignment: activeTarget.alignment, hallucination: activeTarget.hallucination, pedagogy: activeTarget.pedagogy,
          graded_by: currentUser 
        })
      });
      const json = await res.json();
      if (json.success) { setActiveTarget(null); setAiJustification(''); fetchEvaluations(); }
    } catch (error) { alert("Failed writing metrics to database."); }
    setLoading(false);
  };

  const analytics = useMemo(() => {
    const graded = evaluations.filter(ev => ev.graded_status === 'Yes');
    const total = graded.length;
    if (total === 0) return { total: 0, accuracy: 0, alignment: 0, hallucination: 0, pedagogy: 0, pending: evaluations.length };
    const sum = (field) => graded.reduce((acc, curr) => acc + (parseInt(curr[field]) || 0), 0);
    return {
      total,
      pending: evaluations.length - total,
      accuracy: Math.round((sum('accuracy') / total) * 100),
      alignment: Math.round((sum('alignment') / total) * 100),
      hallucination: Math.round((sum('hallucination') / total) * 100),
      pedagogy: Math.round((sum('pedagogy') / total) * 100)
    };
  }, [evaluations]);

  const filteredEvaluations = useMemo(() => {
    return evaluations.filter(item => {
      const matchesSearch = 
        item.student_email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.student_prompt.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.graded_by && item.graded_by.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesStatus = 
        statusFilter === 'all' || 
        (statusFilter === 'graded' && item.graded_status === 'Yes') ||
        (statusFilter === 'pending' && item.graded_status !== 'Yes');

      const matchesCourse = 
        courseFilter === 'all' || 
        item.course_code === courseFilter;

      return matchesSearch && matchesStatus && matchesCourse;
    });
  }, [evaluations, searchQuery, statusFilter, courseFilter]);

  const uniqueCourseCodesList = useMemo(() => {
    const codes = evaluations.map(item => item.course_code).filter(Boolean);
    return [...new Set(codes)];
  }, [evaluations]);

  const handleDataReportExport = () => {
    if (evaluations.length === 0) {
      alert("No database records available to process into export matrices.");
      return;
    }
    let csvStringStream = `========================================================\n`;
    csvStringStream += `MAPUA OAICI QUALITY FRAMEWORK AUDIT REPORT\n`;
    csvStringStream += `Generated on: ${new Date().toLocaleString()}\n`;
    csvStringStream += `========================================================\n`;
    csvStringStream += `Total Monitored Interactions,${evaluations.length}\n`;
    csvStringStream += `Total Completed Audits,${analytics.total}\n`;
    csvStringStream += `Pending Awaiting Action,${analytics.pending}\n`;
    csvStringStream += `Fact-Check Accuracy Rate,${analytics.accuracy}%\n`;
    csvStringStream += `Curriculum Alignment Compliance,${analytics.alignment}%\n`;
    csvStringStream += `Critical Hallucination Incident Rate,${analytics.hallucination}%\n`;
    csvStringStream += `Pedagogical Guidance Compliance,${analytics.pedagogy}%\n`;
    csvStringStream += `========================================================\n\n`;

    const atomicHeaders = ["eval_id", "student_email", "course_code", "student_prompt", "walter_response", "accuracy", "alignment", "hallucination", "pedagogy", "graded_status", "graded_by"];
    csvStringStream += atomicHeaders.join(",") + "\n";

    evaluations.forEach(item => {
      const rowCleaned = atomicHeaders.map(header => {
        let textValue = item[header] || "";
        textValue = textValue.toString().replace(/"/g, '""');
        if (textValue.includes(",") || textValue.includes("\n")) {
          textValue = `"${textValue}"`;
        }
        return textValue;
      });
      csvStringStream += rowCleaned.join(",") + "\n";
    });

    const blobObject = new Blob([csvStringStream], { type: "text/csv;charset=utf-8;" });
    const dynamicLink = document.createElement("a");
    const downloadUrlElement = URL.createObjectURL(blobObject);
    dynamicLink.setAttribute("href", downloadUrlElement);
    dynamicLink.setAttribute("download", `OAICI_AI_Audit_Report_${Date.now()}.csv`);
    dynamicLink.style.visibility = 'hidden';
    document.body.appendChild(dynamicLink);
    dynamicLink.click();
    document.body.removeChild(dynamicLink);
  };

  const pieData = [
    { name: 'Audited', value: analytics.total },
    { name: 'Pending', value: analytics.pending }
  ];
  const pieColors = ['#A32A29', '#C9A84C'];

  const barData = [
    { name: 'Accuracy',      Score: analytics.accuracy,      fill: '#2E7D32' },
    { name: 'Alignment',     Score: analytics.alignment,     fill: '#C9A84C' },
    { name: 'Pedagogy',      Score: analytics.pedagogy,      fill: '#7B1FA2' },
    { name: 'Hallucination', Score: analytics.hallucination, fill: '#FF1744' }
  ];

  const tooltipStyle = {
    contentStyle: { backgroundColor: '#1A0A00', border: '1px solid rgba(201,168,76,0.4)', borderRadius: 8, color: '#fff', fontSize: '0.85rem' },
    cursor: { fill: 'rgba(163,42,41,0.06)' }
  };

  if (!currentUser) {
    return (
      <>
        <CustomCursor />
        <div className="login-wrapper">
          <div className="login-card">
            <img src="/mappy_image.png" alt="Mappy" className="login-logo" />
            <h2>OAICI Portal Access</h2>
            <p>Sign in with your authorized administrator credentials to access the evaluation platform.</p>
            <form onSubmit={handleLogin} className="login-form">
              <input
                type="email" placeholder="Email Address" required
                value={loginForm.email}
                onChange={e => setLoginForm({ ...loginForm, email: e.target.value })}
              />
              <input
                type="password" placeholder="Password" required
                value={loginForm.password}
                onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
              />
              {loginError && <div className="login-error">{loginError}</div>}
              <input type="submit" style={{display: 'none'}} /> 
              <button type="submit" disabled={loading}>
                {loading ? 'Authenticating…' : 'Secure Login →'}
              </button>
            </form>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <CustomCursor />
      <div className="app-container">
        <header className="app-header">
          <div className="brand-container">
            <img src="/mappy_image.png" alt="Mappy Logo" className="brand-logo" />
            <h1>OAICI AI Tutor Evaluator</h1>
          </div>
          <nav className="tab-navigation">
            <button className={activeTab === 'analytics' ? 'active' : ''} onClick={() => setActiveTab('analytics')}>
              Analytics
            </button>
            <button className={activeTab === 'list' ? 'active' : ''} onClick={() => setActiveTab('list')}>
              Database
            </button>
            <button className={activeTab === 'upload' ? 'active' : ''} onClick={() => setActiveTab('upload')}>
              Ingestion
            </button>
            <button className="logout-btn" onClick={handleLogout}>Log Out</button>
          </nav>
        </header>

        <section className="grounding-control-strip">
          <div className="grounding-uploader-zone">
            <label className="grounding-file-label">
              📚 Ground AI Audit Context (Upload Syllabus/Lecture PDF):
              <input type="file" accept=".pdf" onChange={handleContextDocumentUpload} style={{display: 'none'}} />
            </label>
            {groundedFilesList.length > 0 && (
              <button className="purge-grounding-btn" onClick={clearGroundingContext}>Flush Memory (Reset)</button>
            )}
          </div>
          <div className="grounding-status-indicators">
            <strong>Active Baseline Sources ({groundedFilesList.length}):</strong>
            <div className="grounding-chips-wrap">
              {groundedFilesList.map((filename, idx) => (
                <span key={idx} className="grounding-file-chip">📄 {filename}</span>
              ))}
              {groundedFilesList.length === 0 && <span className="grounding-empty-label">No files loaded. AI Auditor is operating via standard weights.</span>}
            </div>
          </div>
        </section>

        <main className="app-content">
          {loading && <div className="loading-banner">⬤ Synchronizing with Database…</div>}

          {activeTab === 'analytics' && (
            <div className="analytics-container">
              <h2>Macro Evaluation Metrics</h2>
              <p>Overall performance data based on strictly graded AI Chatbot interactions.</p>

              <div className="metric-grid">
                <div className="metric-card neutral">
                  <h3>Total Graded</h3>
                  <div className="metric-value">{analytics.total}</div>
                  <div className="metric-subtext">{analytics.pending} pending audits</div>
                </div>
                <div className="metric-card success">
                  <h3>Accuracy Rate</h3>
                  <div className="metric-value">{analytics.accuracy}%</div>
                  <div className="metric-subtext">Factually correct responses</div>
                </div>
                <div className="metric-card danger">
                  <h3>Hallucination Rate</h3>
                  <div className="metric-value">{analytics.hallucination}%</div>
                  <div className="metric-subtext">Critical risk — lower is better</div>
                </div>
                <div className="metric-card primary">
                  <h3>Pedagogical Quality</h3>
                  <div className="metric-value">{analytics.pedagogy}%</div>
                  <div className="metric-subtext">Proactive guidance compliance</div>
                </div>
              </div>

              <div className="charts-grid">
                <div className="chart-card">
                  <h3>Audit Completion Status</h3>
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={72} outerRadius={104}
                           paddingAngle={4} dataKey="value" stroke="none">
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={pieColors[index % pieColors.length]} />
                        ))}
                        <LabelList
                          dataKey="value"
                          position="inside"
                          offset={0}
                          style={{ fontSize: '1.05rem', fontWeight: 700, fill: '#FFFFFF' }}
                        />
                      </Pie>
                      <Tooltip {...tooltipStyle} cursor={false} />
                      <Legend verticalAlign="bottom" height={36}
                        formatter={(value) => <span style={{ color: '#6B5040', fontSize: '0.85rem' }}>{value}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                <div className="chart-card">
                  <h3>Quality Framework Breakdown (%)</h3>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={barData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(163,42,41,0.1)" vertical={false} />
                      <XAxis dataKey="name" stroke="#6B5040" tick={{ fontSize: 12 }} />
                      <YAxis stroke="#6B5040" domain={[0, 100]} tick={{ fontSize: 12 }} />
                      <Tooltip {...tooltipStyle} />
                      <Bar dataKey="Score" radius={[6, 6, 0, 0]}>
                        {barData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.fill} />
                        ))}
                        <LabelList
                          dataKey="Score"
                          position="top"
                          formatter={(value) => `${value}%`}
                          style={{ fontSize: '0.8rem', fontWeight: 700, fill: '#1A0A00' }}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'list' && (
            <div className="table-container">
              <div className="table-action-header-strip">
                <h2>Evaluation Database</h2>
                <button className="export-report-action-btn" onClick={handleDataReportExport}>
                  📥 Export Audit Summary & Logs (.CSV)
                </button>
              </div>

              <div className="search-filter-dashboard-panel">
                <input 
                  type="text" 
                  className="search-box-input-element"
                  placeholder="🔍 Search Student Email, Auditor name, or Question keywords..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                
                <div className="filter-dropdown-wrapper-box">
                  <select 
                    value={statusFilter} 
                    onChange={e => setStatusFilter(e.target.value)}
                    className="filter-select-element"
                  >
                    <option value="all">All Grading Statuses</option>
                    <option value="graded">Graded Interactions Only</option>
                    <option value="pending">Pending Review Only</option>
                  </select>

                  <select 
                    value={courseFilter} 
                    onChange={e => setCourseFilter(e.target.value)}
                    className="filter-select-element"
                  >
                    <option value="all">All Course Codes</option>
                    {uniqueCourseCodesList.map((code, idx) => (
                      <option key={idx} value={code}>{code}</option>
                    ))}
                  </select>
                </div>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Student Email</th>
                    <th>Course</th>
                    <th>Prompt Snippet</th>
                    <th>Status</th>
                    <th>Auditor</th> 
                  </tr>
                </thead>
                <tbody>
                  {filteredEvaluations.map((ev, index) => (
                    <tr key={index} className="clickable-row" onClick={() => {
                      setActiveTarget(ev);
                      setIsEditingRecord(false); 
                    }}>
                      <td><small style={{ color: '#9E8060', fontFamily: 'monospace', fontSize: '0.78rem' }}>{ev.eval_id}</small></td>
                      <td style={{ fontWeight: 500 }}>{ev.student_email}</td>
                      <td><span className="badge-course">{ev.course_code}</span></td>
                      <td className="truncate">{ev.student_prompt}</td>
                      <td>
                        <span className={`badge-status ${ev.graded_status === 'Yes' ? 'graded' : 'pending'}`}>
                          {ev.graded_status === 'Yes' ? 'Graded' : 'Pending'}
                        </span>
                      </td>
                      <td><small style={{ color: '#6B5040', fontWeight: 600 }}>{ev.graded_by || <span style={{opacity: 0.4}}>—</span>}</small></td>
                    </tr>
                  ))}
                  {filteredEvaluations.length === 0 && (
                    <tr>
                      <td colSpan="6" style={{textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontStyle: 'italic'}}>
                        No matching evaluation records found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'upload' && (
            <div className="ingestion-container">
              <div className="ingestion-card">
                <h2>Bulk Import</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
                  Upload a Noodle Factory CSV export to batch-ingest student interaction records.
                </p>
                <input 
                  type="text" 
                  className="csv-course-input" 
                  placeholder="Type Course Code (e.g., DCPE701)" 
                  value={csvCourseCode} 
                  onChange={e => setCsvCourseCode(e.target.value.toUpperCase())} 
                />
                <input type="file" accept=".csv" onChange={handleFileUpload}
                  className="bulk-import-file-input" />
              </div>

              <div className="divider">OR</div>

              <div className="ingestion-card">
                <h2>Manual Quick-Add</h2>
                <form onSubmit={handleManualSubmit} className="manual-form">
                  <input type="text" placeholder="Student Email" required
                    value={manualEntry.student_email}
                    onChange={e => setManualEntry({ ...manualEntry, student_email: e.target.value })} />
                  <input type="text" placeholder="Course Code" required
                    value={manualEntry.course_code}
                    onChange={e => setManualEntry({ ...manualEntry, course_code: e.target.value })} />
                  <textarea placeholder="Student Question" required rows={2}
                    value={manualEntry.student_prompt}
                    onChange={e => setManualEntry({ ...manualEntry, student_prompt: e.target.value })} />
                  <textarea placeholder="Walter AI Response" required rows={2}
                    value={manualEntry.walter_response}
                    onChange={e => setManualEntry({ ...manualEntry, walter_response: e.target.value })} />
                  <button type="submit" className="submit-btn">Add to Database →</button>
                </form>
              </div>
            </div>
          )}

          {activeTarget && (
            <div className="modal-overlay">
              <div className="workspace-modal">
                <div className="modal-header">
                  <div>
                    <h2>Evaluation Workspace — {activeTarget.eval_id}</h2>
                    {!isEditingRecord && (
                      <span style={{fontSize: '0.85rem', color: 'var(--text-muted)', display: 'block', marginTop: '4px'}}>
                        <strong>User:</strong> {activeTarget.student_email} &nbsp;|&nbsp; <strong>Course:</strong> {activeTarget.course_code}
                      </span>
                    )}
                  </div>
                  <button className="close-modal-btn" onClick={() => { setActiveTarget(null); setAiJustification(''); }}>✕</button>
                </div>

                {isEditingRecord ? (
                  <div className="edit-mode-panel">
                    <div className="edit-input-group">
                      <label>Student Email:</label>
                      <input type="text" value={editFormData.student_email} onChange={e => setEditFormData({...editFormData, student_email: e.target.value})} />
                    </div>
                    <div className="edit-input-group">
                      <label>Course Code:</label>
                      <input type="text" value={editFormData.course_code} onChange={e => setEditFormData({...editFormData, course_code: e.target.value})} />
                    </div>
                    <div className="edit-input-group">
                      <label>Student Prompt:</label>
                      <textarea rows="4" value={editFormData.student_prompt} onChange={e => setEditFormData({...editFormData, student_prompt: e.target.value})} />
                    </div>
                    <div className="edit-input-group">
                      <label>Walter AI Response:</label>
                      <textarea rows="6" value={editFormData.walter_response} onChange={e => setEditFormData({...editFormData, walter_response: e.target.value})} />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="side-by-side-grid">
                      <div className="transcript-pane">
                        <h3>Student Question</h3>
                        <div className="text-box-display">{activeTarget.student_prompt}</div>
                      </div>
                      <div className="transcript-pane">
                        <h3>Walter AI Response</h3>
                        <div className="text-box-display">{activeTarget.walter_response}</div>
                      </div>
                    </div>

                    <div className="metrics-control-panel">
                      <h3>Quality Evaluation Metrics</h3>
                      <div className="ai-trigger-strip">
                        <button className="ai-judge-btn" disabled={aiScoring} onClick={triggerAiEvaluation}>
                          {aiScoring ? '🤖 Executing AI Audit…' : '🤖 AI Score via Gemini'}
                        </button>
                        {aiJustification && (
                          <div className="ai-reason-bubble">
                            <strong>Gemini Reasoning:</strong> {aiJustification}
                          </div>
                        )}
                      </div>

                      <div className="toggles-grid">
                        <div className="toggle-control">
                          <label>Accuracy (Fact Check)</label>
                          <select value={activeTarget.accuracy || '0'} onChange={e => setActiveTarget({ ...activeTarget, accuracy: e.target.value })}>
                            <option value="1">1 — Factually Correct</option><option value="0">0 — Contains Errors</option>
                          </select>
                        </div>
                        <div className="toggle-control">
                          <label>Curriculum Alignment</label>
                          <select value={activeTarget.alignment || '0'} onChange={e => setActiveTarget({ ...activeTarget, alignment: e.target.value })}>
                            <option value="1">1 — Aligns to Syllabus</option><option value="0">0 — Off-Topic / Irrelevant</option>
                          </select>
                        </div>
                        <div className="toggle-control">
                          <label>Hallucination Detection</label>
                          <select value={activeTarget.hallucination || '0'} onChange={e => setActiveTarget({ ...activeTarget, hallucination: e.target.value })}>
                            <option value="1">1 — Hallucinated / Made Up</option><option value="0">0 — Grounded in Materials</option>
                          </select>
                        </div>
                        <div className="toggle-control">
                          <label>Pedagogical Quality</label>
                          <select value={activeTarget.pedagogy || '0'} onChange={e => setActiveTarget({ ...activeTarget, pedagogy: e.target.value })}>
                            <option value="1">1 — Proactive (Guides Learner)</option><option value="0">0 — Passive / Ineffective</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    <button className="delete-btn" onClick={deleteActiveRecord}>🗑️ Delete Record</button>
                    {!isEditingRecord && (
                      <button className="edit-record-btn" onClick={() => {
                        setEditFormData({
                          student_email: activeTarget.student_email,
                          course_code: activeTarget.course_code,
                          student_prompt: activeTarget.student_prompt,
                          walter_response: activeTarget.walter_response
                        });
                        setIsEditingRecord(true);
                      }}>
                        ✏️ Edit Data
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    <button className="cancel-btn" onClick={() => {
                      if (isEditingRecord) { setIsEditingRecord(false); } 
                      else { setActiveTarget(null); setAiJustification(''); }
                    }}>
                      {isEditingRecord ? "Cancel Edits" : "Discard Changes"}
                    </button>
                    
                    {isEditingRecord ? (
                      <button className="export-report-action-btn" onClick={saveRecordEdits}>
                        💾 Save Record Edits
                      </button>
                    ) : (
                      <button className="save-metrics-btn" onClick={saveFinalEvaluation}>
                        Lock & Save Audit Metrics ✓
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}

export default App;