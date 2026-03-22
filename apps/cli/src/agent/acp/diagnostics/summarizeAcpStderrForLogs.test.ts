import { describe, expect, it } from 'vitest';

import { createAcpStderrLogSummarizer, summarizeAcpStderrForLogs } from './summarizeAcpStderrForLogs';

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

  it('redacts harness context when the opening marker is split across stderr chunks', () => {
    const summarizeChunk = createAcpStderrLogSummarizer();

    expect(summarizeChunk('<permissions ins')).toBeNull();
    expect(summarizeChunk('tructions>secret payload')).toBe('[redacted harness context]');
    expect(summarizeChunk('still secret')).toBe('[redacted harness context]');
    expect(summarizeChunk('</permissions instructions>')).toBe('[redacted harness context]');
    expect(summarizeChunk('plain stderr after close')).toBe('plain stderr after close');
  });

  it('normalizes newlines and control characters in summaries', () => {
    expect(summarizeAcpStderrForLogs('boom\nnext\r\nline\u0007')).toBe('boom next line');
  });

  it('does not suppress non-marker substrings', () => {
    expect(summarizeAcpStderrForLogs('app')).toBe('app');
  });
});
