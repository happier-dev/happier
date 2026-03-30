import { describe, expect, it } from 'vitest';

import { buildActionDraftInput } from './buildActionDraftInput';

describe('buildActionDraftInput', () => {
  it('seeds review.start with sessionId, instructions, and required defaults while leaving engine selection explicit', () => {
    const input = buildActionDraftInput({
      actionId: 'review.start' as any,
      sessionId: 's1',
      defaultBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      defaultBackendId: 'claude',
      instructions: 'Review this',
    });

    expect(input).toMatchObject({
      sessionId: 's1',
      instructions: 'Review this',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    });
    expect(input).not.toHaveProperty('engineIds');
  });

  it('merges explicit extra fields without losing seeded defaults', () => {
    const input = buildActionDraftInput({
      actionId: 'subagents.plan.start' as any,
      sessionId: 's1',
      defaultBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      instructions: '',
      extra: { permissionMode: 'read_only' },
    });

    expect(input).toMatchObject({
      sessionId: 's1',
      backendTargetKeys: ['acpBackend:review-bot'],
      instructions: '',
      permissionMode: 'read_only',
    });
  });
});
