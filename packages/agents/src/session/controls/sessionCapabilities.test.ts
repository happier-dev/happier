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
        checkNow: 'supported',
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
        checkNow: 'supported',
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
        checkNow: 'supported',
      },
    });
  });

  it('resolves dot-path session capabilities through a shared helper', () => {
    expect(getAgentSessionCapability('codex', 'sessionListing')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'sessionFork.conversation')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'sessionFork.fromMessage')).toBe('unsupported');
    expect(getAgentSessionCapability('codex', 'sessionRollback.conversation')).toBe('supported');
    expect(getAgentSessionCapability('codex', 'usageLimitRecovery.checkNow')).toBe('supported');
    expect(getAgentSessionCapability('opencode', 'usageLimitRecovery.checkNow')).toBe('supported');
    expect(getAgentSessionCapability('claude', 'usageLimitRecovery.checkNow')).toBe('supported');
    expect(getAgentSessionCapability('gemini', 'usageLimitRecovery.checkNow')).toBe('supported');
    expect(getAgentSessionCapability('pi', 'usageLimitRecovery.checkNow')).toBe('supported');
  });

  it('provides a boolean helper for supported session capabilities', () => {
    expect(isAgentSessionCapabilitySupported('opencode', 'sessionFork.fromMessage')).toBe(true);
    expect(isAgentSessionCapabilitySupported('claude', 'sessionRollback.conversation')).toBe(false);
    expect(isAgentSessionCapabilitySupported('opencode', 'usageLimitRecovery.checkNow')).toBe(true);
    expect(isAgentSessionCapabilitySupported('claude', 'usageLimitRecovery.checkNow')).toBe(true);
    expect(isAgentSessionCapabilitySupported('gemini', 'usageLimitRecovery.checkNow')).toBe(true);
    expect(isAgentSessionCapabilitySupported('pi', 'usageLimitRecovery.checkNow')).toBe(true);
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
            providerId: 'codex',
            provider: { backendMode: 'appServer' },
          },
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

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'usageLimitRecovery.checkNow',
        metadata: { opencodeBackendMode: 'server' },
      }),
    ).toBe('supported');

    expect(
      evaluateAgentSessionCapabilitySupport({
        agentId: 'opencode',
        capability: 'usageLimitRecovery.checkNow',
        metadata: { opencodeBackendMode: 'acp' },
      }),
    ).toBe('unsupported');
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
