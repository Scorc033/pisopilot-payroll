# PisoPilot Payroll

A lightweight payroll manager for Philippine peso (₱) payroll. It supports employee records and an audit history, a forecast-only payroll calendar, saved pay runs, editable per-run earnings and deductions, printable payslips, CSV export, and a light/dark theme toggle that remembers your preference in this browser.

## Run locally

1. Install Node.js 20 or later.
2. Run `npm install`.
3. Run `npm run dev` and open the local URL Vite prints.

Without Firebase settings, the app runs in local demo mode and saves records in this browser's local storage. That mode is intended for evaluation, not shared or production payroll data.

## Connect Firebase

1. Create a Firebase project and register a Web App.
2. Enable **Authentication → Email/Password** and create a **Cloud Firestore** database.
3. Copy `.env.example` to `.env.local` and fill in the Firebase Web App values. Restart Vite after changing environment settings.
4. Publish the included Firestore rules, build with `npm run build`, then deploy `dist` with Firebase Hosting.

In Firebase mode, users create an account or sign in with email and password. Employee, employee-history, pay-run, and workspace settings records are stored in Firestore under account-specific collections, and the included rules restrict access to that account. Publish the updated rules when adding the employee-history collection. Configure Firebase authorized domains before hosting publicly.

## Employee history and payroll calendar

The employee-history page records additions, profile and payroll-setting changes, status changes, and deletions. It retains a small change summary, but does not keep old email addresses or phone numbers in the audit trail.

The calendar is a simulation, not an automatic payroll scheduler or payment integration. Save a schedule frequency and anchor date to see recurring forecast dates. Monthly schedules repeat on the anchor day (clamped to the last day of shorter months); semi-monthly schedules use the 15th and the last day of each month; weekly and biweekly schedules repeat every 7 or 14 days from the anchor. Existing pay runs are shown separately. Forecast totals use current active monthly employees and current deduction estimates; active hourly employees are excluded because future hours are unknown. Dates are not shifted for weekends, public holidays, or company-specific cutoff rules. The calendar never creates pay runs or initiates payments.

## Payroll notes

Monthly salaries and fixed monthly deductions are prorated using the selected pay frequency (monthly, semi-monthly, biweekly, or weekly); hourly earnings are calculated from hours entered on each pay run. Draft pay lines calculate regular-pay estimates for employee SSS, PhilHealth, Pag-IBIG, and TRAIN withholding tax. Employer contributions are shown separately and are not deducted from take-home pay. Coverage can be disabled per employee, and calculated amounts can be adjusted per draft pay line. The pay-run table, CSV export, and payslip itemize the employee deductions.

The defaults use a 5% employee SSS share on a ₱5,000–₱35,000 salary-credit range (employer 10% plus EC), a 5% PhilHealth premium split equally on a ₱10,000–₱100,000 monthly base, Pag-IBIG employee savings of 1% for fund salary up to ₱1,500 and 2% above it (with a ₱10,000 fund-salary cap and employer 2%), and the graduated TRAIN annual income-tax brackets. Employer-side amounts are calculated separately. Reference the current schedules at [SSS](https://www.sss.gov.ph/sss-contribution-table/), [PhilHealth](https://www.philhealth.gov.ph/partners/employers/), [Pag-IBIG](https://www.pagibigfund.gov.ph/), and [BIR](https://www.bir.gov.ph/); review them before each payroll cycle because agency rates and rules may change.

These are estimates for regular compensation, not a complete Philippine compliance or tax engine. The tax estimate annualizes the current pay period and subtracts employee statutory contributions; it does not track year-to-date income, prior employers, the ₱90,000 13th-month/other-benefits exemption, minimum-wage-earner exemptions, or every special compensation category. Additional earnings are treated as taxable by default. Validate eligibility, attendance, current agency schedules, exemptions, and tax withholding with a qualified payroll professional before paying employees. Negative take-home is prevented by rejecting deductions greater than gross earnings.
