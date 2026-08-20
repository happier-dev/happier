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
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: true, agentSwitchingEnabled: false })).toBe(true);
  });

  it('allows fork-from-message when replay is disabled but OpenCode server backend is active', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false, agentSwitchingEnabled: false })).toBe(true);
  });

  it('does not allow fork-from-message for OpenCode ACP when replay and switching are both off', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'acp' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false, agentSwitchingEnabled: false })).toBe(false);
  });

  it('allows conversation fork for Codex app-server when replay is disabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(canForkConversation({ session, replayEnabled: false, agentSwitchingEnabled: false })).toBe(true);
  });

  it('allows conversation fork for older Codex app-server sessions that only have generic codex control metadata', () => {
    const session = makeSession({
      machineId: 'm1',
      flavor: 'codex',
      codexSessionId: 'thread_123',
      sessionConfigOptionsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        options: [],
      },
    });
    expect(canForkConversation({ session, replayEnabled: false, agentSwitchingEnabled: false })).toBe(true);
  });

  it('does not allow fork-from-message for Codex app-server when replay and switching are both off', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false, agentSwitchingEnabled: false })).toBe(false);
  });

  it('allows fork conversation for OpenCode ACP when replay is disabled (ACP fork-latest)', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'acp' });
    expect(canForkConversation({ session, replayEnabled: false, agentSwitchingEnabled: false })).toBe(true);
  });

  it('returns false only when no route at all is offerable', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(canForkConversation({ session, replayEnabled: false, agentSwitchingEnabled: false })).toBe(false);
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false, agentSwitchingEnabled: false })).toBe(false);
  });

  it('keeps the fork affordance for an Agent with no native fork and Replay off, because Configure is still a route', () => {
    // The exact Claude-shaped case that lost every entry point: the affordance
    // must survive so the modal can open and explain why Native is closed.
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(canForkConversation({ session, replayEnabled: false, agentSwitchingEnabled: true })).toBe(true);
    expect(canForkFromMessage({ session, messageSeq: 5, replayEnabled: false, agentSwitchingEnabled: true })).toBe(true);
  });
});

describe('resolveSessionForkStrategyAvailability', () => {
  it('names the two routes separately instead of collapsing them into one boolean', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
      agentSwitchingEnabled: false,
    })).toEqual({
      native: false,
      replay: true,
      configure: false,
      nativeUnavailableReason: 'agent_unsupported',
    });
  });

  it('offers Native only for the exact cutoff the Agent capability supports', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
      agentSwitchingEnabled: false,
    })).toEqual({ native: true, replay: false, configure: false, nativeUnavailableReason: null });
    // Codex app-server can fork the conversation but not from a message, so the
    // Native card is shown disabled at a message cutoff, saying exactly that,
    // rather than being offered and then rejected by the daemon — or omitted,
    // which taught the reader nothing.
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      replayEnabled: false,
      agentSwitchingEnabled: false,
    })).toEqual({
      native: false,
      replay: false,
      configure: false,
      nativeUnavailableReason: 'agent_conversation_only',
    });
  });

  it('offers both routes when the Agent forks natively and Replay is enabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      replayEnabled: true,
      agentSwitchingEnabled: false,
    })).toEqual({ native: true, replay: true, configure: false, nativeUnavailableReason: null });
  });

  it('offers Configure as its own route, so a Claude Session with Replay off still has one', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
      agentSwitchingEnabled: true,
    })).toEqual({
      native: false,
      replay: false,
      configure: true,
      nativeUnavailableReason: 'agent_unsupported',
    });
  });

  it('offers nothing for a missing Session or an uncommitted cutoff', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' });
    expect(resolveSessionForkStrategyAvailability({
      session: null,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
      agentSwitchingEnabled: true,
    })).toEqual({ native: false, replay: false, configure: false, nativeUnavailableReason: null });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 0 },
      replayEnabled: true,
      agentSwitchingEnabled: true,
    })).toEqual({ native: false, replay: false, configure: false, nativeUnavailableReason: null });
  });
});
