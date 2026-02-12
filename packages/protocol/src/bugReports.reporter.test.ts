import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

describe('bug report reporter helpers', () => {
  it('exports appendBugReportReporterToSummary', () => {
    const fn = (protocol as unknown as { appendBugReportReporterToSummary?: unknown }).appendBugReportReporterToSummary;
    expect(typeof fn).toBe('function');
  });

  it('appends a sanitized GitHub username to the summary', () => {
    const fn = (protocol as unknown as {
      appendBugReportReporterToSummary?: (summary: string, githubUsername?: string | null) => string;
    }).appendBugReportReporterToSummary;
    expect(typeof fn).toBe('function');
    if (typeof fn !== 'function') return;

    expect(fn('The app freezes after login', '@Foo-Bar\n`oops`')).toBe(
      'The app freezes after login\n\nReporter GitHub: `Foo-Bar`',
    );
  });

  it('handles unicode line separators and keeps only the first line', () => {
    const fn = (protocol as unknown as {
      appendBugReportReporterToSummary?: (summary: string, githubUsername?: string | null) => string;
    }).appendBugReportReporterToSummary;
    expect(typeof fn).toBe('function');
    if (typeof fn !== 'function') return;

    expect(fn('Summary', '@Foo\u2028Bar')).toBe('Summary\n\nReporter GitHub: `Foo`');
    expect(fn('Summary', '@Foo\u2029Bar')).toBe('Summary\n\nReporter GitHub: `Foo`');
  });

  it('is idempotent when summary already contains a Reporter GitHub line', () => {
    const fn = (protocol as unknown as {
      appendBugReportReporterToSummary?: (summary: string, githubUsername?: string | null) => string;
    }).appendBugReportReporterToSummary;
    expect(typeof fn).toBe('function');
    if (typeof fn !== 'function') return;

    const initial = fn('Summary', '@Foo');
    expect(initial).toBe('Summary\n\nReporter GitHub: `Foo`');
    expect(fn(initial, '@Bar')).toBe(initial);
  });
});
