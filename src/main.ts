import "./style.css";
import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { collection, doc, getDocs, getFirestore, setDoc, writeBatch } from "firebase/firestore";

type PayFrequency = "Monthly" | "Semi-monthly" | "Biweekly" | "Weekly";
type StatutoryDeductions = {
  sss: number;
  philHealth: number;
  pagIbig: number;
  withholdingTax: number;
};
type EmployerContributions = {
  sss: number;
  sssEc: number;
  philHealth: number;
  pagIbig: number;
};
type PayrollCoverage = {
  sssCovered?: boolean;
  philHealthCovered?: boolean;
  pagIbigCovered?: boolean;
  withholdingTaxEnabled?: boolean;
};
type Employee = PayrollCoverage & {
  id: string;
  name: string;
  role: string;
  department: string;
  email: string;
  phone: string;
  type: "Monthly" | "Hourly";
  monthlySalary: number;
  hourlyRate: number;
  fixedDeduction: number;
  status: "Active" | "Inactive";
  createdAt: string;
};
type PayLine = PayrollCoverage & {
  employeeId: string;
  employeeName: string;
  role: string;
  payType: Employee["type"];
  rate: number;
  hours: number;
  earnings: number;
  deductions: number;
  statutoryDeductions?: StatutoryDeductions;
  employerContributions?: EmployerContributions;
  otherDeductions?: number;
};
type PayRun = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  payDate: string;
  frequency: PayFrequency;
  status: "Draft" | "Paid";
  lines: PayLine[];
  createdAt: string;
};
type EmployeeHistoryChange = { field: string; previous: string; current: string };
type EmployeeHistoryEntry = {
  id: string;
  employeeId: string;
  employeeName: string;
  action: "Added" | "Updated" | "Status changed" | "Deleted";
  changes: EmployeeHistoryChange[];
  createdAt: string;
};
type PayrollSchedule = { frequency: PayFrequency; startDate: string };
type Data = {
  employees: Employee[];
  payRuns: PayRun[];
  employeeHistory: EmployeeHistoryEntry[];
  payrollSchedule: PayrollSchedule | null;
  companyName: string;
};
type Route = "Overview" | "Employees" | "Employee history" | "Calendar" | "Payroll" | "Settings";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const firebaseReady = Object.values(firebaseConfig).every(Boolean);
const app = firebaseReady ? initializeApp(firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;
const storageKey = "pisopilot-payroll-v1";
const themeStorageKey = "pisopilot-theme";
const emptyData: Data = {
  employees: [],
  payRuns: [],
  employeeHistory: [],
  payrollSchedule: null,
  companyName: "Your company",
};
let data: Data = loadLocalData();
let theme: "light" | "dark" = loadTheme();
let route: Route = "Overview";
let activeUser: User | null = null;
let cloudLoadFailed = false;
let selectedRunId: string | null = null;
let search = "";
let busy = false;
let calendarMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

document.documentElement.dataset.theme = theme;

function loadTheme(): "light" | "dark" {
  try {
    return localStorage.getItem(themeStorageKey) === "dark" ? "dark" : "light";
  } catch (error) {
    console.error("Could not read the saved theme preference.", error);
    return "light";
  }
}

function themeToggleMarkup(): string {
  const nextTheme = theme === "light" ? "dark" : "light";
  const icon = theme === "light" ? "☾" : "☀";
  return `<button class="theme-toggle" data-action="toggle-theme" type="button" aria-label="Switch to ${nextTheme} mode" aria-pressed="${theme === "dark"}" title="Switch to ${nextTheme} mode"><span aria-hidden="true">${icon}</span></button>`;
}

function loadLocalData(): Data {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return structuredClone(emptyData);
    const parsed = JSON.parse(raw) as Partial<Data>;
    return {
      employees: Array.isArray(parsed.employees) ? parsed.employees : [],
      payRuns: Array.isArray(parsed.payRuns) ? parsed.payRuns : [],
      employeeHistory: Array.isArray(parsed.employeeHistory) ? parsed.employeeHistory : [],
      payrollSchedule: parsePayrollSchedule(parsed.payrollSchedule),
      companyName: typeof parsed.companyName === "string" ? parsed.companyName : emptyData.companyName,
    };
  } catch (error) {
    console.error("Could not read saved payroll data.", error);
    return structuredClone(emptyData);
  }
}

async function loadUserData(user: User): Promise<Data> {
  if (!db) return loadLocalData();
  const [employees, payRuns, employeeHistory, settings] = await Promise.all([
    getDocs(collection(db, "payrollData", user.uid, "employees")),
    getDocs(collection(db, "payrollData", user.uid, "payRuns")),
    getDocs(collection(db, "payrollData", user.uid, "employeeHistory")),
    getDocs(collection(db, "payrollData", user.uid, "settings")),
  ]);
  const profile = settings.docs.find((item) => item.id === "profile");
  const profileData = profile?.data();
  const companyName = profileData?.companyName;
  return {
    employees: employees.docs.map((item) => item.data() as Employee),
    payRuns: payRuns.docs.map((item) => item.data() as PayRun),
    employeeHistory: employeeHistory.docs.map((item) => item.data() as EmployeeHistoryEntry),
    payrollSchedule: parsePayrollSchedule(profileData?.payrollSchedule),
    companyName: typeof companyName === "string" ? companyName : emptyData.companyName,
  };
}

async function persist(): Promise<void> {
  if (activeUser && db) {
    const root = `payrollData/${activeUser.uid}`;
    const groups: Array<{ name: "employees" | "payRuns" | "employeeHistory"; records: Array<Employee | PayRun | EmployeeHistoryEntry> }> = [
      { name: "employees", records: data.employees },
      { name: "payRuns", records: data.payRuns },
      { name: "employeeHistory", records: data.employeeHistory },
    ];
    for (const group of groups) {
      const path = collection(db, root, group.name);
      const existing = await getDocs(path);
      const currentIds = new Set(group.records.map((record) => record.id));
      const operations: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
      for (const record of group.records) operations.push((batch) => batch.set(doc(path, record.id), record));
      for (const oldDoc of existing.docs) {
        if (!currentIds.has(oldDoc.id)) operations.push((batch) => batch.delete(oldDoc.ref));
      }
      for (let index = 0; index < operations.length; index += 450) {
        const batch = writeBatch(db);
        operations.slice(index, index + 450).forEach((operation) => operation(batch));
        await batch.commit();
      }
    }
    await setDoc(doc(db, root, "settings", "profile"), {
      companyName: data.companyName,
      payrollSchedule: data.payrollSchedule,
    });
  } else {
    localStorage.setItem(storageKey, JSON.stringify(data));
  }
}

const appRoot = document.querySelector<HTMLDivElement>("#app")!;
const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const money = (value: number): string =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(value || 0);
const initials = (name: string): string =>
  name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
