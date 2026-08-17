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
        provider: 'codex',
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
  it('names the two routes separately instead of collapsing them into one boolean', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
    })).toEqual({ native: false, replay: true });
  });

  it('offers Native only for the exact cutoff the Agent capability supports', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
    })).toEqual({ native: true, replay: false });
    // Codex app-server can fork the conversation but not from a message, so the
    // Native card must disappear at a message cutoff rather than be offered and
    // then rejected by the daemon.
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      replayEnabled: false,
    })).toEqual({ native: false, replay: false });
  });

  it('offers both routes when the Agent forks natively and Replay is enabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 5 },
      replayEnabled: true,
    })).toEqual({ native: true, replay: true });
  });

  it('offers nothing for a missing Session or an uncommitted cutoff', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'opencode', opencodeBackendMode: 'server' });
    expect(resolveSessionForkStrategyAvailability({
      session: null,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
    })).toEqual({ native: false, replay: false });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 0 },
      replayEnabled: true,
    })).toEqual({ native: false, replay: false });
  });
});
