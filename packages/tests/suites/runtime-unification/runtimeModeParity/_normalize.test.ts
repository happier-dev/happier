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
      event: {
        kind: 'runtime-status-change',
        sessionId: '57f7fd51-5e91-42ca-b457-e077e8ac8944',
        emittedAtMs: 1_781_111_222_555,
        detail: {
          kind: 'runtime-mode-change',
          from: 'terminal',
          to: 'remote',
          reason: 'user_request',
          resumeId: 'codex-provider-session-1',
        },
      },
    });

    expect(snapshot).toMatchObject({
      sessionId: '<uuid>',
      providerSessionId: 'codex-provider-session-1',
      runtimeMode: 'remote',
      emittedAtMs: 0,
      updatedAtMs: 0,
      event: {
        sessionId: '<uuid>',
        emittedAtMs: 0,
        detail: {
          from: 'terminal',
          to: 'remote',
          resumeId: 'codex-provider-session-1',
        },
      },
    });
  });
});