const dateLabel = (date: string): string =>
  date ? new Date(`${date}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "—";
const dateTimeLabel = (date: string): string =>
  new Date(date).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
function isPayFrequency(value: unknown): value is PayFrequency {
  return value === "Monthly" || value === "Semi-monthly" || value === "Biweekly" || value === "Weekly";
}
function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function parsePayrollSchedule(value: unknown): PayrollSchedule | null {
  if (typeof value !== "object" || value === null || !("frequency" in value) || !("startDate" in value)) return null;
  const schedule = value as { frequency: unknown; startDate: unknown };
  return isPayFrequency(schedule.frequency) && isDateOnly(schedule.startDate)
    ? { frequency: schedule.frequency, startDate: schedule.startDate }
    : null;
}
const frequencyFactor: Record<PayFrequency, number> = {
  Monthly: 1,
  "Semi-monthly": 0.5,
  Biweekly: 12 / 26,
  Weekly: 12 / 52,
};
const zeroStatutoryDeductions: StatutoryDeductions = { sss: 0, philHealth: 0, pagIbig: 0, withholdingTax: 0 };
const zeroEmployerContributions: EmployerContributions = { sss: 0, sssEc: 0, philHealth: 0, pagIbig: 0 };

function calculateIncomeTax(annualTaxableIncome: number): number {
  if (annualTaxableIncome <= 250_000) return 0;
  if (annualTaxableIncome <= 400_000) return (annualTaxableIncome - 250_000) * 0.15;
  if (annualTaxableIncome <= 800_000) return 22_500 + (annualTaxableIncome - 400_000) * 0.2;
  if (annualTaxableIncome <= 2_000_000) return 102_500 + (annualTaxableIncome - 800_000) * 0.25;
  if (annualTaxableIncome <= 8_000_000) return 402_500 + (annualTaxableIncome - 2_000_000) * 0.3;
  return 2_202_500 + (annualTaxableIncome - 8_000_000) * 0.35;
}

function calculateStatutoryDeductions(
  earnings: number,
  frequency: PayFrequency,
  coverage: PayrollCoverage,
): { employee: StatutoryDeductions; employer: EmployerContributions } {
  if (earnings <= 0) {
    return { employee: { ...zeroStatutoryDeductions }, employer: { ...zeroEmployerContributions } };
  }

  const factor = frequencyFactor[frequency];
  const monthlyCompensation = earnings / factor;
  const monthlySssCredit = Math.min(35_000, Math.max(5_000, Math.round(monthlyCompensation / 500) * 500));
  const sssEmployeeMonthly = coverage.sssCovered === false ? 0 : monthlySssCredit * 0.05;
  const sssEmployerMonthly = coverage.sssCovered === false ? 0 : monthlySssCredit * 0.1;
  const sssEcMonthly = coverage.sssCovered === false ? 0 : monthlySssCredit < 15_000 ? 10 : 30;
  const philHealthBase = Math.min(100_000, Math.max(10_000, monthlyCompensation));
  const philHealthEmployeeMonthly = coverage.philHealthCovered === false ? 0 : philHealthBase * 0.025;
  const philHealthEmployerMonthly = coverage.philHealthCovered === false ? 0 : philHealthBase * 0.025;
  const pagIbigBase = Math.min(10_000, monthlyCompensation);
  const pagIbigEmployeeMonthly = coverage.pagIbigCovered === false
    ? 0
    : pagIbigBase * (monthlyCompensation <= 1_500 ? 0.01 : 0.02);
  const pagIbigEmployerMonthly = coverage.pagIbigCovered === false ? 0 : pagIbigBase * 0.02;
  const taxableMonthlyCompensation = Math.max(
    0,
    monthlyCompensation - sssEmployeeMonthly - philHealthEmployeeMonthly - pagIbigEmployeeMonthly,
  );
  const employee: StatutoryDeductions = {
    sss: round(sssEmployeeMonthly * factor),
    philHealth: round(philHealthEmployeeMonthly * factor),
    pagIbig: round(pagIbigEmployeeMonthly * factor),
    withholdingTax: coverage.withholdingTaxEnabled === false
      ? 0
      : round((calculateIncomeTax(taxableMonthlyCompensation * 12) / 12) * factor),
  };
  const employer: EmployerContributions = {
    sss: round(sssEmployerMonthly * factor),
    sssEc: round(sssEcMonthly * factor),
    philHealth: round(philHealthEmployerMonthly * factor),
    pagIbig: round(pagIbigEmployerMonthly * factor),
  };
  return { employee, employer };
}

function sumStatutoryDeductions(deductions: StatutoryDeductions): number {
  return round(deductions.sss + deductions.philHealth + deductions.pagIbig + deductions.withholdingTax);
}
function sumEmployerContributions(contributions: EmployerContributions): number {
  return round(contributions.sss + contributions.sssEc + contributions.philHealth + contributions.pagIbig);
}
function lineStatutoryDeductions(line: PayLine): StatutoryDeductions {
  return line.statutoryDeductions ?? { ...zeroStatutoryDeductions };
}
function lineOtherDeductions(line: PayLine): number {
  return line.otherDeductions ?? Math.max(0, line.deductions - sumStatutoryDeductions(lineStatutoryDeductions(line)));
}
function deductionBreakdown(line: PayLine): string {
  const statutory = lineStatutoryDeductions(line);
  return `SSS ${money(statutory.sss)} · PhilHealth ${money(statutory.philHealth)} · Pag-IBIG ${money(statutory.pagIbig)} · Tax ${money(statutory.withholdingTax)} · Other ${money(lineOtherDeductions(line))}`;
}
function employeeAuditChanges(before: Employee | undefined, after: Employee): EmployeeHistoryChange[] {
  const changes: EmployeeHistoryChange[] = [];
  const compare = (field: string, previous: string, current: string): void => {
    if (previous !== current) changes.push({ field, previous: previous || "—", current: current || "—" });
  };
  compare("Name", before?.name ?? "", after.name);
  compare("Job title", before?.role ?? "", after.role);
  compare("Department", before?.department ?? "", after.department);
  const payBasis = (employee: Employee | undefined): string => {
    if (!employee) return "";
    return employee.type === "Monthly"
      ? `Monthly · ${money(employee.monthlySalary)}`
      : `Hourly · ${money(employee.hourlyRate)}`;
  };
  compare("Pay basis / rate", payBasis(before), payBasis(after));
  compare("Fixed monthly deductions", before ? money(before.fixedDeduction) : "", money(after.fixedDeduction));
  compare("SSS coverage", before ? (before.sssCovered === false ? "Excluded" : "Included") : "", after.sssCovered === false ? "Excluded" : "Included");
  compare("PhilHealth coverage", before ? (before.philHealthCovered === false ? "Excluded" : "Included") : "", after.philHealthCovered === false ? "Excluded" : "Included");
  compare("Pag-IBIG coverage", before ? (before.pagIbigCovered === false ? "Excluded" : "Included") : "", after.pagIbigCovered === false ? "Excluded" : "Included");
  compare("Withholding tax", before ? (before.withholdingTaxEnabled === false ? "Excluded" : "Included") : "", after.withholdingTaxEnabled === false ? "Excluded" : "Included");
  compare("Employment status", before?.status ?? "", after.status);
  if (before && (before.email !== after.email || before.phone !== after.phone)) {
    changes.push({ field: "Contact information", previous: "Previous details", current: "Updated details" });
  }
  return changes;
}
function recordEmployeeHistory(
  employeeId: string,
  employeeName: string,
  action: EmployeeHistoryEntry["action"],
  changes: EmployeeHistoryChange[],
): void {
  data.employeeHistory.unshift({
    id: crypto.randomUUID(),
    employeeId,
    employeeName,
    action,
    changes,
    createdAt: new Date().toISOString(),
  });
}
function toast(message: string, error = false): void {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.textContent = message;
  document.body.append(el);
  window.setTimeout(() => el.remove(), 3500);
}
async function saveAndRender(message: string): Promise<void> {
  try {
    await persist();
    render();
    toast(message);
  } catch (error) {
    console.error("Could not save payroll data.", error);
    toast("Could not save changes. Check your connection and Firebase permissions.", true);
  }
}
function setBusy(next: boolean): void {
  busy = next;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    if (button.dataset.noBusy !== "true") button.disabled = next;
  });
}

function render(): void {
  if (firebaseReady && activeUser && cloudLoadFailed) {
    renderCloudError();
    return;
  }
  if (firebaseReady && !activeUser) {
    renderAuth();
    return;
  }
  appRoot.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#" data-route="Overview"><span class="brand-mark">P</span><span><b>PisoPilot</b><small>PAYROLL</small></span></a>
        <div class="workspace-label">WORKSPACE</div>
        <div class="workspace-card"><span class="workspace-icon">⌂</span><span><b>${esc(data.companyName)}</b><small>${firebaseReady ? "Cloud workspace" : "Local demo workspace"}</small></span><span class="chevron">⌄</span></div>
        <div class="nav-label">MENU</div>
        <nav class="navigation">${(["Overview", "Employees", "Employee history", "Calendar", "Payroll", "Settings"] as Route[]).map((item) =>
          `<button class="nav-item ${route === item ? "active" : ""}" data-route="${item}"><span class="nav-icon">${navIcon(item)}</span>${item}${item === "Payroll" ? `<span class="nav-count">${data.payRuns.length}</span>` : ""}</button>`
        ).join("")}</nav>
        <div class="sidebar-bottom">
          <div class="user-card"><span class="avatar user-avatar">${activeUser ? esc(initials(activeUser.email ?? "U")) : "D"}</span><span class="user-meta"><b>${activeUser ? esc(activeUser.email ?? "Account") : "Demo account"}</b><small>${firebaseReady ? "Secure sign-in" : "This browser only"}</small></span>${firebaseReady ? `<button class="icon-button" data-action="logout" aria-label="Sign out">↗</button>` : ""}</div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><div class="breadcrumbs">Workspace <span>/</span> <b>${route}</b></div><div class="topbar-right"><span class="local-pill"><i></i>${firebaseReady ? "FIREBASE CONNECTED" : "LOCAL DEMO MODE"}</span>${themeToggleMarkup()}<span class="top-date">${new Date().toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</span><span class="avatar top-avatar">${activeUser ? esc(initials(activeUser.email ?? "U")) : "D"}</span></div></header>
        <section class="page">${renderPage()}</section>
      </main>
      <div id="modal-root"></div>
    </div>`;
  bindEvents();
}

function navIcon(item: Route): string {
  const icons: Record<Route, string> = {
    Overview: "▦",
    Employees: "♙",
    "Employee history": "◷",
    Calendar: "▦",
    Payroll: "▤",
    Settings: "⚙",
  };
  return icons[item];
}

function renderPage(): string {
  if (route === "Employees") return renderEmployees();
  if (route === "Employee history") return renderEmployeeHistory();
  if (route === "Calendar") return renderCalendar();
  if (route === "Payroll") return renderPayroll();
  if (route === "Settings") return renderSettings();
  return renderOverview();
}

