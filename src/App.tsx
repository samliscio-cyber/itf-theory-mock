// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type Question = {
  id: string;
  prompt: string;
  modelAnswer: string;
  tags?: string[];
  sourceNote?: string;
};

type HistoryEntry = {
  id: string;
  qid: string;
  correct: boolean;
  at: string;
  tags: string[];
};

type Settings = {
  reminderEnabled: boolean;
  reminderTime: string; // "HH:MM"
  reminderDays: number[]; // 0=Sun..6=Sat
  reminderMessage: string;
  dailyGoal: number;
  testLength: number;
  theme: "light" | "dark";
};

const LS_KEYS = {
  BANK: "itf_bank_v2",
  HISTORY: "itf_history_v2",
  SETTINGS: "itf_settings_v2",
} as const;

const DEFAULT_SETTINGS: Settings = {
  reminderEnabled: false,
  reminderTime: "19:30",
  reminderDays: [1, 2, 3, 4, 5, 6, 0],
  reminderMessage: "It’s time for your Taekwon-Do theory mock test.",
  dailyGoal: 10,
  testLength: 10,
  theme: "light",
};

function uid(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function dayName(d: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d] ?? "";
}

function nextReminderDelayMs(settings: Settings) {
  const now = new Date();
  const [hh, mm] = settings.reminderTime.split(":").map((x) => parseInt(x, 10));
  const candidate = new Date(now);
  candidate.setHours(hh, mm, 0, 0);

  const allowed = new Set(settings.reminderDays);

  for (let i = 0; i < 8; i++) {
    const okDay = allowed.has(candidate.getDay());
    const inFuture = candidate.getTime() > now.getTime();
    if (okDay && inFuture) return candidate.getTime() - now.getTime();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hh, mm, 0, 0);
  }
  return 24 * 60 * 60 * 1000;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Seeded from your sheets; add more via Edit/paste JSON in the app.
const BUILTIN_QUESTION_BANK: Question[] = [
  {
    id: "q_tenets",
    prompt: "What are the five tenets of Taekwon-Do?",
    modelAnswer: "Courtesy, Integrity, Perseverance, Self-Control, Indomitable Spirit.",
    tags: ["tenets", "basics"],
    sourceNote: "OMA theory sheet",
  },
  {
    id: "q_theory_power",
    prompt: "What is the Theory of Power in ITF Taekwon-Do?",
    modelAnswer:
      "The Theory of Power explains how maximum force is generated. It consists of six factors: reaction force, concentration, equilibrium (balance), breath control, speed, and mass.",
    tags: ["theory-of-power", "basics"],
    sourceNote: "OMA theory sheet",
  },
  {
    id: "q_pattern_def",
    prompt: "What is a pattern (tul)?",
    modelAnswer:
      "A pattern is a sequence of fundamental movements performed against imaginary opponents. Patterns teach correct technique, balance, power, breathing, and mental focus, and help preserve Taekwon-Do history.",
    tags: ["patterns", "basics"],
    sourceNote: "OMA theory sheet",
  },
  {
    id: "q_itf_founded",
    prompt: "Who founded the ITF and when?",
    modelAnswer: "The ITF was founded in 1966 by General Choi Hong Hi.",
    tags: ["history"],
    sourceNote: "OMA theory sheet",
  },
  {
    id: "q_tool_target",
    prompt: "What is meant by ‘Tool’ and ‘Target’?",
    modelAnswer:
      "The tool is the body part used to strike or block (e.g., forefist, knife-hand). The target is the point on the opponent’s body that the technique is aimed at.",
    tags: ["basics"],
    sourceNote: "OMA theory sheet",
  },
  {
    id: "q_bending_stance_patterns",
    prompt: "Name 3 patterns with bending (goburyo) stance.",
    modelAnswer: "Won-Hyo, Yul-Gok, and Choong-Moo.",
    tags: ["patterns"],
    sourceNote: "Black belt pointers sheet",
  },
  {
    id: "q_backfist_patterns",
    prompt: "Name 5 patterns containing backfist.",
    modelAnswer: "Do-San, Yul-Gok, Joong-Gun, Toi-Gye, Choong-Moo.",
    tags: ["patterns"],
    sourceNote: "Black belt pointers sheet",
  },
  {
    id: "q_fingertip_thrust_types",
    prompt: "Name 3 types of fingertip thrust.",
    modelAnswer: "Straight, Flat, and Upset fingertip thrust.",
    tags: ["technique"],
    sourceNote: "Black belt pointers + terminology sheet",
  },
  {
    id: "q_release_patterns",
    prompt: "Name 3 patterns containing releases.",
    modelAnswer: "Do-San, Joong-Gun, Hwa-Rang.",
    tags: ["patterns"],
    sourceNote: "Black belt pointers sheet",
  },
  {
    id: "q_slow_motion",
    prompt: "Why do we require slow motion moves?",
    modelAnswer:
      "To develop balance, breath control, timing, concentration, and body awareness, and to ensure correct technique and control through the full range of motion.",
    tags: ["patterns", "theory-of-power"],
    sourceNote: "OMA theory sheet",
  },
];

