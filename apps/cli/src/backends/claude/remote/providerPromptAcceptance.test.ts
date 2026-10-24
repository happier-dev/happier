import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeRemotePromptSettlementTracker,
  readClaudeRemoteProviderPromptAcceptance,
} from './providerPromptAcceptance';

describe('readClaudeRemoteProviderPromptAcceptance', () => {
  it('preserves and dedupes Happier local ids by exact bytes', () => {
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'hello',
      mode: {} as never,
      maxUserMessageSeq: 7,
      userMessageLocalIds: ['local-1', ' local-1\n', 'local-1', '   '],
    })).toEqual({
      maxUserMessageSeq: 7,
      userMessageLocalIds: ['local-1', ' local-1\n'],
    });
  });

  it('captures the new-turn model but does not attribute an in-flight steer to it', () => {
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'new turn',
      mode: { model: 'claude-opus-4-6' } as never,
      userMessageLocalIds: ['new-turn-local'],
      pendingProviderAction: 'send',
    })).toMatchObject({
      appliedModelId: 'claude-opus-4-6',
    });
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'steer',
      mode: { model: 'claude-opus-4-6' } as never,
      userMessageLocalIds: ['steer-local'],
      pendingProviderAction: 'steer',
    })).not.toHaveProperty('appliedModelId');
  });
});

describe('createClaudeRemotePromptSettlementTracker', () => {
  it('accepts only the exact main-chain acknowledgment and leaves an unacknowledged send ambiguous', () => {
    const onAccepted = vi.fn();
    const onTransportFailure = vi.fn();
    const tracker = createClaudeRemotePromptSettlementTracker({ onAccepted, onTransportFailure });
    const first = { message: 'same text', mode: { permissionMode: 'default' as const }, userMessageLocalIds: ['first'] };
    const second = { message: 'same text', mode: { permissionMode: 'default' as const }, userMessageLocalIds: ['second'] };
    tracker.track(first);
    tracker.track(second);
    const firstUuid = tracker.submit(first);
    const secondUuid = tracker.submit(second);
    const echo = { type: 'user', uuid: firstUuid, parent_tool_use_id: null };
    expect(tracker.observeProviderMessage({ ...echo, uuid: 'historical' })).toBe(false);
    expect(tracker.observeProviderMessage({ ...echo, type: 'assistant' })).toBe(false);
    expect(tracker.observeProviderMessage({ ...echo, isSynthetic: true })).toBe(false);
    expect(tracker.observeProviderMessage({ ...echo, parent_tool_use_id: 'child' })).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(tracker.observeProviderMessage({ ...echo, uuid: secondUuid })).toBe(true);
    expect(tracker.observeProviderMessage({ ...echo, uuid: secondUuid })).toBe(false);
    tracker.settleUnresolved();
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ maxUserMessageSeq: null, userMessageLocalIds: ['second'] });
    expect(onTransportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: 'effect_may_have_occurred', maxUserMessageSeq: null, userMessageLocalIds: ['first'],
    });
  });

  it('rejects every claimed prompt that never reached the provider API boundary', () => {
    const onAccepted = vi.fn();
    const onTransportFailure = vi.fn();
    const tracker = createClaudeRemotePromptSettlementTracker({
      onAccepted,
      onTransportFailure,
    });
    const first = {
      message: 'preflight failure',
      mode: {} as never,
      userMessageLocalIds: ['preflight-local'],
    };
    const second = {
      message: 'another preflight failure',
      mode: {} as never,
      userMessageLocalIds: ['attempted-local'],
    };

    tracker.track(first);
    tracker.track(second);
    tracker.settleUnresolved();

    expect(onAccepted).not.toHaveBeenCalled();
    expect(onTransportFailure.mock.calls.map(([outcome]) => outcome)).toEqual([
      {
        kind: 'rejected_before_effect',
        maxUserMessageSeq: null,
        userMessageLocalIds: ['preflight-local'],
      },
      {
        kind: 'rejected_before_effect',
        maxUserMessageSeq: null,
        userMessageLocalIds: ['attempted-local'],
      },
    ]);
  });

  it('publishes one terminal outcome per tracked prompt', () => {
    const onAccepted = vi.fn();
    const onTransportFailure = vi.fn();
    const tracker = createClaudeRemotePromptSettlementTracker({
      onAccepted,
      onTransportFailure,
    });
    const prompt = {
      message: 'hello',
      mode: {} as never,
      maxUserMessageSeq: 8,
      userMessageLocalIds: ['local-8'],
    };

    tracker.track(prompt);
    tracker.accept(prompt);
    tracker.rejectBeforeEffect(prompt);
    tracker.settleUnresolved();

    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({
      maxUserMessageSeq: 8,
      userMessageLocalIds: ['local-8'],
    });
    expect(onTransportFailure).not.toHaveBeenCalled();
  });
});