function renderOverview(): string {
  const active = data.employees.filter((employee) => employee.status === "Active").length;
  const latestRun = [...data.payRuns].sort((a, b) => b.payDate.localeCompare(a.payDate))[0];
  const lastPaid = [...data.payRuns].filter((run) => run.status === "Paid").sort((a, b) => b.payDate.localeCompare(a.payDate))[0];
  const payrollTotal = latestRun?.lines.reduce((sum, line) => sum + line.earnings, 0) ?? 0;
  const payoutTotal = latestRun?.lines.reduce((sum, line) => sum + line.earnings - line.deductions, 0) ?? 0;
  const recent = [...data.payRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return `
    <div class="page-heading"><div><div class="eyebrow">PAYROLL OVERVIEW</div><h1>Good ${greeting()}, ${activeUser ? esc((activeUser.email ?? "there").split("@")[0]) : "there"} <span class="wave">✳</span></h1><p>Here’s what’s happening with your team and payroll.</p></div><button class="button button-dark" data-action="new-run"><span>＋</span> Create pay run</button></div>
    ${!data.employees.length ? `<div class="welcome-banner"><div class="welcome-copy"><span class="banner-tag">YOUR PAYROLL, IN GOOD HANDS</span><h2>Let’s get your team<br>on the same page.</h2><p>Add your first employee to start managing pay runs and keeping payroll details in one place.</p><button class="button button-light" data-action="new-employee">Add your first employee <span>→</span></button></div><div class="welcome-art"><div class="art-card"><div class="art-head"><span>PAYROLL SUMMARY</span><span>•••</span></div><div class="art-total">₱ 84,250.00</div><div class="art-sub">Next payday <b>Nov 30</b></div><div class="art-chart"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="art-foot"><span>OCT 01</span><span>OCT 15</span><span>OCT 30</span></div></div><span class="art-orbit orbit-one"></span><span class="art-orbit orbit-two"></span><span class="art-star">✳</span></div></div>` : ""}
    <div class="stat-grid">
      ${statCard("TEAM MEMBERS", `${active}`, "Active employees", "♙", "mint")}
      ${statCard("LATEST GROSS PAYROLL", money(payrollTotal), latestRun ? latestRun.name : "No pay runs yet", "₱", "lilac")}
      ${statCard("LATEST TAKE-HOME", money(payoutTotal), latestRun ? `${latestRun.lines.length} people included` : "Ready when you are", "↗", "peach")}
      ${statCard("LAST PAID", lastPaid ? money(lastPaid.lines.reduce((sum, line) => sum + line.earnings - line.deductions, 0)) : "—", lastPaid ? dateLabel(lastPaid.payDate) : "No completed pay runs", "✓", "blue")}
    </div>
    <div class="content-grid">
      <section class="panel recent-panel"><div class="panel-heading"><div><h2>Recent pay runs</h2><p>A quick look at your latest payroll activity.</p></div><button class="text-button" data-route="Payroll">View all <span>→</span></button></div>
        ${recent.length ? `<div class="table-wrap"><table><thead><tr><th>PAY RUN</th><th>PAY DATE</th><th>PEOPLE</th><th>TAKE-HOME</th><th>STATUS</th></tr></thead><tbody>${recent.map((run) => `<tr data-run="${run.id}" class="click-row"><td><b>${esc(run.name)}</b><small>${dateLabel(run.startDate)} – ${dateLabel(run.endDate)}</small></td><td>${dateLabel(run.payDate)}</td><td>${run.lines.length} employees</td><td><b>${money(run.lines.reduce((sum, line) => sum + line.earnings - line.deductions, 0))}</b></td><td><span class="status ${run.status.toLowerCase()}">${run.status}</span></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline"><span class="empty-icon">▤</span><b>No pay runs yet</b><p>Your completed payroll runs will show up here.</p><button class="button button-outline" data-action="new-run">Create your first pay run</button></div>`}
      </section>
      <section class="panel team-panel"><div class="panel-heading"><div><h2>Your team</h2><p>Employees on your payroll.</p></div><button class="round-add" data-action="new-employee" aria-label="Add employee">＋</button></div>
        ${data.employees.length ? `<div class="team-list">${data.employees.slice(0, 5).map((employee) => `<div class="team-row"><span class="avatar ${avatarTone(employee.name)}">${esc(initials(employee.name))}</span><span class="team-info"><b>${esc(employee.name)}</b><small>${esc(employee.role || employee.department || "Team member")}</small></span><span class="team-pay">${money(employee.type === "Monthly" ? employee.monthlySalary : employee.hourlyRate)}<small>/${employee.type === "Monthly" ? "month" : "hour"}</small></span></div>`).join("")}</div><button class="text-button team-link" data-route="Employees">See all employees <span>→</span></button>` : `<div class="empty-team"><span>♙</span><b>Your team will appear here</b><p>Start by adding employee details.</p><button class="text-button" data-action="new-employee">Add an employee →</button></div>`}
      </section>
    </div>
    <div class="footnote"><span>₱</span> Amounts shown in Philippine pesos. Confirm statutory deductions and payroll requirements before paying employees.</div>`;
}
function statCard(label: string, value: string, foot: string, icon: string, tone: string): string {
  return `<div class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon ${tone}">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></div>`;
}
function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}
function avatarTone(name: string): string {
  return `tone-${(name.charCodeAt(0) || 0) % 5}`;
}

function renderEmployees(): string {
  const filtered = data.employees.filter((employee) => `${employee.name} ${employee.email} ${employee.role} ${employee.department}`.toLowerCase().includes(search.toLowerCase()));
  return `<div class="page-heading"><div><div class="eyebrow">YOUR PEOPLE</div><h1>Employees</h1><p>Manage your team’s details and pay information.</p></div><button class="button button-dark" data-action="new-employee"><span>＋</span> Add employee</button></div>
    <div class="toolbar"><div class="search-wrap"><span>⌕</span><input id="employee-search" type="search" placeholder="Search by name, role, or email" value="${esc(search)}"></div><span class="result-count">${filtered.length} ${filtered.length === 1 ? "employee" : "employees"}</span></div>
    <section class="panel employee-panel">${filtered.length ? `<div class="table-wrap"><table><thead><tr><th>EMPLOYEE</th><th>ROLE / DEPARTMENT</th><th>PAY BASIS</th><th>MONTHLY DEDUCTION</th><th>STATUS</th><th></th></tr></thead><tbody>${filtered.map((employee) => `<tr><td><div class="employee-cell"><span class="avatar ${avatarTone(employee.name)}">${esc(initials(employee.name))}</span><span><b>${esc(employee.name)}</b><small>${esc(employee.email || employee.phone || "No contact info")}</small></span></div></td><td><b>${esc(employee.role || "—")}</b><small>${esc(employee.department || "—")}</small></td><td><b>${money(employee.type === "Monthly" ? employee.monthlySalary : employee.hourlyRate)}</b><small>${employee.type === "Monthly" ? "per month" : "per hour"}</small></td><td>${money(employee.fixedDeduction)}<small>per month</small></td><td><span class="status ${employee.status.toLowerCase()}">${employee.status}</span></td><td><div class="row-actions"><button class="icon-button" data-action="edit-employee" data-id="${employee.id}" aria-label="Edit ${esc(employee.name)}">✎</button><button class="icon-button danger-hover" data-action="delete-employee" data-id="${employee.id}" aria-label="Delete ${esc(employee.name)}">⌫</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline"><span class="empty-icon">♙</span><b>${search ? "No matching employees" : "No employees added yet"}</b><p>${search ? "Try a different search." : "Add your people to start preparing payroll."}</p>${!search ? `<button class="button button-outline" data-action="new-employee">Add employee</button>` : ""}</div>`}</section>
    <div class="footnote"><span>₱</span> Employee pay details are private to your workspace. Fixed deductions are manually configured per employee.</div>`;
}

function renderPayroll(): string {
  const selected = data.payRuns.find((run) => run.id === selectedRunId);
  if (selected) return renderRunDetail(selected);
  const runs = [...data.payRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `<div class="page-heading"><div><div class="eyebrow">PAY CYCLES</div><h1>Payroll</h1><p>Prepare, review, and keep track of every pay run.</p></div><button class="button button-dark" data-action="new-run"><span>＋</span> Create pay run</button></div>
    <div class="payroll-summary"><div class="summary-label">TOTAL PAY RUNS <b>${runs.length}</b></div><div class="summary-label">DRAFTS <b>${runs.filter((run) => run.status === "Draft").length}</b></div><div class="summary-label">PAID RUNS <b>${runs.filter((run) => run.status === "Paid").length}</b></div><div class="summary-note">All amounts in <b>Philippine pesos (₱)</b></div></div>
    <section class="panel payroll-panel"><div class="panel-heading"><div><h2>Pay run history</h2><p>All pay runs, newest first.</p></div></div>
      ${runs.length ? `<div class="table-wrap"><table><thead><tr><th>PAY RUN</th><th>FREQUENCY</th><th>PAY DATE</th><th>EMPLOYEES</th><th>GROSS PAY</th><th>TAKE-HOME</th><th>STATUS</th><th></th></tr></thead><tbody>${runs.map((run) => `<tr><td><b>${esc(run.name)}</b><small>${dateLabel(run.startDate)} – ${dateLabel(run.endDate)}</small></td><td>${run.frequency}</td><td>${dateLabel(run.payDate)}</td><td>${run.lines.length}</td><td>${money(run.lines.reduce((sum, line) => sum + line.earnings, 0))}</td><td><b>${money(run.lines.reduce((sum, line) => sum + line.earnings - line.deductions, 0))}</b></td><td><span class="status ${run.status.toLowerCase()}">${run.status}</span></td><td><button class="text-button" data-action="open-run" data-id="${run.id}">Review →</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-inline"><span class="empty-icon">▤</span><b>No pay runs yet</b><p>Once created, your pay runs and their totals will appear here.</p><button class="button button-outline" data-action="new-run">Create pay run</button></div>`}
    </section>
    <div class="notice"><span>ⓘ</span><p><b>Review before payment.</b> Statutory amounts are standard estimates for regular wages. Check contribution eligibility, year-to-date income, benefits, and current agency rules; calculated employee amounts are editable per pay line.</p></div>`;
}

function renderRunDetail(run: PayRun): string {
  const gross = run.lines.reduce((sum, line) => sum + line.earnings, 0);
  const deductions = run.lines.reduce((sum, line) => sum + line.deductions, 0);
  const net = gross - deductions;
  return `<div class="page-heading"><div><button class="back-link" data-action="back-runs">← Back to pay runs</button><div class="eyebrow">PAY RUN DETAILS</div><h1>${esc(run.name)}</h1><p>${dateLabel(run.startDate)} – ${dateLabel(run.endDate)} <span class="dot-sep">·</span> Pay date ${dateLabel(run.payDate)}</p></div><div class="heading-actions"><button class="button button-outline" data-action="export-run" data-id="${run.id}">↓ Export CSV</button><button class="button button-dark" data-action="print-run" data-id="${run.id}">Print payslips</button></div></div>
    <div class="detail-stats">${statCard("GROSS PAY", money(gross), `${run.lines.length} employees`, "₱", "lilac")}${statCard("DEDUCTIONS", money(deductions), "Contributions, tax & other", "−", "peach")}${statCard("TOTAL TAKE-HOME", money(net), `Frequency: ${run.frequency}`, "↗", "mint")}</div>
    <section class="panel run-lines"><div class="panel-heading"><div><h2>Pay breakdown</h2><p>Government deductions are itemized; employer shares do not reduce take-home pay.</p></div><span class="status ${run.status.toLowerCase()}">${run.status}</span></div>
      ${run.lines.length ? `<div class="table-wrap"><table><thead><tr><th>EMPLOYEE</th><th>PAY BASIS</th><th>HOURS</th><th>EARNINGS</th><th>DEDUCTIONS</th><th>TAKE-HOME</th><th></th></tr></thead><tbody>${run.lines.map((line) => {
        const employer = line.employerContributions ?? zeroEmployerContributions;
        return `<tr><td><b>${esc(line.employeeName)}</b><small>${esc(line.role)}</small></td><td>${line.payType === "Monthly" ? `${money(line.rate)} / month` : `${money(line.rate)} / hour`}</td><td>${line.payType === "Hourly" ? `${line.hours} hrs` : "—"}</td><td>${money(line.earnings)}</td><td><b>${money(line.deductions)}</b><small class="deduction-breakdown">${deductionBreakdown(line)}</small><small class="employer-share-cell">Employer share (not deducted): ${money(sumEmployerContributions(employer))}</small></td><td><b>${money(line.earnings - line.deductions)}</b></td><td>${run.status === "Draft" ? `<button class="icon-button" data-action="edit-line" data-id="${line.employeeId}" aria-label="Edit ${esc(line.employeeName)}">✎</button>` : ""}</td></tr>`;
      }).join("")}</tbody></table></div>` : `<div class="empty-inline"><b>No active employees in this run</b><p>Add active employees before creating a pay run.</p></div>`}
    </section><div class="run-footer"><span>Created ${dateLabel(run.createdAt.slice(0, 10))} · ${run.status === "Paid" ? "This run has been marked paid." : "Save your adjustments before marking paid."}</span><div class="heading-actions">${run.status === "Draft" ? `<button class="button button-outline danger-button" data-action="delete-run" data-id="${run.id}">Delete draft</button><button class="button button-dark" data-action="mark-paid" data-id="${run.id}">Mark as paid <span>✓</span></button>` : ""}</div></div>`;
}

function renderSettings(): string {
  return `<div class="page-heading"><div><div class="eyebrow">WORKSPACE PREFERENCES</div><h1>Settings</h1><p>Update your organization details and data preferences.</p></div></div>
    <section class="panel settings-panel"><div class="settings-title"><span class="settings-icon">⌂</span><div><h2>Company profile</h2><p>This name appears in your workspace and payslips.</p></div></div><form id="company-form" class="settings-form"><label>Company name<input name="companyName" maxlength="80" required value="${esc(data.companyName)}" placeholder="e.g. Northstar Studio"></label><button class="button button-dark" type="submit">Save changes</button></form></section>
    <section class="panel settings-panel"><div class="settings-title"><span class="settings-icon">₱</span><div><h2>Currency & payroll</h2><p>Payroll amounts are displayed in Philippine pesos.</p></div></div><div class="settings-row"><span>Display currency</span><b>PHP — Philippine Peso (₱)</b></div><div class="settings-row"><span>Payroll calculations</span><b>Pay basis × frequency, less employee deductions</b></div></section>
    <section class="panel settings-panel"><div class="settings-title"><span class="settings-icon">▤</span><div><h2>Statutory payroll defaults</h2><p>Standard employee-side estimates used for new pay runs; amend per pay line when needed.</p></div></div>
      <div class="settings-row"><span>SSS</span><b>Employee 5% of salary credit (₱5,000–₱35,000); employer 10% + EC</b></div>
      <div class="settings-row"><span>PhilHealth</span><b>5% total, split equally; salary basis ₱10,000–₱100,000</b></div>
      <div class="settings-row"><span>Pag-IBIG</span><b>Employee 1% up to ₱1,500, otherwise 2%; employer 2%; fund salary capped at ₱10,000</b></div>
      <div class="settings-row"><span>Withholding tax</span><b>TRAIN graduated rates on regular taxable compensation</b></div>
      <div class="settings-sources"><a href="https://www.sss.gov.ph/sss-contribution-table/" target="_blank" rel="noreferrer">SSS schedule ↗</a><a href="https://www.philhealth.gov.ph/partners/employers/" target="_blank" rel="noreferrer">PhilHealth employer guidance ↗</a><a href="https://www.pagibigfund.gov.ph/" target="_blank" rel="noreferrer">Pag-IBIG ↗</a><a href="https://www.bir.gov.ph/" target="_blank" rel="noreferrer">BIR ↗</a></div>
    </section>
    <section class="panel settings-panel"><div class="settings-title"><span class="settings-icon">◈</span><div><h2>Data storage</h2><p>${firebaseReady ? "Your payroll records are stored in your Firebase account." : "Demo records are stored only in this browser."}</p></div></div><div class="storage-box ${firebaseReady ? "connected" : ""}"><span class="storage-dot"></span><div><b>${firebaseReady ? "Firebase Firestore connected" : "Local demo storage"}</b><p>${firebaseReady ? `Signed in as ${esc(activeUser?.email ?? "")}. Your data is isolated by account.` : "Add Firebase configuration to enable secure, account-based cloud storage. Do not use demo mode for real payroll data."}</p></div></div></section>
    <div class="notice"><span>ⓘ</span><p><b>Important:</b> These are regular-pay estimates, not a complete tax-compliance engine. Year-to-date annualization, tax-exempt benefits (including the ₱90,000 13th-month/other-benefits exemption), minimum-wage exemptions, special contribution cases, and agency schedule changes require payroll review and adjustment.</p></div>`;
}

function renderAuth(): void {
  appRoot.innerHTML = `<div class="auth-page">${themeToggleMarkup()}<div class="auth-brand"><span class="brand-mark">P</span><span><b>PisoPilot</b><small>PAYROLL</small></span></div><section class="auth-card"><div class="eyebrow">SECURE WORKSPACE</div><h1>Welcome back.</h1><p>Sign in to manage your team’s payroll.</p><div class="auth-tabs"><button class="auth-tab active" data-action="auth-mode" data-mode="signin">Sign in</button><button class="auth-tab" data-action="auth-mode" data-mode="signup">Create account</button></div><form id="auth-form"><label>Email address<input name="email" type="email" required autocomplete="email" placeholder="you@company.com"></label><label>Password<input name="password" type="password" minlength="6" required autocomplete="current-password" placeholder="At least 6 characters"></label><div class="auth-error" id="auth-error"></div><button class="button button-dark auth-submit" type="submit">Sign in <span>→</span></button></form><div class="auth-security">⌑ Your workspace is secured with Firebase Authentication.</div></section><div class="auth-foot">PisoPilot Payroll <span>·</span> Amounts in Philippine pesos (₱)</div></div>`;
  bindEvents();
}

function renderCloudError(): void {
  appRoot.innerHTML = `<div class="auth-page">${themeToggleMarkup()}<div class="auth-brand"><span class="brand-mark">P</span><span><b>PisoPilot</b><small>PAYROLL</small></span></div><section class="auth-card"><div class="eyebrow">CLOUD WORKSPACE</div><h1>Records unavailable.</h1><p>We couldn’t load this account’s Firestore data. Local demo data is not being shown or used.</p><div class="auth-error">Check your connection, Firebase setup, and Firestore rules.</div><button class="button button-dark auth-submit" data-action="cloud-retry">Retry connection</button><button class="text-button auth-signout" data-action="logout">Sign out</button></section></div>`;
  bindEvents();
}

function bindEvents(): void {
  document.querySelectorAll<HTMLElement>("[data-route]").forEach((el) => el.addEventListener("click", (event) => {
    event.preventDefault();
    route = el.dataset.route as Route;
    selectedRunId = null;
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => el.addEventListener("click", () => void handleAction(el)));
  document.querySelectorAll<HTMLElement>("[data-run]").forEach((el) => el.addEventListener("click", () => {
    selectedRunId = el.dataset.run ?? null;
    route = "Payroll";
    render();
  }));
  document.querySelector<HTMLInputElement>("#employee-search")?.addEventListener("input", (event) => {
    search = (event.target as HTMLInputElement).value;
    const cursor = search.length;
    render();
    const input = document.querySelector<HTMLInputElement>("#employee-search");
    input?.focus();
    input?.setSelectionRange(cursor, cursor);
  });
  document.querySelector<HTMLFormElement>("#company-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    data.companyName = String(form.get("companyName")).trim();
    void saveAndRender("Company details saved.");
  });
  document.querySelector<HTMLFormElement>("#schedule-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const frequency = String(values.get("frequency"));
    const startDate = String(values.get("startDate"));
    if (!isPayFrequency(frequency) || !isDateOnly(startDate)) {
      toast("Choose a valid payroll frequency and schedule date.", true);
      return;
    }
    data.payrollSchedule = { frequency, startDate };
    void saveAndRender("Calendar schedule saved. Future dates are forecasts only.");
  });
  document.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => void submitAuth(event));
}

async function handleAction(el: HTMLElement): Promise<void> {
  const action = el.dataset.action;
  const id = el.dataset.id;
  if (action === "toggle-theme") {
    theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(themeStorageKey, theme);
    } catch (error) {
      console.error("Could not save the theme preference.", error);
      toast("Theme changed, but this browser could not save your preference.", true);
    }
    const toggle = document.querySelector<HTMLButtonElement>('[data-action="toggle-theme"]');
    if (toggle) {
      const nextTheme = theme === "light" ? "dark" : "light";
      toggle.innerHTML = `<span aria-hidden="true">${theme === "light" ? "☾" : "☀"}</span>`;
      toggle.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
      toggle.setAttribute("aria-pressed", String(theme === "dark"));
      toggle.title = `Switch to ${nextTheme} mode`;
    }
    return;
  }
  if (action === "new-employee") showEmployeeForm();
  if (action === "edit-employee" && id) showEmployeeForm(data.employees.find((employee) => employee.id === id));
  if (action === "delete-employee" && id) await deleteEmployee(id);
  if (action === "new-run") showRunForm();
  if (action === "open-run" && id) { selectedRunId = id; render(); }
  if (action === "back-runs") { selectedRunId = null; render(); }
  if (action === "calendar-month") {
    const offset = Number(el.dataset.offset);
    if (offset === -1 || offset === 1) {
      calendarMonth = new Date(Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth() + offset, 1));
      render();
    }
  }
  if (action === "clear-schedule" && data.payrollSchedule) {
    data.payrollSchedule = null;
    void saveAndRender("Calendar forecast schedule cleared. Existing pay runs are unchanged.");
  }
  if (action === "edit-line" && id && selectedRunId) showLineForm(selectedRunId, id);
  if (action === "mark-paid" && id) await markPaid(id);
  if (action === "delete-run" && id) await deleteRun(id);
  if (action === "export-run" && id) exportRun(id);
  if (action === "print-run" && id) printRun(id);
  if (action === "logout" && auth) await signOut(auth);
  if (action === "cloud-retry" && activeUser) {
    setBusy(true);
    try {
      data = await loadUserData(activeUser);
      cloudLoadFailed = false;
      render();
    } catch (error) {
      console.error("Could not load cloud payroll records.", error);
      toast("Still unable to load your cloud records.", true);
    } finally {
      setBusy(false);
    }
  }
  if (action === "auth-mode") {
    document.querySelectorAll(".auth-tab").forEach((tab) => tab.classList.toggle("active", tab === el));
    const form = document.querySelector<HTMLFormElement>("#auth-form");
    const submit = form?.querySelector<HTMLButtonElement>(".auth-submit");
    const signup = el.dataset.mode === "signup";
    if (form) form.dataset.mode = signup ? "signup" : "signin";
    if (submit) submit.innerHTML = signup ? "Create account <span>→</span>" : "Sign in <span>→</span>";
    const password = form?.querySelector<HTMLInputElement>('[name="password"]');
    if (password) password.autocomplete = signup ? "new-password" : "current-password";
  }
}

function showModal(title: string, body: string, wide = false): HTMLDivElement {
  const root = document.querySelector<HTMLDivElement>("#modal-root")!;
  root.innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><div><h2 id="modal-title">${title}</h2></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">×</button></div>${body}</section></div>`;
  root.querySelector(".modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) root.innerHTML = "";
  });
  root.querySelector(".modal-close")?.addEventListener("click", () => root.innerHTML = "");
  return root;
}

function showEmployeeForm(employee?: Employee): void {
  const edit = Boolean(employee);
  const root = showModal(edit ? "Edit employee" : "Add an employee", `<p class="modal-intro">${edit ? "Update employee and pay details." : "Add a team member to your payroll workspace."}</p>
    <form id="employee-form" class="form-grid">
      <label class="full-span">Full name<input name="name" required maxlength="100" value="${esc(employee?.name ?? "")}" placeholder="e.g. Alex Santos"></label>
      <label>Job title<input name="role" maxlength="80" value="${esc(employee?.role ?? "")}" placeholder="e.g. Operations lead"></label>
      <label>Department<input name="department" maxlength="80" value="${esc(employee?.department ?? "")}" placeholder="e.g. Operations"></label>
      <label>Email address<input name="email" type="email" maxlength="120" value="${esc(employee?.email ?? "")}" placeholder="alex@company.com"></label>
      <label>Phone number<input name="phone" type="tel" maxlength="40" value="${esc(employee?.phone ?? "")}" placeholder="+63 9XX XXX XXXX"></label>
      <label>Pay basis<select name="type"><option ${employee?.type !== "Hourly" ? "selected" : ""}>Monthly</option><option ${employee?.type === "Hourly" ? "selected" : ""}>Hourly</option></select></label>
      <label id="monthly-field">Monthly salary (₱)<input name="monthlySalary" type="number" min="0" step="0.01" value="${employee?.monthlySalary ?? 0}"></label>
      <label id="hourly-field">Hourly rate (₱)<input name="hourlyRate" type="number" min="0" step="0.01" value="${employee?.hourlyRate ?? 0}"></label>
      <label>Fixed monthly deductions (₱)<input name="fixedDeduction" type="number" min="0" step="0.01" value="${employee?.fixedDeduction ?? 0}"><small>Enter any verified recurring deductions; leave 0 if none.</small></label>
      <div class="coverage-section full-span"><div><b>Payroll deductions</b><small>Selected items are calculated for each pay run. Confirm each employee’s eligibility.</small></div><div class="coverage-options">
        <label class="coverage-option"><input name="sssCovered" type="checkbox" ${employee?.sssCovered !== false ? "checked" : ""}> SSS</label>
        <label class="coverage-option"><input name="philHealthCovered" type="checkbox" ${employee?.philHealthCovered !== false ? "checked" : ""}> PhilHealth</label>
        <label class="coverage-option"><input name="pagIbigCovered" type="checkbox" ${employee?.pagIbigCovered !== false ? "checked" : ""}> Pag-IBIG</label>
        <label class="coverage-option"><input name="withholdingTaxEnabled" type="checkbox" ${employee?.withholdingTaxEnabled !== false ? "checked" : ""}> Withholding tax</label>
      </div></div>
      ${edit ? `<label>Employment status<select name="status"><option ${employee?.status === "Active" ? "selected" : ""}>Active</option><option ${employee?.status === "Inactive" ? "selected" : ""}>Inactive</option></select></label>` : ""}
      <div class="form-actions full-span"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-dark">${edit ? "Save employee" : "Add employee"}</button></div>
    </form>`);
  const form = root.querySelector<HTMLFormElement>("#employee-form")!;
  const typeSelect = form.elements.namedItem("type") as HTMLSelectElement;
  const updateBasis = (): void => {
    const hourly = typeSelect.value === "Hourly";
    root.querySelector("#monthly-field")?.classList.toggle("hidden-field", hourly);
    root.querySelector("#hourly-field")?.classList.toggle("hidden-field", !hourly);
  };
  typeSelect.addEventListener("change", updateBasis);
  updateBasis();
  root.querySelectorAll<HTMLElement>('[data-action="close-modal"]').forEach((button) => button.addEventListener("click", () => root.innerHTML = ""));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const payType = String(values.get("type")) as Employee["type"];
    const next: Employee = {
      id: employee?.id ?? crypto.randomUUID(),
      name: String(values.get("name")).trim(),
      role: String(values.get("role")).trim(),
      department: String(values.get("department")).trim(),
      email: String(values.get("email")).trim(),
      phone: String(values.get("phone")).trim(),
      type: payType,
      monthlySalary: payType === "Monthly" ? Number(values.get("monthlySalary")) : 0,
      hourlyRate: payType === "Hourly" ? Number(values.get("hourlyRate")) : 0,
      fixedDeduction: Number(values.get("fixedDeduction")),
      sssCovered: values.get("sssCovered") === "on",
      philHealthCovered: values.get("philHealthCovered") === "on",
      pagIbigCovered: values.get("pagIbigCovered") === "on",
      withholdingTaxEnabled: values.get("withholdingTaxEnabled") === "on",
      status: (String(values.get("status") ?? employee?.status ?? "Active")) as Employee["status"],
      createdAt: employee?.createdAt ?? new Date().toISOString(),
    };
    if (data.employees.some((item) => item.id !== next.id && item.email && item.email.toLowerCase() === next.email.toLowerCase())) {
      toast("An employee with that email already exists.", true);
      return;
    }
    const changes = employeeAuditChanges(employee, next);
    if (employee) {
      if (changes.length) {
        recordEmployeeHistory(
          next.id,
          next.name,
          employee.status !== next.status ? "Status changed" : "Updated",
          changes,
        );
      }
      data.employees = data.employees.map((item) => item.id === employee.id ? next : item);
    } else {
      recordEmployeeHistory(next.id, next.name, "Added", changes);
      data.employees.unshift(next);
    }
    root.innerHTML = "";
    void saveAndRender(employee ? "Employee details updated." : "Employee added.");
  });
}

