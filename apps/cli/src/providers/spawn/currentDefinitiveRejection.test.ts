import { describe, expect, it, vi } from 'vitest';

import { resolveCurrentProviderSpawnDefinitiveRejection } from './currentDefinitiveRejection';

describe('resolveCurrentProviderSpawnDefinitiveRejection', () => {
  it.each([
    ['a static-only native model outside its catalog', 'qwen', { modelId: 'not-a-qwen' }],
    ['a mode for an Agent with no mode surface', 'gemini', { acpSessionModeId: 'plan' }],
    ['a malformed config-option override shape', 'codex', { sessionConfigOptionOverrides: { v: 0 } }],
  ] as const)('rejects %s without reading the Account or acquiring a plugin lease', async (_label, agentId, selection) => {
    const getActiveAccountSettingsSnapshot = vi.fn(() => null);
    const tryAcquireAuthoritativePluginRuntimeRegistryLease = vi.fn(() => {
      throw new Error('a deterministic native rejection must not acquire a runtime lease');
    });

    await expect(resolveCurrentProviderSpawnDefinitiveRejection({
      agentTargetKey: `backend:${agentId}`,
      agentId,
      selection,
      deps: {
        getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshot as never,
        tryAcquireAuthoritativePluginRuntimeRegistryLease:
          tryAcquireAuthoritativePluginRuntimeRegistryLease as never,
      },
    })).resolves.toEqual({ ok: false });

    expect(getActiveAccountSettingsSnapshot).not.toHaveBeenCalled();
    expect(tryAcquireAuthoritativePluginRuntimeRegistryLease).not.toHaveBeenCalled();
  });

  it.each([
    ['the native default model', 'qwen', { modelId: 'default' }],
    ['a dynamic native model that cannot be known locally', 'codex', { modelId: 'future-model' }],
  ] as const)('keeps %s eligible for the ordinary launch owner', async (_label, agentId, selection) => {
    const result = await resolveCurrentProviderSpawnDefinitiveRejection({
      agentTargetKey: `backend:${agentId}`,
      agentId,
      selection,
      deps: {
        getActiveAccountSettingsSnapshot: (() => null) as never,
        tryAcquireAuthoritativePluginRuntimeRegistryLease: (() => null) as never,
      },
    });

    expect(result).toMatchObject({ ok: true });
  });
});
