import { describe, expect, it } from 'vitest';

import {
  resolveCodexSessionBackendMode,
  resolveOpenCodeSessionBackendMode,
} from './providerBackendModes.js';

describe('providerBackendModes', () => {
  it('defaults the configured Codex backend mode to appServer when no override is present', () => {
    expect(resolveCodexSessionBackendMode({
      metadata: null,
      accountSettings: null,
    })).toBe('appServer');
  });

  it('resolves OpenCode backend mode from account settings', () => {
    expect(resolveOpenCodeSessionBackendMode({
      metadata: null,
      accountSettings: { opencodeBackendMode: 'server' },
    })).toBe('server');
  });
});