async function deleteEmployee(id: string): Promise<void> {
  const employee = data.employees.find((item) => item.id === id);
  if (!employee || !window.confirm(`Delete ${employee.name}? Historical pay run records will remain.`)) return;
  recordEmployeeHistory(employee.id, employee.name, "Deleted", [
    { field: "Employee record", previous: "Present", current: "Deleted" },
  ]);
  data.employees = data.employees.filter((item) => item.id !== id);
  await saveAndRender("Employee deleted.");
}

function showRunForm(): void {
  if (!data.employees.some((employee) => employee.status === "Active")) {
    toast("Add at least one active employee before creating a pay run.", true);
    if (!data.employees.length) { route = "Employees"; render(); }
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const root = showModal("Create a pay run", `<p class="modal-intro">Choose a pay period and frequency. Active employees will be included automatically.</p><form id="run-form" class="form-grid">
    <label class="full-span">Pay run name<input name="name" maxlength="100" required placeholder="e.g. November second half"></label>
    <label>Pay frequency<select name="frequency"><option>Monthly</option><option selected>Semi-monthly</option><option>Biweekly</option><option>Weekly</option></select></label>
    <label>Pay date<input name="payDate" type="date" required value="${today}"></label>
    <label>Period start<input name="startDate" type="date" required value="${today}"></label>
    <label>Period end<input name="endDate" type="date" required value="${today}"></label>
    <div class="pay-preview full-span"><span>Included employees</span><b>${data.employees.filter((employee) => employee.status === "Active").length} active</b><small>Monthly pay is prorated by frequency. Hourly hours can be edited in the run after creation.</small></div>
    <div class="form-actions full-span"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-dark">Create draft run</button></div>
  </form>`);
  root.querySelectorAll<HTMLElement>('[data-action="close-modal"]').forEach((button) => button.addEventListener("click", () => root.innerHTML = ""));
  root.querySelector<HTMLFormElement>("#run-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    const frequency = String(values.get("frequency")) as PayFrequency;
    const factor = frequencyFactor[frequency];
    const lines: PayLine[] = data.employees.filter((employee) => employee.status === "Active").map((employee) => {
      const earnings = employee.type === "Monthly" ? round(employee.monthlySalary * factor) : 0;
      const statutory = calculateStatutoryDeductions(earnings, frequency, employee);
      const otherDeductions = round(employee.fixedDeduction * factor);
      return {
        employeeId: employee.id,
        employeeName: employee.name,
        role: employee.role || employee.department || "Team member",
        payType: employee.type,
        rate: employee.type === "Monthly" ? employee.monthlySalary : employee.hourlyRate,
        hours: 0,
        earnings,
        statutoryDeductions: statutory.employee,
        employerContributions: statutory.employer,
        otherDeductions,
        deductions: round(sumStatutoryDeductions(statutory.employee) + otherDeductions),
        sssCovered: employee.sssCovered !== false,
        philHealthCovered: employee.philHealthCovered !== false,
        pagIbigCovered: employee.pagIbigCovered !== false,
        withholdingTaxEnabled: employee.withholdingTaxEnabled !== false,
      };
    });
    const run: PayRun = {
      id: crypto.randomUUID(),
      name: String(values.get("name")).trim(),
      startDate: String(values.get("startDate")),
      endDate: String(values.get("endDate")),
      payDate: String(values.get("payDate")),
      frequency,
      status: "Draft",
      lines,
      createdAt: new Date().toISOString(),
    };
    if (run.endDate < run.startDate) { toast("Period end date must be on or after the start date.", true); return; }
    data.payRuns.unshift(run);
    selectedRunId = run.id;
    route = "Payroll";
    root.innerHTML = "";
    void saveAndRender("Draft pay run created.");
  });
}

