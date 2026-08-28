import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../../manifest.js';

import {
    evaluateAgentSessionCapabilitySupport,
    getAgentSessionCapability,
    readRuntimeCapabilitiesForSession,
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
      usageLimitRecovery: {
        checkNow: 'unsupported',
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
      usageLimitRecovery: {
        checkNow: 'supported',
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
      usageLimitRecovery: {
        checkNow: 'unsupported',
      },
    });

    expect(AGENTS_CORE.pi.sessionCapabilities).toEqual({
      sessionListing: 'unsupported',
      sessionFork: {
        conversation: 'unsupported',
        fromMessage: 'unsupported',
      },
      sessionRollback: {
        conversation: 'unsupported',
      },
      usageLimitRecovery: {
        checkNow: 'unsupported',
      },
    });
  });

  it('resolves dot-path session capabilities through a shared helper', () => {
    expect(getAgentSessionCapability('codex', 'sessionListing')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'sessionFork.conversation')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'sessionFork.fromMessage')).toBe('unsupported');
    expect(getAgentSessionCapability('codex', 'sessionRollback.conversation')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'usageLimitRecovery.checkNow')).toBe('supported');
    expect(getAgentSessionCapability('opencode', 'usageLimitRecovery.checkNow')).toBe('unsupported');
    expect(getAgentSessionCapability('claude', 'usageLimitRecovery.checkNow')).toBe('unsupported');
    expect(getAgentSessionCapability('gemini', 'usageLimitRecovery.checkNow')).toBe('unsupported');
    expect(getAgentSessionCapability('pi', 'usageLimitRecovery.checkNow')).toBe('unsupported');
  });

  it('provides a boolean helper for supported session capabilities', () => {
    expect(isAgentSessionCapabilitySupported('opencode', 'sessionFork.fromMessage')).toBe(true);
    expect(isAgentSessionCapabilitySupported('claude', 'sessionRollback.conversation')).toBe(false);
    expect(isAgentSessionCapabilitySupported('opencode', 'usageLimitRecovery.checkNow')).toBe(false);
    expect(isAgentSessionCapabilitySupported('claude', 'usageLimitRecovery.checkNow')).toBe(false);
    expect(isAgentSessionCapabilitySupported('gemini', 'usageLimitRecovery.checkNow')).toBe(false);
    expect(isAgentSessionCapabilitySupported('pi', 'usageLimitRecovery.checkNow')).toBe(false);
  });

  it('uses released flat compatibility but fails closed for opaque current descriptors', () => {
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
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'mcp' },
          },
        },
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionRollback.conversation',
        metadata: {
          codexSessionId: 'c1',
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'acp' },
          },
        },
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionRollback.conversation',
        metadata: {
          codexSessionId: 'c1',
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'appServer' },
          },
        },
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

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'usageLimitRecovery.checkNow',
        metadata: { codexSessionId: 'c1', codexBackendMode: 'mcp' },
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'usageLimitRecovery.checkNow',
        metadata: {
          codexSessionId: 'c1',
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'appServer' },
          },
        },
      }),
    ).toBe('unsupported');
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

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'usageLimitRecovery.checkNow',
        metadata: { opencodeBackendMode: 'server' },
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'usageLimitRecovery.checkNow',
        metadata: { opencodeBackendMode: 'acp' },
      }),
    ).toBe('unsupported');
  });

  it('uses public runtime capability publication for external Agents and their declaration as fallback', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'acme.agent',
        capability: 'sessionFork.fromMessage',
        metadata: {
          agentRuntimeCapabilitiesV1: {
            sessionCapabilities: {
              sessionFork: {
                conversation: 'supported',
                fromMessage: 'unsupported',
              },
            },
          },
        },
        declaredSupport: 'supported',
      }),
    ).toBe('unsupported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'acme.agent',
        capability: 'sessionFork.conversation',
        metadata: {},
        declaredSupport: 'supported',
      }),
    ).toBe('supported');
  });

  it('uses the same live capability publication ahead of bundled fallback policy', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionFork.conversation',
        metadata: {
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: { privatelyNamedRuntimeMode: 'future-mode' },
          },
          agentRuntimeCapabilitiesV1: {
            sessionCapabilities: {
              sessionFork: {
                conversation: 'supported',
              },
            },
          },
        },
      }),
    ).toBe('supported');
  });

  it('uses an exact projected declaration ahead of the bundled compatibility resolver', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionFork.fromMessage',
        metadata: {},
        declaredSupport: 'unsupported',
      }),
    ).toBe('unsupported');
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'codex',
        capability: 'sessionFork.fromMessage',
        metadata: {},
        declaredSupport: 'supported',
      }),
    ).toBe('supported');
  });

  it('does not let a live runtime snapshot override definition-owned usage recovery', () => {
    const metadata = (checkNow: 'supported' | 'unsupported') => ({
      agentRuntimeCapabilitiesV1: {
        sessionCapabilities: {
          usageLimitRecovery: { checkNow },
        },
      },
    });
    expect(evaluateAgentSessionCapabilitySupport({
      agentId: 'codex',
      capability: 'usageLimitRecovery.checkNow',
      metadata: metadata('unsupported'),
      declaredSupport: 'supported',
    })).toBe('supported');
    expect(evaluateAgentSessionCapabilitySupport({
      agentId: 'claude',
      capability: 'usageLimitRecovery.checkNow',
      metadata: metadata('supported'),
      declaredSupport: 'unsupported',
    })).toBe('unsupported');
  });

  it('does not let legacy metadata override an opaque current OpenCode descriptor', () => {
    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'sessionFork.fromMessage',
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: { backendMode: 'server' },
          },
          opencodeBackendMode: 'acp',
        },
      }),
    ).toBe('unsupported');
  });

  it('exposes normalized runtime capabilities for session-level runtime facts', () => {
    expect(
      readRuntimeCapabilitiesForSession({
        agentId: 'opencode',
        metadata: { opencodeBackendMode: 'acp' },
      }),
    ).toMatchObject({
      sessionStorage: { direct: false, persisted: true },
      sessionCapabilities: {
        sessionFork: { conversation: 'supported', fromMessage: 'unsupported' },
      },
      localControl: null,
      tools: { delivery: 'native_mcp', support: 'supported' },
      handoff: { vendorStateTransfer: 'supported' },
      executionRun: null,
    });
  });
});
