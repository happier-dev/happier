import { describe, expect, it } from 'vitest';

import {
  buildThreadConfigOverrideParams,
  buildThreadServiceTierParams,
  readCodexTurnStatus,
  readProviderEventTurnId,
  readServiceTier,
  readThreadId,
} from './fields.js';

describe('Codex app-server wire fields', () => {
  it('reads thread ids from top-level and nested app-server responses', () => {
    expect(readThreadId({ threadId: ' thread-1 ' })).toBe('thread-1');
    expect(readThreadId({ thread: { id: 'thread-2' } })).toBe('thread-2');
    expect(readThreadId({ thread: { threadId: 'thread-3' } })).toBe('thread-3');
    expect(readThreadId({ id: '   ' })).toBeNull();
  });

  it('requires lifecycle callers to opt in before treating top-level ids as provider turn ids', () => {
    expect(readProviderEventTurnId({
      threadId: 'thread-1',
      id: 'turn-1',
    })).toBeNull();

    expect(readProviderEventTurnId({
      threadId: 'thread-1',
      id: 'turn-1',
    }, { allowTopLevelId: true })).toBe('turn-1');

    expect(readProviderEventTurnId({
      threadId: 'thread-1',
      id: 'cmd-1',
      type: 'commandExecution',
      turn: { id: 'turn-1' },
    })).toBe('turn-1');

    expect(readProviderEventTurnId({
      threadId: 'thread-1',
      id: 'cmd-1',
      type: 'commandExecution',
    })).toBeNull();

    expect(readProviderEventTurnId({
      item: {
        id: 'fc_1',
        type: 'function_call',
        internal_chat_message_metadata_passthrough: {
          turn_id: 'turn-from-item-metadata',
        },
      },
    })).toBe('turn-from-item-metadata');

    expect(readProviderEventTurnId({
      type: 'function_call_output',
      call_id: 'call_1',
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn-from-record-metadata',
      },
    })).toBe('turn-from-record-metadata');
  });

  it('reads nested and top-level lifecycle statuses', () => {
    expect(readCodexTurnStatus({ turn: { status: 'failed' } })).toBe('failed');
    expect(readCodexTurnStatus({ status: 'interrupted' })).toBe('interrupted');
  });

  it('normalizes Codex Fast service-tier aliases at the wire boundary', () => {
    expect(readServiceTier({ serviceTier: 'priority' })).toBe('fast');
    expect(readServiceTier({ service_tier: 'fast' })).toBe('fast');
    expect(readServiceTier({ serviceTier: 'standard' })).toBe('standard');
  });

  it('builds Codex thread start/load override fields only when requested', () => {
    expect(buildThreadServiceTierParams('fast', true)).toEqual({ serviceTier: 'fast' });
    expect(buildThreadServiceTierParams('standard', true)).toEqual({ serviceTier: null });
    expect(buildThreadServiceTierParams('fast', false)).toEqual({});
    expect(buildThreadConfigOverrideParams('high')).toEqual({
      config: { model_reasoning_effort: 'high' },
    });
    expect(buildThreadConfigOverrideParams(null)).toEqual({});
  });
});