function showLineForm(runId: string, employeeId: string): void {
  const run = data.payRuns.find((item) => item.id === runId);
  const line = run?.lines.find((item) => item.employeeId === employeeId);
  if (!run || !line || run.status === "Paid") return;
  const factor = frequencyFactor[run.frequency];
  const baseEarnings = line.payType === "Hourly" ? line.rate * line.hours : line.rate * factor;
  const initialExtra = Math.max(0, line.earnings - baseEarnings);
  const initialStatutory = line.statutoryDeductions ?? calculateStatutoryDeductions(line.earnings, run.frequency, line).employee;
  const initialEmployer = line.employerContributions ?? calculateStatutoryDeductions(line.earnings, run.frequency, line).employer;
  const root = showModal(`Adjust ${esc(line.employeeName)}`, `<p class="modal-intro">Review the calculated employee contributions and withholding tax. You can adjust the amounts for this pay run.</p><form id="line-form" class="form-grid">
    ${line.payType === "Hourly" ? `<label class="full-span">Hours worked<input name="hours" type="number" min="0" step="0.25" required value="${line.hours}"><small>Rate: ${money(line.rate)} per hour. Earnings are calculated from hours × rate.</small></label>` : `<div class="pay-preview full-span"><span>Base salary for ${run.frequency}</span><b>${money(baseEarnings)}</b><small>Monthly salary is prorated based on this pay run’s frequency.</small></div>`}
    <label class="full-span">Additional earnings (₱)<input name="extra" type="number" min="0" step="0.01" required value="${initialExtra}"><small>Enter taxable overtime, allowances, bonuses, or other additional taxable earnings.</small></label>
    <div class="statutory-section full-span"><div class="statutory-heading"><b>Employee deductions</b><small>These amounts reduce take-home pay.</small></div><div class="statutory-grid">
      <label>SSS<input name="sss" type="number" min="0" step="0.01" required value="${initialStatutory.sss}"></label>
      <label>PhilHealth<input name="philHealth" type="number" min="0" step="0.01" required value="${initialStatutory.philHealth}"></label>
      <label>Pag-IBIG<input name="pagIbig" type="number" min="0" step="0.01" required value="${initialStatutory.pagIbig}"></label>
      <label>Withholding tax<input name="withholdingTax" type="number" min="0" step="0.01" required value="${initialStatutory.withholdingTax}"></label>
    </div></div>
    <label class="full-span">Other deductions (₱)<input name="otherDeductions" type="number" min="0" step="0.01" required value="${lineOtherDeductions(line)}"><small>Loans and other verified deductions. Does not reduce taxable compensation.</small></label>
    <div class="employer-share full-span" data-employer-share>Employer share (not deducted): SSS ${money(initialEmployer.sss)} · EC ${money(initialEmployer.sssEc)} · PhilHealth ${money(initialEmployer.philHealth)} · Pag-IBIG ${money(initialEmployer.pagIbig)}</div>
    <div class="deduction-total full-span"><span>Total deductions</span><b data-total-deductions>${money(line.deductions)}</b><span>Estimated take-home</span><b data-net-preview>${money(line.earnings - line.deductions)}</b></div>
    <div class="form-actions full-span"><button type="button" class="button button-outline" data-action="close-modal">Cancel</button><button type="submit" class="button button-dark">Save adjustments</button></div>
  </form>`);
  root.querySelectorAll<HTMLElement>('[data-action="close-modal"]').forEach((button) => button.addEventListener("click", () => root.innerHTML = ""));
  const form = root.querySelector<HTMLFormElement>("#line-form")!;
  const inputValue = (name: string): number =>
    Number((form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? 0);
  let previewEarnings = line.earnings;
  const updatePreview = (earnings = previewEarnings): void => {
    previewEarnings = earnings;
    const statutory: StatutoryDeductions = {
      sss: inputValue("sss"),
      philHealth: inputValue("philHealth"),
      pagIbig: inputValue("pagIbig"),
      withholdingTax: inputValue("withholdingTax"),
    };
    const total = round(sumStatutoryDeductions(statutory) + inputValue("otherDeductions"));
    const totalEl = root.querySelector<HTMLElement>("[data-total-deductions]");
    const netEl = root.querySelector<HTMLElement>("[data-net-preview]");
    if (totalEl) totalEl.textContent = money(total);
    if (netEl) {
      netEl.textContent = money(previewEarnings - total);
      netEl.classList.toggle("negative", total > previewEarnings);
    }
  };
  const recalculate = (): void => {
    const hours = line.payType === "Hourly" ? inputValue("hours") : 0;
    const base = line.payType === "Hourly" ? line.rate * hours : line.rate * factor;
    const earnings = round(base + inputValue("extra"));
    if (!Number.isFinite(earnings) || earnings < 0) return;
    const calculated = calculateStatutoryDeductions(earnings, run.frequency, line);
    (form.elements.namedItem("sss") as HTMLInputElement).value = String(calculated.employee.sss);
    (form.elements.namedItem("philHealth") as HTMLInputElement).value = String(calculated.employee.philHealth);
    (form.elements.namedItem("pagIbig") as HTMLInputElement).value = String(calculated.employee.pagIbig);
    (form.elements.namedItem("withholdingTax") as HTMLInputElement).value = String(calculated.employee.withholdingTax);
    const employer = root.querySelector<HTMLElement>("[data-employer-share]");
    if (employer) {
      employer.textContent = `Employer share (not deducted): SSS ${money(calculated.employer.sss)} · EC ${money(calculated.employer.sssEc)} · PhilHealth ${money(calculated.employer.philHealth)} · Pag-IBIG ${money(calculated.employer.pagIbig)}`;
    }
    updatePreview(earnings);
  };
  form.querySelector<HTMLInputElement>('[name="hours"]')?.addEventListener("input", recalculate);
  form.querySelector<HTMLInputElement>('[name="extra"]')?.addEventListener("input", recalculate);
  for (const name of ["sss", "philHealth", "pagIbig", "withholdingTax", "otherDeductions"]) {
    form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.addEventListener("input", () => updatePreview());
  }
  updatePreview();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const hours = line.payType === "Hourly" ? inputValue("hours") : 0;
    const base = line.payType === "Hourly" ? line.rate * hours : line.rate * factor;
    const extra = inputValue("extra");
    const earnings = round(base + extra);
    const statutory: StatutoryDeductions = {
      sss: inputValue("sss"),
      philHealth: inputValue("philHealth"),
      pagIbig: inputValue("pagIbig"),
      withholdingTax: inputValue("withholdingTax"),
    };
    const otherDeductions = inputValue("otherDeductions");
    const deductions = round(sumStatutoryDeductions(statutory) + otherDeductions);
    if (![hours, base, extra, otherDeductions, ...Object.values(statutory)].every(Number.isFinite)
      || [hours, base, extra, otherDeductions, ...Object.values(statutory)].some((value) => value < 0)) {
      toast("Enter valid non-negative amounts.", true);
      return;
    }
    if (deductions > earnings) {
      toast("Deductions cannot be greater than gross earnings.", true);
      return;
    }
    line.hours = hours;
    line.earnings = earnings;
    line.statutoryDeductions = statutory;
    line.employerContributions = calculateStatutoryDeductions(earnings, run.frequency, line).employer;
    line.otherDeductions = round(otherDeductions);
    line.deductions = deductions;
    root.innerHTML = "";
    void saveAndRender("Pay line updated.");
  });
}

