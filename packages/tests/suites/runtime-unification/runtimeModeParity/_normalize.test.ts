import { describe, expect, it } from 'vitest';

import { normalizeRuntimeModeParitySnapshot } from './_normalize';

describe('normalizeRuntimeModeParitySnapshot', () => {
  it('masks volatile timestamps and uuids while preserving provider session and mode contracts', () => {
    const snapshot = normalizeRuntimeModeParitySnapshot({
      sessionId: '57f7fd51-5e91-42ca-b457-e077e8ac8944',
      providerSessionId: 'codex-provider-session-1',
      runtimeMode: 'remote',
      emittedAtMs: 1_781_111_222_333,
      updatedAtMs: 1_781_111_222_444,
      transition: {
        from: 'terminal',
        to: 'remote',
        reason: 'user_request',
      },
    });

    expect(snapshot).toMatchObject({
      sessionId: '<uuid>',
      providerSessionId: 'codex-provider-session-1',
      runtimeMode: 'remote',
      emittedAtMs: 0,
      updatedAtMs: 0,
      transition: {
        from: 'terminal',
        to: 'remote',
        reason: 'user_request',
      },
    });
  });
});
