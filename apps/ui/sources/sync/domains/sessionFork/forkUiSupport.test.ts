import { describe, expect, it } from 'vitest';

import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
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
        agentId: 'codex',
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
  it('uses a current external Agent declaration for native fork and not presentation backing', () => {
    const session = makeSession({
      machineId: 'm1',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'acme-lifecycle',
        agent: { providerSessionId: 'acme-session-1' },
      },
    });
    const currentAgentCapabilities: CurrentProjectedAgentCapabilities = {
      agentId: 'acme-lifecycle',
      identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
      generation: 42,
      capabilities: {
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
    };

    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
      agentSwitchingEnabled: false,
      currentAgentCapabilities,
    })).toEqual({ native: true, replay: false, configure: false, nativeUnavailableReason: null });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
      agentSwitchingEnabled: false,
    })).toEqual({
      native: false,
      replay: false,
      configure: false,
      nativeUnavailableReason: 'agent_unsupported',
    });
  });

  it('reports native and replay separately instead of collapsing them into one boolean', () => {
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

  it('reports native for an Agent that can fork the conversation itself', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
      agentSwitchingEnabled: false,
    })).toEqual({ native: true, replay: false, configure: false, nativeUnavailableReason: null });
  });

  it('resolves the exact-message cutoff against the from-message capability, not the conversation one', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'codex', codexBackendMode: 'appServer' });
    // Codex forks the whole conversation but not from a message, and the card
    // has to say exactly that rather than "this agent cannot fork".
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
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'latest' },
      replayEnabled: false,
      agentSwitchingEnabled: false,
    })).toEqual({ native: true, replay: false, configure: false, nativeUnavailableReason: null });
  });

  it('offers nothing for an unusable cutoff even when replay and switching are enabled', () => {
    const session = makeSession({ machineId: 'm1', flavor: 'claude' });
    expect(resolveSessionForkStrategyAvailability({
      session,
      forkPoint: { type: 'seq', upToSeqInclusive: 0 },
      replayEnabled: true,
      agentSwitchingEnabled: true,
    })).toEqual({
      native: false,
      replay: false,
      configure: false,
      nativeUnavailableReason: null,
    });
  });

  it('withholds native for a Provider-bound Session whose Agent could otherwise fork natively', () => {
    // The daemon refuses every non-replay strategy for a Provider-bound Session
    // so authorization completes before any vendor fork side effect. The card is
    // shown disabled with that exact reason rather than silently dropped.
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
      agentSwitchingEnabled: false,
    })).toEqual({
      native: false,
      replay: true,
      configure: false,
      nativeUnavailableReason: 'provider_bound',
    });
    // Replay is still a real route, so the legacy predicate must stay true.
    expect(canForkConversation({ session, replayEnabled: true, agentSwitchingEnabled: false })).toBe(true);
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
      agentSwitchingEnabled: false,
    })).toEqual({ native: true, replay: false, configure: false, nativeUnavailableReason: null });
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

  it('offers nothing without a session', () => {
    expect(resolveSessionForkStrategyAvailability({
      session: null,
      forkPoint: { type: 'latest' },
      replayEnabled: true,
      agentSwitchingEnabled: true,
    })).toEqual({
      native: false,
      replay: false,
      configure: false,
      nativeUnavailableReason: null,
    });
  });
});
