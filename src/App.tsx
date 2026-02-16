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
};

const LS_KEYS = {
  BANK: "itf_bank_v1",
  HISTORY: "itf_history_v1",
  SETTINGS: "itf_settings_v1",
} as const;

const DEFAULT_SETTINGS: Settings = {
  reminderEnabled: false,
  reminderTime: "19:30",
  reminderDays: [1, 2, 3, 4, 5, 6, 0],
  reminderMessage: "It’s time for your Taekwon-Do theory mock test.",
  dailyGoal: 10,
  testLength: 10,
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

// Seeded from your sheets; you can add more via Edit/paste JSON in the app.
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
    modelAnswer:
      "The International Taekwon-Do Federation (ITF) was founded in 1966 by General Choi Hong Hi.",
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
  const byId: Record<string, { attempts: number; correct: number; incorrect: number }> = {};

  for (const h of history) {
    byId[h.qid] ??= { attempts: 0, correct: 0, incorrect: 0 };
    byId[h.qid].attempts += 1;
    if (h.correct) byId[h.qid].correct += 1;
    else byId[h.qid].incorrect += 1;
  }

  return {
    total,
    correct,
    incorrect,
    accuracy: total ? Math.round((correct / total) * 100) : 0,
    byId,
  };
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

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const q of bank) (q.tags || []).forEach((t) => s.add(t));
    return Array.from(s).sort();
  }, [bank]);

  const pool = useMemo(() => {
    if (!filters.tags.size) return bank;
    return bank.filter((q) => (q.tags || []).some((t) => filters.tags.has(t)));
  }, [bank, filters.tags]);

  function newQuestion() {
    const q = pickQuestion(pool);
    setCurrent(q);
    setShowAnswer(false);
  }

  function scoreCurrent(correct: boolean) {
    if (!current) return;
    const entry: HistoryEntry = {
      id: uid(),
      qid: current.id,
      correct,
      at: new Date().toISOString(),
      tags: current.tags || [],
    };
    const nextHistory = [entry, ...history].slice(0, 5000);
    setHistory(nextHistory);
    saveJSON(LS_KEYS.HISTORY, nextHistory);
    newQuestion();
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
    if (!current) newQuestion();
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

  return (
    <div className="wrap">
      <header className="header">
        <div className="title">
          <div className="h1">ITF Taekwon-Do Theory Mock Test</div>
          <div className="sub">Self-assess (Correct/Incorrect), track accuracy, and use reminders.</div>
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
        <section className="card left">
          <div className="cardHeader">
            <div className="cardTitle">Mock test</div>
            <div className="cardActions">
              <button className="btn" onClick={newQuestion}>
                New question
              </button>
              <button className="btn" onClick={() => setShowAnswer((v) => !v)}>
                {showAnswer ? "Hide model answer" : "Reveal model answer"}
              </button>
            </div>
          </div>

          {!current ? (
            <div className="empty">Tap “New question” to begin.</div>
          ) : (
            <>
              <div className="qPrompt">{current.prompt}</div>

              <div className="controlsRow">
                <button className="btn success" onClick={() => scoreCurrent(true)}>
                  ✓ Correct
                </button>
                <button className="btn danger" onClick={() => scoreCurrent(false)}>
                  ✗ Incorrect
                </button>
              </div>

              {showAnswer && (
                <div className="answerBox">
                  <div className="answerTitle">Model answer</div>
                  <div className="answerText">{current.modelAnswer}</div>
                  {current.sourceNote && <div className="answerMeta">Source: {current.sourceNote}</div>}
                </div>
              )}

              <div className="metaRow">
                <div className="tagRow">
                  {(current.tags || []).map((t) => (
                    <span key={t} className="tag">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>

        <section className="card right">
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
            <div className="hint">No tags selected = all questions.</div>
          </div>

          <div className="block">
            <div className="label">Reminders & notifications</div>
            <div className="row">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.reminderEnabled}
                  onChange={async (e) => {
                    const enabled = e.target.checked;
                    if (enabled) {
                      const ok = await requestNotifications();
                      if (!ok) return;
                    }
                    setSettings({ ...settings, reminderEnabled: enabled });
                  }}
                />
                <span>Enable reminders</span>
              </label>

              <button
                className="btn"
                onClick={async () => {
                  const ok = await requestNotifications();
                  if (ok) fireReminderNotification();
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
            </div>

            <div className="label small">Days</div>
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

            <div className="hint">Android notifications depend on browser/app state. Your ChatGPT reminder is the reliable backstop.</div>
          </div>

          <div className="block">
            <div className="label">Question bank</div>
            <div className="row">
              <button className="btn" onClick={openEditor}>
                Edit / paste JSON
              </button>
              <button className="btn" onClick={exportBank}>
                Export JSON
              </button>
            </div>
          </div>
        </section>
      </main>

      {editorOpen && (
        <div className="modalBackdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalHeader">
              <div className="modalTitle">Edit question bank (JSON)</div>
              <button className="btn" onClick={() => setEditorOpen(false)}>
                Close
              </button>
            </div>
            <textarea className="editor" value={editorText} onChange={(e) => setEditorText(e.target.value)} spellCheck={false} />
            <div className="modalFooter">
              <button className="btn" onClick={() => setEditorOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={saveEditor}>
                Save bank
              </button>
            </div>
            <div className="hint">Each entry needs: id, prompt, modelAnswer. Optional: tags, sourceNote.</div>
          </div>
        </div>
      )}

      <footer className="footer">Tip: Reveal model answer, then mark Correct/Incorrect honestly.</footer>
    </div>
  );
}

