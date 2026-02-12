import { describe, expect, it } from 'vitest';

import { resolveBugReportServerDiagnosticsLines } from './bugReports.js';

describe('resolveBugReportServerDiagnosticsLines', () => {
  it('returns default line count when context window is missing', () => {
    expect(resolveBugReportServerDiagnosticsLines(undefined)).toBe(200);
  });

  it('enforces lower and upper bounds derived from context window', () => {
    expect(resolveBugReportServerDiagnosticsLines(45_000)).toBe(50);
    expect(resolveBugReportServerDiagnosticsLines(30 * 60 * 1_000)).toBe(500);
  });
});

