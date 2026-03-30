import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../manifest.js';

import {
    evaluateAgentSessionCapabilitySupport,
    getAgentSessionCapability,
    isAgentSessionCapabilitySupported,
} from './sessionCapabilities.js';

describe('sessionCapabilities', () => {
  it('exposes shared session capability support levels in the agent manifest', () => {
    expect(AGENTS_CORE.claude.sessionCapabilities).toEqual({
      sessionListing: 'supported',
      sessionFork: {
        conversation: 'unsupported',
        fromMessage: 'unsupported',
      },
      sessionRollback: {
        conversation: 'unsupported',
      },
    });

    expect(AGENTS_CORE.codex.sessionCapabilities).toEqual({
      sessionListing: 'supported',
      sessionFork: {
        conversation: 'supported',
        fromMessage: 'unsupported',
      },
      sessionRollback: {
        conversation: 'supported',
      },
    });

    expect(AGENTS_CORE.opencode.sessionCapabilities).toEqual({
      sessionListing: 'supported',
      sessionFork: {
        conversation: 'supported',
        fromMessage: 'supported',
      },
      sessionRollback: {
        conversation: 'unsupported',
      },
    });
  });

  it('resolves dot-path session capabilities through a shared helper', () => {
    expect(getAgentSessionCapability('codex', 'sessionListing')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'sessionFork.conversation')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'sessionFork.fromMessage')).toBe('unsupported');
    expect(getAgentSessionCapability('codex', 'sessionRollback.conversation')).toBe('supported');
  });

  it('provides a boolean helper for supported session capabilities', () => {
    expect(isAgentSessionCapabilitySupported('opencode', 'sessionFork.fromMessage')).toBe(true);
    expect(isAgentSessionCapabilitySupported('claude', 'sessionRollback.conversation')).toBe(false);
  });

  it('downgrades codex conversation capabilities when the session is not app-server backed', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionFork.conversation',
        metadata: { codexSessionId: 'c1', codexBackendMode: 'mcp' },
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionRollback.conversation',
        metadata: {
          codexSessionId: 'c1',
          sessionConfigOptionsV1: { v: 1, provider: 'codex', updatedAt: 1, options: [] },
        },
      }),
    ).toBe('supported');
  });

  it('downgrades opencode fork-from-message to server-only sessions', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'sessionFork.fromMessage',
        metadata: { opencodeBackendMode: 'acp' },
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'sessionFork.conversation',
        metadata: { opencodeBackendMode: 'acp' },
      }),
    ).toBe('supported');
  });

  it('prefers the canonical opencode runtime descriptor over legacy backend metadata', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'sessionFork.fromMessage',
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'opencode',
            provider: { backendMode: 'server' },
          },
          opencodeBackendMode: 'acp',
        },
      }),
    ).toBe('supported');
  });
});
