import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { assertBackendEnabledByAccountSettings } from './backendEnabled';

describe('assertBackendEnabledByAccountSettings', () => {
  it('does not throw when the backendEnabledByTargetKey map is missing', () => {
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: {},
    })).not.toThrow();
  });

  it('does not throw when the backend is enabled', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: { backendEnabledByTargetKey: { [targetKey]: true } },
    })).not.toThrow();
  });

  it('throws when the backend is disabled', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: { backendEnabledByTargetKey: { [targetKey]: false } },
    })).toThrow(/disabled/i);
  });

  it('throws when a configured ACP backend target is disabled', () => {
    const targetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    expect(() => assertBackendEnabledByAccountSettings({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      settings: { backendEnabledByTargetKey: { [targetKey]: false } },
    })).toThrow(/review-bot/i);
  });
});
