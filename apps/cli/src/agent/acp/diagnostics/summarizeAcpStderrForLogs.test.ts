import { describe, expect, it } from 'vitest';

import { summarizeAcpStderrForLogs } from './summarizeAcpStderrForLogs';

describe('summarizeAcpStderrForLogs', () => {
  it('returns null for empty input', () => {
    expect(summarizeAcpStderrForLogs('   \n')).toBeNull();
  });

  it('redacts harness context markers', () => {
    expect(summarizeAcpStderrForLogs('<permissions instructions>secret</permissions instructions>')).toBe(
      '[redacted harness context]',
    );
  });

  it('truncates long stderr output for debug logs', () => {
    const out = summarizeAcpStderrForLogs('a'.repeat(1_000));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(501);
    expect(out!.endsWith('…')).toBe(true);
  });
});

