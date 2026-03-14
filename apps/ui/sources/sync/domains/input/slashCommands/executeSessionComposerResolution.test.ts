import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSessionActionDraft = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({
      createSessionActionDraft,
    }),
  },
}));

async function loadSubject() {
  const mod = await import('./executeSessionComposerResolution');
  return mod.executeSessionComposerResolution;
}

describe('executeSessionComposerResolution', () => {
  beforeEach(() => {
    vi.resetModules();
    createSessionActionDraft.mockReset();
  });

  it('executes ui.voice_global.reset via the action executor and clears the composer', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'ui.voice_global.reset', rest: '' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(actionExecutor.execute).toHaveBeenCalledWith('ui.voice_global.reset', {}, {
      defaultSessionId: 's1',
      surface: 'ui_slash_command',
      placement: 'slash_command',
    });
    expect(setMessage).toHaveBeenCalledWith('');
  });

  it('inserts a review.start action draft when /h.review has no instructions', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const modalAlert = vi.fn();
    const setMessage = vi.fn();
    const clearDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: '   ' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
    });

    expect(handled).toBe(true);
    expect(actionExecutor.execute).not.toHaveBeenCalled();
    expect(modalAlert).not.toHaveBeenCalled();
    expect(setMessage).toHaveBeenCalledWith('');
    expect(clearDraft).toHaveBeenCalled();
    const draftArgs = createSessionActionDraft.mock.calls[0]?.[1] as any;
    expect(draftArgs?.input?.permissionMode).toBe('read-only');
  });

  it('does not inject coderabbit-specific config into review.start drafts (generic input only)', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const setMessage = vi.fn();
    const clearDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: '   ' },
      sessionId: 's1',
      agentId: 'coderabbit',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      permissionMode: 'read_only',
      actionExecutor,
      setMessage,
      clearDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(createSessionActionDraft).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        actionId: 'review.start',
        input: expect.objectContaining({
          sessionId: 's1',
          permissionMode: 'read-only',
        }),
      }),
    );
    const draftArgs = createSessionActionDraft.mock.calls[0]?.[1] as any;
    expect(draftArgs?.input?.engines).toBeUndefined();
  });

  it('executes review.start via the action executor with a safe review permission mode', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { runId: 'r1' } })) };
    const clearDraft = vi.fn();
    const trackMessageSent = vi.fn();
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'safe-yolo',
      actionExecutor,
      setMessage,
      clearDraft,
      trackMessageSent,
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.review Review this.',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(clearDraft).toHaveBeenCalled();
    expect(trackMessageSent).toHaveBeenCalled();
    expect(actionExecutor.execute).toHaveBeenCalledWith(
      'review.start',
      expect.objectContaining({
        sessionId: 's1',
        engineIds: ['claude'],
        instructions: 'Review this.',
        permissionMode: 'read-only',
        changeType: 'uncommitted',
        base: { kind: 'none' },
      }),
      { defaultSessionId: 's1', surface: 'ui_slash_command', placement: 'slash_command' },
    );
  });

  it('restores the previous composer text when review.start fails', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'boom', error: 'boom' })) };
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.review Review this.',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(setMessage).toHaveBeenCalledWith('/h.review Review this.');
  });

  it('restores the previous composer text and shows an error when review.start fanout returns a failed result item', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = {
      execute: vi.fn(async () => ({
        ok: true as const,
        result: {
          results: [{ ok: false, error: 'backend_unavailable' }],
        },
      })),
    };
    const setMessage = vi.fn();
    const modalAlert = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      previousMessage: '/h.review Review this.',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(setMessage).toHaveBeenCalledWith('/h.review Review this.');
    expect(modalAlert).toHaveBeenCalledWith('Error', 'backend_unavailable');
  });

  it('defaults subagents.delegate.start permissionMode to safe-yolo when executing', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { runId: 'r1' } })) };
    const clearDraft = vi.fn();
    const trackMessageSent = vi.fn();
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'subagents.delegate.start', rest: 'Do the thing.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: null,
      actionExecutor,
      setMessage,
      clearDraft,
      trackMessageSent,
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.delegate Do the thing.',
    });

    expect(handled).toBe(true);
    expect(actionExecutor.execute).toHaveBeenCalledWith(
      'subagents.delegate.start',
      expect.objectContaining({
        sessionId: 's1',
        backendTargetKeys: ['agent:claude'],
        instructions: 'Do the thing.',
        permissionMode: 'safe-yolo',
      }),
      { defaultSessionId: 's1', surface: 'ui_slash_command', placement: 'slash_command' },
    );
  });

  it('defaults subagents.delegate.start draft permissionMode to safe-yolo when instructions are missing', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'subagents.delegate.start', rest: '   ' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: null,
      actionExecutor,
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(actionExecutor.execute).not.toHaveBeenCalled();
    expect(createSessionActionDraft).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        actionId: 'subagents.delegate.start',
      }),
    );
    const draftArgs = createSessionActionDraft.mock.calls[0]?.[1] as any;
    expect(draftArgs?.input?.permissionMode).toBe('safe-yolo');
  });

  it('preserves configured ACP backend targets for subagent drafts and execution', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { runId: 'r1' } })) };

    const handledDraft = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'subagents.plan.start', rest: '   ' },
      sessionId: 's1',
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'safe-yolo',
      actionExecutor,
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
    });

    expect(handledDraft).toBe(true);
    const draftArgs = createSessionActionDraft.mock.calls[0]?.[1] as any;
    expect(draftArgs?.input?.backendTargetKeys).toEqual(['acpBackend:review-bot']);
    expect(draftArgs?.input?.permissionMode).toBe('read-only');

    createSessionActionDraft.mockReset();
    actionExecutor.execute.mockClear();

    const handledExecute = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'subagents.plan.start', rest: 'Plan this.' },
      sessionId: 's1',
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'safe-yolo',
      actionExecutor,
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.plan Plan this.',
    });

    expect(handledExecute).toBe(true);
    expect(actionExecutor.execute).toHaveBeenCalledWith(
      'subagents.plan.start',
      expect.objectContaining({
        sessionId: 's1',
        backendTargetKeys: ['acpBackend:review-bot'],
        instructions: 'Plan this.',
        permissionMode: 'read-only',
      }),
      { defaultSessionId: 's1', surface: 'ui_slash_command', placement: 'slash_command' },
    );
  });
});
