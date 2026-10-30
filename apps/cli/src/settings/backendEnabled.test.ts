import { describe, expect, it } from 'vitest';
import { buildBackendTargetKey, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { assertBackendEnabledByAccountSettings, resolveBackendDisabledSpawnError } from './backendEnabled';

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

describe('resolveBackendDisabledSpawnError', () => {
  it('returns a BACKEND_DISABLED spawn error for an explicitly disabled backend target', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    const result = resolveBackendDisabledSpawnError({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      settings: { backendEnabledByTargetKey: { [targetKey]: false } },
    });
    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.BACKEND_DISABLED,
      errorMessage: expect.stringContaining('codex'),
    });
  });

  it('names the configured ACP backend id in the spawn error', () => {
    const targetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    const result = resolveBackendDisabledSpawnError({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      settings: { backendEnabledByTargetKey: { [targetKey]: false } },
    });
    expect(result?.errorMessage).toContain('review-bot');
  });

  it('returns null for enabled backends, missing settings, or absent targets', () => {
    const disabledKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    expect(resolveBackendDisabledSpawnError({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      settings: { backendEnabledByTargetKey: { [disabledKey]: true } },
    })).toBeNull();
    expect(resolveBackendDisabledSpawnError({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      settings: {},
    })).toBeNull();
    expect(resolveBackendDisabledSpawnError({
      backendTarget: undefined,
      settings: { backendEnabledByTargetKey: { [disabledKey]: false } },
    })).toBeNull();
    expect(resolveBackendDisabledSpawnError({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      settings: undefined,
    })).toBeNull();
  });
});
