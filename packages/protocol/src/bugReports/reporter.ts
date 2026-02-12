export function normalizeBugReportGithubUsername(raw: string | null | undefined): string | null {
  let value = String(raw ?? '').trim();
  if (!value) return null;

  // Avoid pings by stripping leading @. Keep the rest as user-provided text,
  // but constrain to a single line and remove markdown backticks.
  value = value.replace(/^@+/, '');
  value = value.split(/[\r\n\u2028\u2029]/)[0] ?? '';
  value = value.replace(/`+/g, '').trim();
  if (!value) return null;

  // Keep the issue body readable and avoid abuse with arbitrarily long handles.
  if (value.length > 80) {
    value = value.slice(0, 80).trim();
  }

  return value || null;
}

export function appendBugReportReporterToSummary(summary: string, githubUsername?: string | null): string {
  const base = String(summary ?? '').trim();
  // Avoid duplicating reporter info if a user already included it manually.
  if (/(^|\n)Reporter GitHub:\s*`[^`]*`/i.test(base)) return base;
  const normalized = normalizeBugReportGithubUsername(githubUsername);
  if (!normalized) return base;
  if (!base) return `Reporter GitHub: \`${normalized}\``;
  return `${base}\n\nReporter GitHub: \`${normalized}\``;
}
