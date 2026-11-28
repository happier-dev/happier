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

  it('carries a canonical external Agent target through the shared Action seed owner', () => {
    const input = buildActionDraftInput({
      actionId: 'subagents.plan.start' as any,
      sessionId: 's1',
      defaultBackendTarget: {
        kind: 'agent',
        identity: { pluginId: 'acme.review-plugin', localId: 'review-agent' },
      },
      instructions: 'Make a plan.',
    });

    expect(input).toMatchObject({
      sessionId: 's1',
      backendTargetKeys: ['agent:acme.review-plugin/review-agent'],
    });
  });
});

it('binds context only to declared fields, keeping no-input Actions valid', () => {
  expect(buildActionDraftInput({ actionId: 'session.pending.next', context: {
    defaultSessionId: 's1', defaultSessionMachineId: 'm1', defaultSessionRootPath: '/repo',
  } })).toEqual({});
  expect(buildActionDraftInput({ actionId: 'session.fork', context: {
    defaultSessionId: 's1', defaultSessionMachineId: 'm1', defaultSessionRootPath: '/repo',
  } })).toMatchObject({ sessionId: 's1' });
});