function computeStats(history: HistoryEntry[]) {
  const total = history.length;
  const correct = history.filter((h) => h.correct).length;
  const incorrect = total - correct;

  const byQuestion: Record<string, { attempts: number; correct: number; incorrect: number }> = {};
  const byTag: Record<string, { attempts: number; correct: number; incorrect: number }> = {};

  for (const h of history) {
    byQuestion[h.qid] ??= { attempts: 0, correct: 0, incorrect: 0 };
    byQuestion[h.qid].attempts += 1;
    if (h.correct) byQuestion[h.qid].correct += 1;
    else byQuestion[h.qid].incorrect += 1;

    for (const t of h.tags || []) {
      byTag[t] ??= { attempts: 0, correct: 0, incorrect: 0 };
      byTag[t].attempts += 1;
      if (h.correct) byTag[t].correct += 1;
      else byTag[t].incorrect += 1;
    }
  }

  const accuracy = total ? Math.round((correct / total) * 100) : 0;

  return { total, correct, incorrect, accuracy, byQuestion, byTag };
}

function pickQuestion(pool: Question[]) {
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export default function App() {
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadJSON(LS_KEYS.HISTORY, []));
  const [settings, setSettings] = useState<Settings>(() => loadJSON(LS_KEYS.SETTINGS, DEFAULT_SETTINGS));
  const [bank, setBank] = useState<Question[]>(() => loadJSON(LS_KEYS.BANK, BUILTIN_QUESTION_BANK));

  const stats = useMemo(() => computeStats(history), [history]);

  const [current, setCurrent] = useState<Question | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);

  const [filters, setFilters] = useState<{ tags: Set<string> }>({ tags: new Set() });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState("");

  const reminderTimerRef = useRef<number | null>(null);

  // Exam mode state
  const [mode, setMode] = useState<"practice" | "exam" | "examResult">("practice");
  const [examOrder, setExamOrder] = useState<Question[]>([]);
  const [examIndex, setExamIndex] = useState(0);
  const [examAnswers, setExamAnswers] = useState<{ qid: string; correct: boolean }[]>([]);

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
    saveJSON(LS_KEYS.SETTINGS, settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.theme]);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const q of bank) (q.tags || []).forEach((t) => s.add(t));
    return Array.from(s).sort();
  }, [bank]);

  const pool = useMemo(() => {
    if (!filters.tags.size) return bank;
    return bank.filter((q) => (q.tags || []).some((t) => filters.tags.has(t)));
  }, [bank, filters.tags]);

  function newPracticeQuestion() {
    const q = pickQuestion(pool);
    setCurrent(q);
    setShowAnswer(false);
  }

  function logAttempt(q: Question, correct: boolean) {
    const entry: HistoryEntry = {
      id: uid(),
      qid: q.id,
      correct,
      at: new Date().toISOString(),
      tags: q.tags || [],
    };
    const nextHistory = [entry, ...history].slice(0, 5000);
    setHistory(nextHistory);
    saveJSON(LS_KEYS.HISTORY, nextHistory);
  }

  function scorePractice(correct: boolean) {
    if (!current) return;
    logAttempt(current, correct);
    newPracticeQuestion();
  }

  async function requestNotifications() {
    if (!("Notification" in window)) return false;
    const perm = await Notification.requestPermission();
    return perm === "granted";
  }

  function fireReminderNotification() {
    try {
      new Notification("ITF Theory Mock Test", { body: settings.reminderMessage });
    } catch {}
  }

  function scheduleReminderLoop(nextSettings?: Settings) {
    const s = nextSettings || settings;
    if (reminderTimerRef.current) {
      clearTimeout(reminderTimerRef.current);
      reminderTimerRef.current = null;
    }
    if (!s.reminderEnabled) return;

    const ms = nextReminderDelayMs(s);
    reminderTimerRef.current = window.setTimeout(() => {
      fireReminderNotification();
      scheduleReminderLoop(s);
    }, ms);
  }

  useEffect(() => {
    if (!current) newPracticeQuestion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    saveJSON(LS_KEYS.SETTINGS, settings);
    scheduleReminderLoop(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    saveJSON(LS_KEYS.BANK, bank);
  }, [bank]);

  const todayCount = useMemo(() => {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth();
    const d = today.getDate();
    return history.filter((h) => {
      const dt = new Date(h.at);
      return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
    }).length;
  }, [history]);

  const goalPct = settings.dailyGoal ? clamp(Math.round((todayCount / settings.dailyGoal) * 100), 0, 100) : 0;

  function toggleTag(t: string) {
    setFilters((f) => {
      const next = new Set(f.tags);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return { tags: next };
    });
  }

  function openEditor() {
    setEditorText(JSON.stringify(bank, null, 2));
    setEditorOpen(true);
  }

  function saveEditor() {
    try {
      const parsed = JSON.parse(editorText);
      if (!Array.isArray(parsed)) throw new Error("Bank must be a JSON array.");
      setBank(parsed);
      setEditorOpen(false);
    } catch (e: any) {
      alert(e?.message || "Could not save bank.");
    }
  }

  function exportBank() {
    const blob = new Blob([JSON.stringify(bank, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "itf-theory-question-bank.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Weak areas
  const weakestTags = useMemo(() => {
    const rows = Object.entries(stats.byTag).map(([tag, v]) => ({
      tag,
      attempts: v.attempts,
      acc: v.attempts ? Math.round((v.correct / v.attempts) * 100) : 0,
    }));
    // prioritize: enough attempts + low accuracy
    rows.sort((a, b) => (a.acc - b.acc) || (b.attempts - a.attempts));
    return rows.filter(r => r.attempts >= 3).slice(0, 5);
  }, [stats.byTag]);

  const weakestQuestions = useMemo(() => {
    const byId = stats.byQuestion;
    const rows = Object.entries(byId).map(([qid, v]) => ({
      qid,
      attempts: v.attempts,
      acc: v.attempts ? Math.round((v.correct / v.attempts) * 100) : 0,
    }));
    rows.sort((a, b) => (a.acc - b.acc) || (b.attempts - a.attempts));
    const idToPrompt = new Map(bank.map(q => [q.id, q.prompt]));
    return rows
      .filter(r => r.attempts >= 2)
      .slice(0, 5)
      .map(r => ({ ...r, prompt: idToPrompt.get(r.qid) || r.qid }));
  }, [stats.byQuestion, bank]);

  // Exam mode
  function startExam() {
    const len = clamp(settings.testLength || 10, 5, 50);
    const chosen = shuffle(pool).slice(0, Math.min(len, pool.length));
    setExamOrder(chosen);
    setExamIndex(0);
    setExamAnswers([]);
    setShowAnswer(false);
    setMode("exam");
  }

  function currentExamQ() {
    return examOrder[examIndex] || null;
  }

  function answerExam(correct: boolean) {
    const q = currentExamQ();
    if (!q) return;

    logAttempt(q, correct);
    setExamAnswers((prev) => [...prev, { qid: q.id, correct }]);

    const nextIndex = examIndex + 1;
    if (nextIndex >= examOrder.length) {
      setMode("examResult");
      return;
    }
    setExamIndex(nextIndex);
    setShowAnswer(false);
  }

  const examScore = useMemo(() => {
    if (!examAnswers.length) return { correct: 0, total: examOrder.length, pct: 0 };
    const c = examAnswers.filter(a => a.correct).length;
    const t = examOrder.length;
    return { correct: c, total: t, pct: t ? Math.round((c / t) * 100) : 0 };
  }, [examAnswers, examOrder.length]);

  const missedInExam = useMemo(() => {
    const missedIds = new Set(examAnswers.filter(a => !a.correct).map(a => a.qid));
    return examOrder.filter(q => missedIds.has(q.id));
  }, [examAnswers, examOrder]);

  return (
    <div className="wrap">
      <header className="header">
        <div className="titleBlock">
          <div className="h1">ITF Taekwon-Do Theory Mock Test</div>
          <div className="sub">Practice honestly. Then use Exam Mode to pressure-test recall.</div>
          <div className="dojoMark">
            <span className="badge">1st → 2nd Dan prep</span>
            <span className="badge">ITF • patterns • theory • terminology</span>
          </div>
        </div>

        <div className="topStats">
          <div className="pill">
            <div className="pillLabel">Accuracy</div>
            <div className="pillValue">{stats.accuracy}%</div>
          </div>
          <div className="pill">
            <div className="pillLabel">Attempts</div>
            <div className="pillValue">{stats.total}</div>
          </div>
          <div className="pill">
            <div className="pillLabel">Today</div>
            <div className="pillValue">
              {todayCount}/{settings.dailyGoal} ({goalPct}%)
            </div>
          </div>
        </div>
      </header>

      <main className="main">
        <section className="card">
          <div className="cardHeader">
            <div className="cardTitle">
              {mode === "practice" && "Practice"}
              {mode === "exam" && `Exam Mode • Q${examIndex + 1}/${examOrder.length}`}
              {mode === "examResult" && "Exam Results"}
            </div>

            <div className="cardActions">
              <button className="btn ghost" onClick={() => setSettings({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}>
                {settings.theme === "dark" ? "Light mode" : "Dark mode"}
              </button>

              {mode !== "exam" && (
                <button className="btn primary" onClick={startExam}>
                  Start exam ({settings.testLength})
                </button>
              )}

              {mode === "practice" && (
                <>
                  <button className="btn" onClick={newPracticeQuestion}>New question</button>
                  <button className="btn" onClick={() => setShowAnswer((v) => !v)}>
                    {showAnswer ? "Hide model answer" : "Reveal model answer"}
                  </button>
                </>
              )}

              {mode === "examResult" && (
                <button className="btn" onClick={() => setMode("practice")}>
                  Back to practice
                </button>
              )}
            </div>
          </div>

          {mode === "practice" && (
            <>
              {!current ? (
                <div className="hint">Tap “New question” to begin.</div>
              ) : (
                <>
                  <div className="qPrompt">{current.prompt}</div>

                  <div className="controlsRow">
                    <button className="btn success" onClick={() => scorePractice(true)}>✓ Correct</button>
                    <button className="btn danger" onClick={() => scorePractice(false)}>✗ Incorrect</button>
                  </div>

                  {showAnswer && (
                    <div className="answerBox">
                      <div className="answerTitle">Model answer</div>
                      <div className="answerText">{current.modelAnswer}</div>
                      {current.sourceNote && <div className="answerMeta">Source: {current.sourceNote}</div>}
                    </div>
                  )}

                  <div className="tagRow">
                    {(current.tags || []).map((t) => (
                      <span key={t} className="tag">{t}</span>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {mode === "exam" && (
            <>
              {currentExamQ() ? (
                <>
                  <div className="qPrompt">{currentExamQ()!.prompt}</div>

                  <div className="controlsRow">
                    <button className="btn" onClick={() => setShowAnswer((v) => !v)}>
                      {showAnswer ? "Hide model answer" : "Reveal model answer"}
                    </button>
                    <button className="btn success" onClick={() => answerExam(true)}>✓ I got it right</button>
                    <button className="btn danger" onClick={() => answerExam(false)}>✗ I missed it</button>
                  </div>

                  {showAnswer && (
                    <div className="answerBox">
                      <div className="answerTitle">Model answer</div>
                      <div className="answerText">{currentExamQ()!.modelAnswer}</div>
                      {currentExamQ()!.sourceNote && <div className="answerMeta">Source: {currentExamQ()!.sourceNote}</div>}
                    </div>
                  )}

                  <div className="hint">Be strict: only mark “right” if you could say it cleanly without prompting.</div>
                </>
              ) : (
                <div className="hint">Preparing exam…</div>
              )}
            </>
          )}

          {mode === "examResult" && (
            <>
              <div className="kpiRow">
                <div className="kpi">
                  <div className="k">Score</div>
                  <div className="v">{examScore.correct}/{examScore.total}</div>
                </div>
                <div className="kpi">
                  <div className="k">Percentage</div>
                  <div className="v">{examScore.pct}%</div>
                </div>
                <div className="kpi">
                  <div className="k">Missed</div>
                  <div className="v">{examScore.total - examScore.correct}</div>
                </div>
              </div>

              <div className="hr"></div>

              {missedInExam.length ? (
                <>
                  <div className="label">Review the ones you missed</div>
                  {missedInExam.map((q) => (
                    <div key={q.id} style={{ marginBottom: 12 }}>
                      <div className="qPrompt" style={{ fontSize: 15 }}>{q.prompt}</div>
                      <div className="answerBox" style={{ marginTop: 6 }}>
                        <div className="answerTitle">Model answer</div>
                        <div className="answerText">{q.modelAnswer}</div>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="label">Clean sheet. Nice.</div>
              )}
            </>
          )}
        </section>

        <section className="card">
          <div className="cardHeader">
            <div className="cardTitle">Study tools</div>
          </div>

          <div className="block">
            <div className="label">Tags (optional)</div>
            <div className="tagPicker">
              {allTags.map((t) => {
                const active = filters.tags.has(t);
                return (
                  <button key={t} className={"chip" + (active ? " active" : "")} onClick={() => toggleTag(t)}>
                    {t}
                  </button>
                );
              })}
            </div>
            <div className="hint">No tags selected = all questions. Exam mode uses the same filter.</div>
          </div>

          <div className="block">
            <div className="label">Weak areas</div>

            <div className="hint">Based on your history. Needs a few attempts per area to be meaningful.</div>

            <div className="hr"></div>

            <div className="label" style={{ fontSize: 13 }}>Weakest tags</div>
            {weakestTags.length ? (
              <table className="smallTable">
                <thead>
                  <tr><th>Tag</th><th>Acc</th><th>Attempts</th></tr>
                </thead>
                <tbody>
                  {weakestTags.map(r => (
                    <tr key={r.tag}>
                      <td>{r.tag}</td>
                      <td>{r.acc}%</td>
                      <td>{r.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hint">Do a few rounds first; this list appears after ~3 attempts per tag.</div>
            )}

            <div className="hr"></div>

            <div className="label" style={{ fontSize: 13 }}>Weakest questions</div>
            {weakestQuestions.length ? (
              <table className="smallTable">
                <thead>
                  <tr><th>Question</th><th>Acc</th><th>Attempts</th></tr>
                </thead>
                <tbody>
                  {weakestQuestions.map(r => (
                    <tr key={r.qid}>
                      <td>{r.prompt}</td>
                      <td>{r.acc}%</td>
                      <td>{r.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hint">This list appears after ~2 attempts per question.</div>
            )}
          </div>

          <div className="block">
            <div className="label">Reminders & notifications</div>
            <div className="row">
              <label className="badge" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.reminderEnabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    if (enabled) {
                      const ok = await (async () => {
                        if (!("Notification" in window)) return false;
                        const perm = await Notification.requestPermission();
                        return perm === "granted";
                      })();
                      if (!ok) return;
                    }
                    setSettings({ ...settings, reminderEnabled: enabled });
                  }}
                />
                <span style={{ marginLeft: 8 }}>Enable reminders</span>
              </label>

              <button
                className="btn"
                onClick={async () => {
                  if (!("Notification" in window)) return;
                  const perm = await Notification.requestPermission();
                  if (perm === "granted") {
                    try { new Notification("ITF Theory Mock Test", { body: settings.reminderMessage }); } catch {}
                  }
                }}
              >
                Test notification
              </button>
            </div>

            <div className="row">
              <label className="field">
                <span>Time</span>
                <input type="time" value={settings.reminderTime} onChange={(e) => setSettings({ ...settings, reminderTime: e.target.value })} />
              </label>

              <label className="field">
                <span>Daily goal</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={settings.dailyGoal}
                  onChange={(e) => setSettings({ ...settings, dailyGoal: clamp(parseInt(e.target.value || "10", 10), 1, 200) })}
                />
              </label>

              <label className="field">
                <span>Exam length</span>
                <input
                  type="number"
                  min={5}
                  max={50}
                  value={settings.testLength}
                  onChange={(e) => setSettings({ ...settings, testLength: clamp(parseInt(e.target.value || "10", 10), 5, 50) })}
                />
              </label>
            </div>

            <div className="label" style={{ fontSize: 12, color: "var(--muted)", marginTop: 10 }}>Days</div>
            <div className="row wrapRow">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const active = settings.reminderDays.includes(d);
                return (
                  <button
                    key={d}
                    className={"chip" + (active ? " active" : "")}
                    onClick={() => {
                      const set = new Set(settings.reminderDays);
                      if (set.has(d)) set.delete(d);
                      else set.add(d);
                      setSettings({ ...settings, reminderDays: Array.from(set) });
                    }}
                  >
                    {dayName(d)}
                  </button>
                );
              })}
            </div>

            <label className="field full">
              <span>Message</span>
              <input type="text" value={settings.reminderMessage} onChange={(e) => setSettings({ ...settings, reminderMessage: e.target.value })} />
            </label>

            <div className="hint">Android notifications can be throttled by battery optimisation; your ChatGPT reminder remains the reliable backstop.</div>
          </div>

          <div className="block">
            <div className="label">Question bank</div>
            <div className="row">
              <button className="btn" onClick={openEditor}>Edit / paste JSON</button>
              <button className="btn" onClick={exportBank}>Export JSON</button>
            </div>
          </div>
        </section>
      </main>

      {editorOpen && (
        <div className="modalBackdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Edit question bank (JSON)</div>
              <button className="btn" onClick={() => setEditorOpen(false)}>Close</button>
            </div>
            <textarea className="editor" value={editorText} onChange={(e) => setEditorText(e.target.value)} spellCheck={false} />
            <div className="modalFooter">
              <button className="btn" onClick={() => setEditorOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={saveEditor}>Save bank</button>
            </div>
            <div className="hint">Each entry needs: id, prompt, modelAnswer. Optional: tags, sourceNote.</div>
          </div>
        </div>
      )}

      <footer className="footer">Dojo tip: in Exam Mode, only mark “right” if you could answer cleanly, first time.</footer>
    </div>
  );
}
