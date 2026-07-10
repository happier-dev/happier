import { describe, expect, it } from 'vitest';

import * as providerBackendModes from './providerBackendModes.js';
import { resolveProviderSessionBackendMode } from './providerBackendModes.js';

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
});
