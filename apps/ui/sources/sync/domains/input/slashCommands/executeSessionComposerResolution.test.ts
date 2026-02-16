import { describe, expect, it, vi } from 'vitest';

import { executeSessionComposerResolution } from './executeSessionComposerResolution';

const createSessionActionDraft = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({
      createSessionActionDraft,
    }),
  },
}));

describe('executeSessionComposerResolution', () => {
  it('executes ui.voice_global.reset via the action executor and clears the composer', async () => {
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'ui.voice_global.reset', rest: '' },
      sessionId: 's1',
      agentId: 'claude',
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
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const modalAlert = vi.fn();
    const setMessage = vi.fn();
    const clearDraft = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: '   ' },
      sessionId: 's1',
      agentId: 'claude',
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
  });

  it('does not inject coderabbit-specific config into review.start drafts (generic input only)', async () => {
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { ok: true } })) };
    const setMessage = vi.fn();
    const clearDraft = vi.fn();
    createSessionActionDraft.mockClear();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: '   ' },
      sessionId: 's1',
      agentId: 'coderabbit',
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
          engineIds: ['coderabbit'],
        }),
      }),
    );
    const draftArgs = createSessionActionDraft.mock.calls[0]?.[1] as any;
    expect(draftArgs?.input?.engines).toBeUndefined();
  });

  it('executes review.start via the action executor', async () => {
    const actionExecutor = { execute: vi.fn(async () => ({ ok: true as const, result: { runId: 'r1' } })) };
    const clearDraft = vi.fn();
    const trackMessageSent = vi.fn();
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
      permissionMode: 'read_only',
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
        changeType: 'committed',
        base: { kind: 'none' },
      }),
      { defaultSessionId: 's1', surface: 'ui_slash_command', placement: 'slash_command' },
    );
  });

  it('restores the previous composer text when review.start fails', async () => {
    const actionExecutor = { execute: vi.fn(async () => ({ ok: false as const, errorCode: 'boom', error: 'boom' })) };
    const setMessage = vi.fn();

    const handled = await executeSessionComposerResolution({
      resolved: { kind: 'action', actionId: 'review.start', rest: 'Review this.' },
      sessionId: 's1',
      agentId: 'claude',
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
});
