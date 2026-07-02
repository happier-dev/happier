import { describe, expect, it } from 'vitest';

import {
  resolveCodexSessionBackendMode,
  resolveProviderSessionBackendMode,
} from './providerBackendModes.js';

describe('providerBackendModes', () => {
  it('defaults the configured Codex backend mode to appServer when no override is present', () => {
    expect(resolveCodexSessionBackendMode({
      metadata: null,
      accountSettings: null,
    })).toBe('appServer');
  });

  it('resolves provider backend mode from generated session-control adapters', () => {
    expect(resolveProviderSessionBackendMode({
      agentId: 'opencode',
      metadata: null,
      accountSettings: { opencodeBackendMode: 'server' },
    })).toBe('server');
  });
});
