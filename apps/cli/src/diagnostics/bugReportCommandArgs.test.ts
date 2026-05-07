import { describe, expect, it } from 'vitest';

import { parseBugReportArgs } from './bugReportCommandArgs';

describe('parseBugReportArgs', () => {
  it('treats -h as missing value for --provider-url instead of consuming it', () => {
    expect(() => parseBugReportArgs(['--provider-url', '-h'])).toThrow(/Missing value for --provider-url/);
  });

  it('allows free-text values starting with a dash when they are provided as a single argument', () => {
    const parsed = parseBugReportArgs(['--summary', '- bullet style summary']);
    expect(parsed.summary).toBe('- bullet style summary');
  });

  it('parses --session-id', () => {
    const parsed = parseBugReportArgs(['--session-id', 'sess-abc-123']);
    expect(parsed.sessionId).toBe('sess-abc-123');
  });

  it('collects --attach paths with attachment kind', () => {
    const parsed = parseBugReportArgs([
      '--attach', '/tmp/extra1.log',
      '--attach', '/tmp/extra2.json',
    ]);
    expect(parsed.attachments).toEqual([
      { path: '/tmp/extra1.log', sourceKind: 'attachment' },
      { path: '/tmp/extra2.json', sourceKind: 'attachment' },
    ]);
  });

  it('tags --attach-session-log and --attach-provider-transcript with the right kinds', () => {
    const parsed = parseBugReportArgs([
      '--attach-session-log', '/home/user/.happier/logs/2026-04-26-pid-12345.log',
      '--attach-provider-transcript', '/home/user/.claude/projects/-x/uuid.jsonl',
      '--attach', '/tmp/screenshot.png',
    ]);
    expect(parsed.attachments).toEqual([
      { path: '/home/user/.happier/logs/2026-04-26-pid-12345.log', sourceKind: 'session-log' },
      { path: '/home/user/.claude/projects/-x/uuid.jsonl', sourceKind: 'provider-transcript' },
      { path: '/tmp/screenshot.png', sourceKind: 'attachment' },
    ]);
  });

  it('drops empty attachment paths after trimming', () => {
    const parsed = parseBugReportArgs(['--attach', '   ', '--attach', '/real/path.log']);
    expect(parsed.attachments).toEqual([
      { path: '/real/path.log', sourceKind: 'attachment' },
    ]);
  });
});
