import { describe, expect, it } from 'vitest';

import * as providerBackendModes from './providerBackendModes.js';
import {
  resolvePersistedProviderSessionBackendMode,
  resolveProviderSessionBackendMode,
} from './providerBackendModes.js';

describe('providerBackendModes', () => {
  it('defaults the configured Codex backend mode to appServer when no override is present', () => {
    expect(resolveProviderSessionBackendMode({
      agentId: 'codex',
      metadata: null,
      accountSettings: null,
    })).toBe('appServer');
  });

  it('does not expose the retired Codex-specific backend-mode wrapper', () => {
    expect('resolveCodexSessionBackendMode' in providerBackendModes).toBe(false);
  });

  it('resolves provider backend mode from generated session-control adapters', () => {
    expect(resolveProviderSessionBackendMode({
      agentId: 'opencode',
      metadata: null,
      accountSettings: { opencodeBackendMode: 'server' },
    })).toBe('server');
  });

  it('resolves Antigravity runtime mode from a persisted compatibility descriptor', () => {
    expect(resolveProviderSessionBackendMode({
      agentId: 'antigravity',
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'antigravity',
          provider: { runtimeMode: 'sdk', providerSessionId: 'localharness-session-1' },
        },
      },
      accountSettings: { antigravityRuntimeMode: 'cliPrint' },
    })).toBe('sdk');
  });

  it('projects persisted Codex compatibility shapes without applying the account default', () => {
    expect(resolvePersistedProviderSessionBackendMode({
      agentId: 'codex',
      metadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: { backendMode: 'mcp_resume' },
        },
      },
    })).toBe('acp');
    expect(resolvePersistedProviderSessionBackendMode({
      agentId: 'codex',
      metadata: null,
    })).toBeNull();
  });
});
