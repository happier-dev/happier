import { describe, expect, it } from 'vitest';

import { buildActionDraftInput } from './buildActionDraftInput';

describe('buildActionDraftInput', () => {
  it('seeds review.start with sessionId, backend selection, instructions, and required defaults', () => {
    const input = buildActionDraftInput({
      actionId: 'review.start' as any,
      sessionId: 's1',
      defaultBackendId: 'claude',
      instructions: 'Review this',
    });

    expect(input).toMatchObject({
      sessionId: 's1',
      engineIds: ['claude'],
      instructions: 'Review this',
      changeType: 'committed',
      base: { kind: 'none' },
    });
  });

  it('merges explicit extra fields without losing seeded defaults', () => {
    const input = buildActionDraftInput({
      actionId: 'plan.start' as any,
      sessionId: 's1',
      defaultBackendId: 'codex',
      instructions: '',
      extra: { permissionMode: 'read_only' },
    });

    expect(input).toMatchObject({
      sessionId: 's1',
      backendIds: ['codex'],
      instructions: '',
      permissionMode: 'read_only',
    });
  });
});

