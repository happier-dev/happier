import { describe, expect, it } from 'vitest';

import { MemoryHintsProfile } from './MemoryHintsProfile';

describe('MemoryHintsProfile', () => {
  it('keeps memory-hints transcriptless and preserves raw text verbatim', () => {
    expect(MemoryHintsProfile.transcriptMaterialization).toBe('none');
    expect(MemoryHintsProfile.emitFinalSidechainMessageWhenStreamed).toBeUndefined();
    expect(MemoryHintsProfile.computeSidechainStreamText?.({ fullText: 'Remember this' })).toBe('Remember this');

    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'memory_hints',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'remember this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const result = MemoryHintsProfile.onBoundedComplete({ start, rawText: 'hint text', finishedAtMs: 2 });
    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Memory hints generated.');
    expect(result.toolResultOutput).toBe('hint text');
  });
});