async function markPaid(id: string): Promise<void> {
  const run = data.payRuns.find((item) => item.id === id);
  if (!run || run.status !== "Draft") return;
  if (!window.confirm(`Mark “${run.name}” as paid? This will lock pay-line adjustments.`)) return;
  run.status = "Paid";
  await saveAndRender("Pay run marked as paid.");
}
async function deleteRun(id: string): Promise<void> {
  const run = data.payRuns.find((item) => item.id === id);
  if (!run || run.status !== "Draft" || !window.confirm(`Delete draft “${run.name}”? This cannot be undone.`)) return;
  data.payRuns = data.payRuns.filter((item) => item.id !== id);
  selectedRunId = null;
  await saveAndRender("Draft pay run deleted.");
}
function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
const dayMilliseconds = 24 * 60 * 60 * 1000;
function isoDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function daysInMonthUTC(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
function calendarPaydays(schedule: PayrollSchedule, year: number, month: number): string[] {
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month, daysInMonthUTC(year, month)));
  const anchor = new Date(`${schedule.startDate}T00:00:00.000Z`);
  const earliest = new Date(`${isoDateUTC(new Date())}T00:00:00.000Z`);
  if (schedule.frequency === "Monthly") {
    const date = new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), daysInMonthUTC(year, month))));
    return date >= anchor && date >= earliest ? [isoDateUTC(date)] : [];
  }
  if (schedule.frequency === "Semi-monthly") {
    return [15, daysInMonthUTC(year, month)]
      .map((day) => new Date(Date.UTC(year, month, day)))
      .filter((date) => date >= anchor && date >= earliest)
      .map(isoDateUTC);
  }
  const interval = schedule.frequency === "Weekly" ? 7 : 14;
  const daysUntilMonth = Math.ceil((monthStart.getTime() - anchor.getTime()) / dayMilliseconds);
  const firstOffset = Math.max(0, Math.ceil(daysUntilMonth / interval) * interval);
  const dates: string[] = [];
  for (let offset = firstOffset; ; offset += interval) {
    const date = new Date(anchor.getTime() + offset * dayMilliseconds);
    if (date > monthEnd) break;
    if (date >= monthStart && date >= earliest) dates.push(isoDateUTC(date));
  }
  return dates;
}
function estimateScheduledPayroll(frequency: PayFrequency): {
  employeeCount: number;
  hourlyCount: number;
  gross: number;
  deductions: number;
  takeHome: number;
} {
  const active = data.employees.filter((employee) => employee.status === "Active");
  const monthly = active.filter((employee) => employee.type === "Monthly");
  let gross = 0;
  let deductions = 0;
  for (const employee of monthly) {
    const earnings = round(employee.monthlySalary * frequencyFactor[frequency]);
    const statutory = calculateStatutoryDeductions(earnings, frequency, employee).employee;
    gross += earnings;
    deductions += sumStatutoryDeductions(statutory) + round(employee.fixedDeduction * frequencyFactor[frequency]);
  }
  gross = round(gross);
  deductions = round(deductions);
  return {
    employeeCount: monthly.length,
    hourlyCount: active.length - monthly.length,
    gross,
    deductions,
    takeHome: round(gross - deductions),
  };
}
function renderCalendar(): string {
  const schedule = data.payrollSchedule;
  const year = calendarMonth.getUTCFullYear();
  const month = calendarMonth.getUTCMonth();
  const firstWeekday = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const dayCount = daysInMonthUTC(year, month);
  const cellCount = Math.ceil((firstWeekday + dayCount) / 7) * 7;
  const today = isoDateUTC(new Date());
  const simulatedDates = schedule ? new Set(calendarPaydays(schedule, year, month)) : new Set<string>();
  const runsByDate = new Map<string, PayRun[]>();
  for (const run of data.payRuns) {
    const runs = runsByDate.get(run.payDate) ?? [];
    runs.push(run);
    runsByDate.set(run.payDate, runs);
  }
  const estimate = schedule ? estimateScheduledPayroll(schedule.frequency) : null;
  const monthLabel = calendarMonth.toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" });
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > dayCount) return `<div class="calendar-day empty-day" aria-hidden="true"></div>`;
    const date = isoDateUTC(new Date(Date.UTC(year, month, day)));
    const runs = runsByDate.get(date) ?? [];
    const events = runs.length
      ? runs.map((run) => `<span class="calendar-event actual ${run.status.toLowerCase()}">${esc(run.name)} · ${run.status}</span>`).join("")
      : simulatedDates.has(date) && estimate
        ? `<span class="calendar-event forecast">Scheduled · estimate</span><b class="calendar-net">${money(estimate.takeHome)}</b>`
        : "";
    return `<div class="calendar-day${date === today ? " today" : ""}${events ? " has-event" : ""}"><span class="calendar-day-number">${day}</span>${events}</div>`;
  }).join("");
  const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `<div class="page-heading"><div><div class="eyebrow">PAYROLL FORECAST</div><h1>Payroll calendar</h1><p>Preview scheduled pay dates and estimated costs. This simulation does not create pay runs or send payments.</p></div></div>
    <section class="panel calendar-schedule"><div class="panel-heading"><div><h2>Schedule settings</h2><p>${schedule ? "Adjust the recurring forecast schedule." : "Set a schedule to start forecasting pay dates."}</p></div></div>
      <form id="schedule-form" class="calendar-schedule-form">
        <label>Pay frequency<select name="frequency"><option ${schedule?.frequency === "Monthly" || !schedule ? "selected" : ""}>Monthly</option><option ${schedule?.frequency === "Semi-monthly" ? "selected" : ""}>Semi-monthly</option><option ${schedule?.frequency === "Biweekly" ? "selected" : ""}>Biweekly</option><option ${schedule?.frequency === "Weekly" ? "selected" : ""}>Weekly</option></select></label>
        <label>Schedule start date<input name="startDate" type="date" required value="${schedule?.startDate ?? today}"><small>Dates before this start are skipped. Monthly uses this day of the month; weekly and biweekly repeat from it.</small></label>
        <div class="calendar-rule-note">${schedule?.frequency === "Semi-monthly" ? "Semi-monthly forecast: the 15th and the last day of each month, starting on or after the anchor date." : "Semi-monthly forecast dates use the 15th and the last day of each month."}</div>
        <div class="calendar-schedule-actions"><button class="button button-dark" type="submit">Save schedule</button>${schedule ? `<button class="button button-outline" type="button" data-action="clear-schedule">Clear schedule</button>` : ""}</div>
      </form>
    </section>
    <div class="calendar-layout">
      <section class="panel calendar-panel"><div class="calendar-toolbar"><button class="icon-button" data-action="calendar-month" data-offset="-1" aria-label="Previous month">‹</button><h2>${monthLabel}</h2><button class="icon-button" data-action="calendar-month" data-offset="1" aria-label="Next month">›</button></div>
        <div class="calendar-grid">${weekdayLabels.map((label) => `<div class="calendar-weekday">${label}</div>`).join("")}${cells}</div>
      </section>
      <aside class="panel forecast-panel"><div class="panel-heading"><div><h2>${schedule ? `${schedule.frequency} estimate` : "Forecast summary"}</h2><p>${schedule ? "Per scheduled pay run" : "No schedule configured"}</p></div></div>
        ${estimate ? `<div class="forecast-metrics"><div><span>Projected gross</span><b>${money(estimate.gross)}</b></div><div><span>Estimated deductions</span><b>${money(estimate.deductions)}</b></div><div class="forecast-takehome"><span>Estimated take-home</span><b>${money(estimate.takeHome)}</b></div><div><span>Monthly employees included</span><b>${estimate.employeeCount}</b></div>${estimate.hourlyCount ? `<p class="forecast-warning">${estimate.hourlyCount} active hourly ${estimate.hourlyCount === 1 ? "employee is" : "employees are"} excluded because future hours are unknown.</p>` : ""}</div>` : `<div class="empty-inline"><b>Set a schedule to begin</b><p>Forecasts use current active monthly salaries and recurring deductions.</p></div>`}
        <div class="forecast-legend"><span class="legend-dot forecast-dot"></span> Simulated payday <span class="legend-dot actual-dot"></span> Existing pay run</div>
      </aside>
    </div>
    <div class="footnote"><span>ⓘ</span> Projections use current employee records and statutory estimates. Dates are not shifted for weekends, holidays, or company-specific cutoffs, and simulated dates never create pay runs automatically.</div>`;
}
function renderEmployeeHistory(): string {
  const entries = [...data.employeeHistory].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `<div class="page-heading"><div><div class="eyebrow">EMPLOYEE AUDIT TRAIL</div><h1>Employee history</h1><p>Review additions, profile changes, status changes, and deletions.</p></div></div>
    <section class="panel history-panel">${entries.length     ? `<div class="history-list">${entries.map((entry) => `<article class="history-entry"><span class="history-marker">${entry.action === "Added" ? "＋" : entry.action === "Deleted" ? "×" : "↻"}</span><div class="history-entry-content"><div class="history-entry-heading"><b>${esc(entry.employeeName)}</b><span class="history-action ${entry.action.toLowerCase().replace(/ /g, "-")}">${esc(entry.action)}</span><time>${esc(dateTimeLabel(entry.createdAt))}</time></div>${entry.changes.length ? `<ul>${entry.changes.map((change) => `<li><span>${esc(change.field)}</span><span>${esc(change.previous)} <b>→</b> ${esc(change.current)}</span></li>`).join("")}</ul>` : ""}</div></article>`).join("")}</div>` : `<div class="empty-inline"><span class="empty-icon">◷</span><b>No employee history yet</b><p>Employee additions and profile changes will be recorded here.</p><button class="button button-outline" data-route="Employees">View employees</button></div>`}</section>
    <div class="footnote"><span>ⓘ</span> Contact detail changes are logged without storing old email addresses or phone numbers in the audit trail.</div>`;
}
function exportRun(id: string): void {
  const run = data.payRuns.find((item) => item.id === id);
  if (!run) return;
  const rows = [
    ["Employee", "Role", "Pay basis", "Rate", "Hours", "Earnings PHP", "SSS employee PHP", "PhilHealth employee PHP", "Pag-IBIG employee PHP", "Withholding tax PHP", "Other deductions PHP", "Total deductions PHP", "Employer contributions PHP", "Take-home PHP", "Pay date"],
    ...run.lines.map((line) => {
      const statutory = lineStatutoryDeductions(line);
      return [
        line.employeeName, line.role, line.payType, line.rate, line.hours, line.earnings,
        statutory.sss, statutory.philHealth, statutory.pagIbig, statutory.withholdingTax,
        lineOtherDeductions(line), line.deductions,
        sumEmployerContributions(line.employerContributions ?? zeroEmployerContributions),
        round(line.earnings - line.deductions), run.payDate,
      ];
    }),
  ];
  const csv = rows.map((row) => row.map((field) => `"${String(field).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  download(`${slug(run.name)}-payroll.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
}
function printRun(id: string): void {
  const run = data.payRuns.find((item) => item.id === id);
  if (!run) return;
  const root = document.querySelector<HTMLDivElement>("#modal-root")!;
  root.innerHTML = `<div class="print-sheet">${run.lines.map((line) => {
    const statutory = lineStatutoryDeductions(line);
    const deductions = [
      ["SSS", statutory.sss],
      ["PhilHealth", statutory.philHealth],
      ["Pag-IBIG", statutory.pagIbig],
      ["Withholding tax", statutory.withholdingTax],
      ["Other deductions", lineOtherDeductions(line)],
    ] as const;
    return `<article class="payslip"><header><b>${esc(data.companyName)}</b><span>PAYSLIP</span></header><h2>${esc(line.employeeName)}</h2><p>${esc(line.role)} · ${esc(run.name)}</p><div class="payslip-dates"><span>Pay period<b>${dateLabel(run.startDate)} – ${dateLabel(run.endDate)}</b></span><span>Pay date<b>${dateLabel(run.payDate)}</b></span></div><div class="payslip-row"><span>Gross earnings</span><b>${money(line.earnings)}</b></div>${line.payType === "Hourly" ? `<div class="payslip-row"><span>Hours worked</span><b>${line.hours}</b></div>` : ""}${deductions.map(([label, amount]) => `<div class="payslip-row"><span>${label}</span><b>− ${money(amount)}</b></div>`).join("")}<div class="payslip-row payslip-net"><span>Net pay</span><b>${money(line.earnings - line.deductions)}</b></div><p class="payslip-note">All amounts in PHP. Verify statutory deductions and employer payroll records.</p></article>`;
  }).join("")}</div>`;
  window.setTimeout(() => window.print(), 50);
  window.setTimeout(() => { root.innerHTML = ""; }, 1000);
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pay-run";
}
function download(filename: string, content: string, type: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function submitAuth(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!auth) return;
  const form = event.currentTarget as HTMLFormElement;
  const values = new FormData(form);
  const email = String(values.get("email")).trim();
  const password = String(values.get("password"));
  const signup = form.dataset.mode === "signup";
  const errorEl = document.querySelector<HTMLElement>("#auth-error");
  if (errorEl) errorEl.textContent = "";
  setBusy(true);
  try {
    if (signup) await createUserWithEmailAndPassword(auth, email, password);
    else await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error("Firebase sign-in failed.", error);
    if (errorEl) errorEl.textContent = authMessage(error);
  } finally {
    setBusy(false);
  }
}
function authMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code.includes("email-already-in-use")) return "That email already has an account. Try signing in.";
  if (code.includes("invalid-credential") || code.includes("user-not-found") || code.includes("wrong-password")) return "Email or password is incorrect.";
  if (code.includes("weak-password")) return "Choose a password with at least 6 characters.";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait a moment and try again.";
  return "Could not authenticate. Check your Firebase setup and try again.";
}

if (auth) {
  onAuthStateChanged(auth, async (user) => {
    activeUser = user;
    cloudLoadFailed = false;
    if (user) {
      try {
        data = await loadUserData(user);
      } catch (error) {
        console.error("Could not load cloud payroll records.", error);
        cloudLoadFailed = true;
      }
    } else {
      data = loadLocalData();
    }
    render();
  });
} else {
  render();
}
