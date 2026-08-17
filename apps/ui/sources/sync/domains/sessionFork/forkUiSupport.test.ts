import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

import {
  canForkConversation,
  canForkFromMessage,
  resolveSessionForkStrategyAvailability,
} from './forkUiSupport';

function makeSession(metadata: any): Session {
  return {
    id: 's1',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata,
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
  } as any;
}

describe('forkUiSupport', () => {
  it('allows fork-from-message when replay is enabled and message seq is present', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: true })).toBe(true);
  });

  it('allows fork-from-message when replay is disabled but OpenCode server backend is active', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false })).toBe(true);
  });

  it('does not allow fork-from-message for OpenCode ACP when replay is disabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'acp' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false })).toBe(false);
  });

  it('allows conversation fork for Codex app-server when replay is disabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(canForkConversation({ session, replayEnabled: false })).toBe(true);
  });

  it('allows conversation fork for older Codex app-server sessions that only have generic codex control metadata', () => {
    const session = makeSession({
      machineId: 'm1',
      flavor: 'codex',
      codexSessionId: 'thread_123',
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'codex',
        updatedAt: 1,
        options: [],
      },
    });
    expect(canForkConversation({ session, replayEnabled: false })).toBe(true);
  });

  it('does not allow fork-from-message for Codex app-server when replay is disabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false })).toBe(false);
  });

  it('allows fork conversation for OpenCode ACP when replay is disabled (ACP fork-latest)', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'acp' });
    expect(canForkConversation({ session, replayEnabled: false })).toBe(true);
  });

  it('returns false when replay is disabled and provider does not support native fork', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(canForkConversation({ session, replayEnabled: false })).toBe(false);
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false })).toBe(false);
  });
});

describe('resolveSessionForkStrategyAvailability', () => {
  it('reports native and replay separately instead of collapsing them into one boolean', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
    })).toEqual({ native: false, replay: true });
  });

  it('reports native for an Agent that can fork the conversation itself', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
    })).toEqual({ native: true, replay: false });
  });

  it('resolves the exact-message cutoff against the from-message capability, not the conversation one', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      replayEnabled: false,
    })).toEqual({ native: false, replay: false });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
    })).toEqual({ native: true, replay: false });
  });

  it('offers nothing for an unusable cutoff even when replay is enabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 0 },
      replayEnabled: true,
    })).toEqual({ native: false, replay: false });
  });

  it('withholds native for a Provider-bound Session whose Agent could otherwise fork natively', () => {
    // The daemon refuses every non-replay strategy for a Provider-bound Session
    // so authorization completes before any vendor fork side effect. Offering
    // the Native card would advertise an action that can only ever be refused.
    const session = makeSession({
      machineId: 'm1',
      flavor: 'codex',
      codexBackendMode: 'appServer',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
    })).toEqual({ native: false, replay: true });
    // Replay is still a real route, so the legacy predicate must stay true.
    expect(canForkConversation({ session, replayEnabled: true })).toBe(true);
  });

  it('keeps native for a Session whose model intent names no Provider connection', () => {
    const session = makeSession({
      machineId: 'm1',
      flavor: 'codex',
      codexBackendMode: 'appServer',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
      },
    });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
    })).toEqual({ native: true, replay: false });
  });

  it('offers nothing without a session', () => {
    expect(resolveSessionForkStrategyAvailability({
      session: null,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
    })).toEqual({ native: false, replay: false });
  });
});
