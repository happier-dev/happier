import { describe, expect, it, vi } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (codex backend mode)', () => {
  it('passes explicit Codex backend mode through generic provider runtime selection', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ providerRuntimeSelection, tools }) => {
      expect(providerRuntimeSelection).toEqual({ codexBackendMode: 'acp' });
      expect(tools.resolveManagedInstallable).toBeTypeOf('function');
      return { ok: true as const };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        codexBackendMode: 'acp',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv: ({ providerRuntimeSelection }) => ({
          ...(providerRuntimeSelection?.codexBackendMode === 'acp' ? { HAPPIER_CODEX_BACKEND_MODE_CONFIRMED: 'acp' } : {}),
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
    expect(result.extraEnvForChild.HAPPIER_LEGACY_CODEX_ACP_SHADOW).toBeUndefined();
    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE_CONFIRMED).toBe('acp');
  });

  it('fails closed when provider runtime selection validation fails', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ providerRuntimeSelection }) => {
      expect(providerRuntimeSelection).toEqual({ codexBackendMode: 'acp' });
      return {
        ok: false as const,
        reasonCode: 'codex_acp_unavailable' as const,
        errorMessage: 'codex-acp is missing',
      };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        codexBackendMode: 'acp',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv: () => ({ HAPPIER_CODEX_BACKEND_MODE_AFTER_FALLBACK: 'mcp' }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: 'codex-acp is missing',
    }));
    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
  });

  it('prefers explicit provider backend mode over the legacy ACP experiment flag', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ providerRuntimeSelection }) => {
      expect(providerRuntimeSelection).toEqual({ codexBackendMode: 'appServer' });
      return { ok: true as const };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        experimentalCodexAcp: true,
        codexBackendMode: 'appServer',
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv: ({ providerRuntimeSelection }) => ({
          ...(providerRuntimeSelection?.codexBackendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE).toBe('appServer');
    expect(result.extraEnvForChild.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBeUndefined();
  });

  it('derives provider backend mode from runtimeDescriptorV1 when legacy fields are absent', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ providerRuntimeSelection }) => {
      expect(providerRuntimeSelection).toEqual({ codexBackendMode: 'appServer' });
      return { ok: true as const };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'codex-session-1',
          },
        },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv: ({ providerRuntimeSelection }) => ({
          ...(providerRuntimeSelection?.codexBackendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE).toBe('appServer');
  });

  it('canonicalizes legacy runtime descriptors before daemon spawn hooks observe generic runtime selection', async () => {
    const resolveRuntimePrerequisites = vi.fn(async (runtimeSelection) => {
      expect(runtimeSelection).toMatchObject({
        providerRuntimeSelection: { codexBackendMode: 'appServer' },
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'legacy-thread',
          },
        },
      });
      expect(runtimeSelection).not.toHaveProperty('agentRuntimeDescriptorV1');
      return { ok: true as const };
    });
    const augmentEnv = vi.fn((runtimeSelection) => {
      expect(runtimeSelection).toMatchObject({
        providerRuntimeSelection: { codexBackendMode: 'appServer' },
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'legacy-thread',
          },
        },
      });
      expect(runtimeSelection).not.toHaveProperty('agentRuntimeDescriptorV1');
      return { HAPPIER_RUNTIME_DESCRIPTOR_CANONICALIZED: '1' };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'legacy-thread',
          },
        },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv,
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
    expect(augmentEnv).toHaveBeenCalledTimes(1);
    expect(result.extraEnvForChild.HAPPIER_RUNTIME_DESCRIPTOR_CANONICALIZED).toBe('1');
  });

  it('publishes explicit Codex backend mode into child env without workspace linkage metadata', async () => {
    const options = {
      directory: '.',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const,
      codexBackendMode: 'appServer' as const,
      workspaceId: ' ws_payments ',
      workspaceLocationId: ' loc_local ',
      workspaceCheckoutId: ' checkout_feature_auth ',
    };
    const result = await resolveSpawnChildEnvironment({
      options: options as SpawnSessionOptions,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        augmentEnv: ({ providerRuntimeSelection }) => ({
          ...(providerRuntimeSelection?.codexBackendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE).toBe('appServer');
    expect(result.extraEnvForChild.HAPPIER_SESSION_WORKSPACE_CONTEXT_JSON).toBeUndefined();
  });

  it('fails closed for new Codex sessions when ACP validation fails', async () => {
    const logWarn = vi.fn();

    const options: SpawnSessionOptions = {
      directory: '.',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      experimentalCodexAcp: true,
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async ({ providerRuntimeSelection }) => {
          if (providerRuntimeSelection?.codexBackendMode === 'acp') {
            return { ok: false, reasonCode: 'codex_acp_unavailable' as const, errorMessage: 'codex-acp is missing' };
          }
          return { ok: true };
        },
        augmentEnv: () => ({ HAPPIER_CODEX_BACKEND_MODE_CONFIRMED: 'acp' }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: 'codex-acp is missing',
    }));
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('does not fall back for unrelated Codex validation failures', async () => {
    const logWarn = vi.fn();

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        experimentalCodexAcp: true,
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async () => ({
          ok: false,
          reasonCode: 'other_validation_failure',
          errorMessage: 'workspace setup failed',
        } as const),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: 'workspace setup failed',
    }));
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('does not publish the retired ACP-to-MCP fallback child env', async () => {
    const logWarn = vi.fn();

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        experimentalCodexAcp: true,
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async ({ providerRuntimeSelection }) => {
          if (providerRuntimeSelection?.codexBackendMode === 'acp') {
            return {
              ok: false,
              reasonCode: 'codex_acp_unavailable',
              errorMessage: 'codex-acp is missing\nDETAIL: /tmp/secret-token',
            } as const;
          }
          return { ok: true };
        },
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: 'codex-acp is missing\nDETAIL: /tmp/secret-token',
    }));
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('does not fall back when an explicit resume id is provided', async () => {
    const logWarn = vi.fn();

    const options: SpawnSessionOptions = {
      directory: '.',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      resume: 'x1',
      experimentalCodexAcp: true,
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async () => ({ ok: false, errorMessage: 'codex-acp is missing' }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(false);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
