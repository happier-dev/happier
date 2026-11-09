import { describe, expect, it } from 'vitest';

import { parseBugReportArgs } from './bugReportCommandArgs';

describe('parseBugReportArgs', () => {
  it('supports exact session targeting and independent log consent', () => {
    expect(parseBugReportArgs([]).logSelection).toEqual({ daemon: true, session: true, provider: false });
    expect(parseBugReportArgs(['--session-id', 'selected-session', '--no-include-daemon-logs', '--no-include-session-logs', '--include-provider-transcript'])).toMatchObject({ sessionId: 'selected-session', logSelection: { daemon: false, session: false, provider: true } });
  });

  it('treats -h as missing value for --provider-url instead of consuming it', () => {
    expect(() => parseBugReportArgs(['--provider-url', '-h'])).toThrow(/Missing value for --provider-url/);
  });

  it('allows free-text values starting with a dash when they are provided as a single argument', () => {
    const parsed = parseBugReportArgs(['--summary', '- bullet style summary']);
    expect(parsed.summary).toBe('- bullet style summary');
  });
  it('parses export and dry-run output options', () => {
    expect(parseBugReportArgs(['--export', '/tmp/report.json']).exportPath).toBe('/tmp/report.json');
    expect(parseBugReportArgs(['--dry-run', '--output', '/tmp/report.json'])).toMatchObject({
      dryRun: true,
      exportPath: '/tmp/report.json',
    });
  });
});
