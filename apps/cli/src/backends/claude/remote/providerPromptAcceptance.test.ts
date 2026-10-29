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

  it('does not infer a running model from requested prompt settings', () => {
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'new turn',
      mode: { model: 'claude-opus-4-6' } as never,
      userMessageLocalIds: ['new-turn-local'],
      pendingProviderAction: 'send',
    })).not.toHaveProperty('appliedModelId');
    expect(readClaudeRemoteProviderPromptAcceptance({
      message: 'steer',
      mode: { model: 'claude-opus-4-6' } as never,
      userMessageLocalIds: ['steer-local'],
      pendingProviderAction: 'steer',
    })).not.toHaveProperty('appliedModelId');
  });
});

describe('createClaudeRemotePromptSettlementTracker', () => {
  it('retains unanswered steers, tolerates truncated attribution, and fences the next submission from late results', () => {
    const tracker = createClaudeRemotePromptSettlementTracker({});
    const submit = (message: string) => {
      const prompt = { message, mode: {} as never };
      tracker.track(prompt);
      return tracker.submit(prompt);
    };
    // Claude's result list has at most 64 UUIDs; do not treat it as an exhaustive queue snapshot.
    const uuids = Array.from({ length: 65 }, (_, i) => submit(`steer ${i}`));
    expect(tracker.shouldRetainForegroundForResult({
      type: 'result', user_message_uuids: uuids.slice(1), queued_turn_count: 1,
    })).toBe(true);
    // The latest submitted prompt has an outcome. Preserve the existing empty-queue closeout
    // for older IDs omitted from that list, without claiming their delivery was acknowledged.
    expect(tracker.shouldRetainForegroundForResult({
      type: 'result', user_message_uuid: 'other-native-send', queued_turn_count: 0,
    })).toBe(false);
    const next = submit('next prompt');
    expect(tracker.shouldRetainForegroundForResult({
      type: 'result', user_message_uuid: uuids[64], queued_turn_count: 0,
    })).toBe(true);
    expect(tracker.shouldRetainForegroundForResult({
      type: 'result', user_message_uuid: next, queued_turn_count: 1,
    })).toBe(false);
    submit('older-native prompt');
    expect(tracker.shouldRetainForegroundForResult({ type: 'result', queued_turn_count: 0 })).toBe(false);
    const following = submit('following prompt');
    expect(tracker.shouldRetainForegroundForResult({
      type: 'result', user_message_uuid: following, queued_turn_count: 1,
    })).toBe(false);
  });

  it('acknowledges only submitted UUIDs consumed by a result, without confusing idle or backlog with delivery', () => {
    const onAccepted = vi.fn();
    const onTransportFailure = vi.fn();
    const tracker = createClaudeRemotePromptSettlementTracker({ onAccepted, onTransportFailure });
    const prompts = ['first', 'second', 'unanswered'].map((id) => ({
      message: id, mode: {} as never, userMessageLocalIds: [id],
    }));
    const uuids = prompts.map((prompt) => {
      tracker.track(prompt);
      return tracker.submit(prompt);
    });
    expect(tracker.observeProviderMessage({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toBe(false);
    expect(tracker.observeProviderMessage({ type: 'result', user_message_uuid: 'foreign' })).toBe(false);
    expect(tracker.observeProviderMessage({ type: 'result', parent_tool_use_id: 'child', user_message_uuid: uuids[0] })).toBe(false);
    expect(onAccepted).not.toHaveBeenCalled();
    const result = { type: 'result', user_message_uuids: ['foreign', uuids[0], uuids[1]], queued_turn_count: 1 };
    expect(tracker.observeProviderMessage(result)).toBe(false);
    expect(tracker.observeProviderMessage(result)).toBe(false);
    tracker.settleUnresolved();
    expect(onAccepted.mock.calls.map(([accepted]) => accepted.userMessageLocalIds)).toEqual([['first'], ['second']]);
    expect(onTransportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: 'effect_may_have_occurred', maxUserMessageSeq: null, userMessageLocalIds: ['unanswered'],
    });
  });

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
