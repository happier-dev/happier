import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSessionActionDraft = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => ({
      createSessionActionDraft,
    }),
  },
});
});

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
    const clearDraft = vi.fn();
    const clearTransientInputState = vi.fn();
    const clearSemanticDraftValues = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'ui.voice_global.reset', rest: '' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft,
      clearTransientInputState,
      clearSemanticDraftValues,
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
    expect(clearDraft).toHaveBeenCalledTimes(1);
    expect(clearTransientInputState).toHaveBeenCalledTimes(1);
    expect(clearSemanticDraftValues).toHaveBeenCalledTimes(1);
  });

  it('restores the previous composer snapshot when ui.voice_global.reset fails', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = {
      execute: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'voice_reset_failed',
        error: 'voice reset failed',
      })),
    };
    const setMessage = vi.fn();
    const clearDraft = vi.fn();
    const clearTransientInputState = vi.fn();
    const clearSemanticDraftValues = vi.fn();
    const restoreComposerSnapshot = vi.fn();
    const modalAlert = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'ui.voice_global.reset', rest: '' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft,
      clearTransientInputState,
      clearSemanticDraftValues,
      restoreComposerSnapshot,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      previousMessage: '/voice reset',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(restoreComposerSnapshot).toHaveBeenCalledWith({
      sessionId: 's1',
      text: '/voice reset',
    });
    expect(clearSemanticDraftValues).not.toHaveBeenCalled();
    expect(clearTransientInputState).not.toHaveBeenCalled();
    expect(modalAlert).toHaveBeenCalledWith('Error', 'voice reset failed');
  });

  it('opens pet settings for the pet chooser action and clears the composer', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const setMessage = vi.fn();
    const clearDraft = vi.fn();
    const navigateToPetSettings = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'ui.pet.choose', rest: '' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      navigateToPetSettings,
      modalAlert: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(actionExecutor.execute).not.toHaveBeenCalled();
    expect(setMessage).toHaveBeenCalledWith('');
    expect(clearDraft).toHaveBeenCalled();
    expect(navigateToPetSettings).toHaveBeenCalledTimes(1);
  });

  it('opens the goal controls for /goal without sending text', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const openGoalControls = vi.fn();
    const setMessage = vi.fn();
    const clearDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'open' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      setMessage,
      clearDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      openGoalControls,
    } as any);

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(clearDraft).toHaveBeenCalled();
    expect(openGoalControls).toHaveBeenCalledTimes(1);
  });

  it('sets the native goal without sending the objective as a user message for /goal objective text', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const setSessionGoal = vi.fn(async () => ({ ok: true as const }));
    const setMessage = vi.fn();
    const clearDraft = vi.fn();
    const trackMessageSent = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'set', objective: 'migrate plugin support' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal migrate plugin support',
      setMessage,
      clearDraft,
      trackMessageSent,
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(setSessionGoal).toHaveBeenCalledWith('s1', { objective: 'migrate plugin support' });
    expect(setMessage).toHaveBeenCalledWith('');
    expect(clearDraft).toHaveBeenCalled();
    expect(trackMessageSent).not.toHaveBeenCalled();
  });

  it('does not send the objective message when the native goal set fails', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const setSessionGoal = vi.fn(async () => ({
      ok: false as const,
      error: 'goals feature is disabled',
    }));
    const setMessage = vi.fn();
    const restoreDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'set', objective: 'migrate plugin support' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal migrate plugin support',
      setMessage,
      clearDraft: vi.fn(),
      restoreDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('/goal migrate plugin support');
    expect(restoreDraft).toHaveBeenCalledWith('/goal migrate plugin support');
  });

  it('restores the previous composer text and draft when a status-only native goal update fails', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const setSessionGoal = vi.fn(async () => ({
      ok: false as const,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    }));
    const setMessage = vi.fn();
    const restoreDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'pause' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal pause',
      setMessage,
      clearDraft: vi.fn(),
      restoreDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('/goal pause');
    expect(restoreDraft).toHaveBeenCalledWith('/goal pause');
  });

  it('shows unsupported goal feedback without sending text', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const modalAlert = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'set', objective: 'migrate plugin support' } as any,
      sessionId: 's1',
      agentId: 'pi',
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
    } as any);

    expect(handled).toBe(true);
    expect(modalAlert).toHaveBeenCalledWith('Goal unavailable', 'This backend does not support editable session goals yet.');
  });

  it('treats a transient unsupported_session_runtime_method as a not-ready (retry) state, not a permanent unsupport', async () => {
    // A freshly-opened active session can return `unsupported_session_runtime_method` from the live
    // session RPC before its runtime goal controls have registered. That is a transient load race,
    // not a genuine backend limitation, so the user must see a retryable "not ready yet" message
    // rather than the permanent-sounding "does not support goals" message.
    const executeSessionComposerResolution = await loadSubject();
    const modalAlert = vi.fn();
    const setSessionGoal = vi.fn(async () => ({
      ok: false as const,
      error: 'unsupported_session_runtime_method:session.goal.set',
      errorCode: 'unsupported_session_runtime_method',
    }));

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'set', objective: 'migrate plugin support' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal migrate plugin support',
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(modalAlert).toHaveBeenCalledWith('Goal controls not ready yet', 'This session is still starting up. Try setting the goal again in a moment.');
    expect(modalAlert).not.toHaveBeenCalledWith('Goal unavailable', 'This backend does not support editable session goals yet.');
  });

  it('treats a remote-unavailable goal control as a not-ready state', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const modalAlert = vi.fn();
    const setSessionGoal = vi.fn(async () => ({
      ok: false as const,
      error: 'session_goal_control_remote_unavailable',
      errorCode: 'session_goal_control_remote_unavailable',
    }));

    await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'set', objective: 'migrate plugin support' } as any,
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal migrate plugin support',
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      setSessionGoal,
    } as any);

    expect(modalAlert).toHaveBeenCalledWith(
      'Goal controls not ready yet',
      'This session is still starting up. Try setting the goal again in a moment.',
    );
  });

  it('normalizes disabled goal feature failures to goal unavailable feedback', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const modalAlert = vi.fn();
    const setSessionGoal = vi.fn(async () => ({
      ok: false as const,
      error: 'goals feature is disabled',
    }));

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'set', objective: 'migrate plugin support' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal migrate plugin support',
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(modalAlert).toHaveBeenCalledWith('Goal unavailable', 'This backend does not support editable session goals yet.');
  });

  it('normalizes status-only goal failures without a current goal', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const modalAlert = vi.fn();
    const setSessionGoal = vi.fn(async () => ({
      ok: false as const,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    }));

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'pause' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal pause',
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(modalAlert).toHaveBeenCalledWith('No goal to update', 'Set a goal before pausing or resuming it.');
  });

  it('marks the native goal complete without sending text for /goal complete', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const setSessionGoal = vi.fn(async () => ({ ok: true as const }));
    const setMessage = vi.fn();
    const clearDraft = vi.fn();
    const trackMessageSent = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'goal', command: 'complete' } as any,
      sessionId: 's1',
      agentId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      actionExecutor: { execute: vi.fn() },
      previousMessage: '/goal complete',
      setMessage,
      clearDraft,
      trackMessageSent,
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      setSessionGoal,
    } as any);

    expect(handled).toBe(true);
    expect(setSessionGoal).toHaveBeenCalledWith('s1', { status: 'complete' });
    expect(setMessage).toHaveBeenCalledWith('');
    expect(clearDraft).toHaveBeenCalled();
    expect(trackMessageSent).not.toHaveBeenCalled();
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
    expect(draftArgs?.input?.permissionMode).toBe('read_only');
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
          permissionMode: 'read_only',
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
        permissionMode: 'read_only',
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
    const restoreDraft = vi.fn();
    const trackMessageSent = vi.fn();
    const clearTransientInputState = vi.fn();
    const clearSemanticDraftValues = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      clearTransientInputState,
      clearSemanticDraftValues,
      restoreDraft,
      trackMessageSent,
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.review Review this.',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(setMessage).toHaveBeenCalledWith('/h.review Review this.');
    expect(restoreDraft).toHaveBeenCalledWith('/h.review Review this.');
    expect(trackMessageSent).not.toHaveBeenCalled();
    expect(clearTransientInputState).not.toHaveBeenCalled();
    expect(clearSemanticDraftValues).not.toHaveBeenCalled();
  });

  it('restores a failed review.start through the owner-guarded snapshot coordinator when provided', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'boom', error: 'boom' })) };
    const setMessage = vi.fn();
    const restoreComposerSnapshot = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      restoreComposerSnapshot,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.review Review this.',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(setMessage).not.toHaveBeenCalledWith('/h.review Review this.');
    expect(restoreComposerSnapshot).toHaveBeenCalledWith({
      sessionId: 's1',
      text: '/h.review Review this.',
    });
  });

  it('restores a failed review.start only when the cleared composer is still empty', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'boom', error: 'boom' })) };
    const setMessage = vi.fn();
    const restoreComposerSnapshot = vi.fn();
    const restoreComposerSnapshotIfCurrentValueMatches = vi.fn(() => false);

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      restoreComposerSnapshot,
      restoreComposerSnapshotIfCurrentValueMatches,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.review Review this.',
    } as any);

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(restoreComposerSnapshotIfCurrentValueMatches).toHaveBeenCalledWith({
      sessionId: 's1',
      text: '/h.review Review this.',
    }, '');
    expect(restoreComposerSnapshot).not.toHaveBeenCalled();
    expect(setMessage).not.toHaveBeenCalledWith('/h.review Review this.');
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
    const restoreDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'default',
      actionExecutor,
      setMessage,
      clearDraft: vi.fn(),
      restoreDraft,
      trackMessageSent: vi.fn(),
      navigateToRuns: vi.fn(),
      modalAlert,
      previousMessage: '/h.review Review this.',
    });

    expect(handled).toBe(true);
    expect(setMessage).toHaveBeenCalledWith('');
    expect(setMessage).toHaveBeenCalledWith('/h.review Review this.');
    expect(restoreDraft).toHaveBeenCalledWith('/h.review Review this.');
    expect(modalAlert).toHaveBeenCalledWith('Error', 'backend_unavailable');
  });

  it('does not track a failed subagent action start as a sent message', async () => {
    const executeSessionComposerResolution = await loadSubject();
    const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'boom', error: 'boom' })) };
    const trackMessageSent = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'subagents.delegate.start', rest: 'Do the thing.' },
      sessionId: 's1',
      agentId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: null,
      actionExecutor,
      setMessage: vi.fn(),
      clearDraft: vi.fn(),
      trackMessageSent,
      navigateToRuns: vi.fn(),
      modalAlert: vi.fn(),
      previousMessage: '/h.delegate Do the thing.',
    });

    expect(handled).toBe(true);
    expect(trackMessageSent).not.toHaveBeenCalled();
  });

  it('defaults subagents.delegate.start permissionMode to workspace_write when executing', async () => {
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
        permissionMode: 'workspace_write',
      }),
      { defaultSessionId: 's1', surface: 'ui_slash_command', placement: 'slash_command' },
    );
    expect(trackMessageSent).toHaveBeenCalledTimes(1);
  });

  it('defaults subagents.delegate.start draft permissionMode to workspace_write when instructions are missing', async () => {
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
    expect(draftArgs?.input?.permissionMode).toBe('workspace_write');
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
    expect(draftArgs?.input?.permissionMode).toBe('read_only');

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
        permissionMode: 'read_only',
      }),
      { defaultSessionId: 's1', surface: 'ui_slash_command', placement: 'slash_command' },
    );
  });
});
