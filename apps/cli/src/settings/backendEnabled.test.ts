import { describe, expect, it } from 'vitest';

import { assertBackendEnabledByAccountSettings } from './backendEnabled';

describe('assertBackendEnabledByAccountSettings', () => {
  it('does not throw when the backendEnabledById map is missing', () => {
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: {},
    })).not.toThrow();
  });

  it('does not throw when the backend is enabled', () => {
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: { backendEnabledById: { codex: true } },
    })).not.toThrow();
  });

  it('throws when the backend is disabled', () => {
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: { backendEnabledById: { codex: false } },
    })).toThrow(/disabled/i);
  });
});

