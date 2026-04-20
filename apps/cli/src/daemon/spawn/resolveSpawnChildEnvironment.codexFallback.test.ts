import { describe, expect, it, vi } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

describe('resolveSpawnChildEnvironment (codex ACP fallback)', () => {
  it('passes explicit codexBackendMode=acp through daemon spawn validation without shadowing the legacy flag', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ codexBackendMode }) => {
      expect(codexBackendMode).toBe('acp');
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
        augmentEnv: ({ codexBackendMode }) => ({
          ...(codexBackendMode === 'acp' ? { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
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
    expect(result.extraEnvForChild.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBe('1');
  });

  it('falls back from explicit codexBackendMode=acp to MCP without reintroducing the legacy flag', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ codexBackendMode }) => {
      if (codexBackendMode === 'acp') {
        return {
          ok: false as const,
          reasonCode: 'codex_acp_unavailable' as const,
          errorMessage: 'codex-acp is missing',
        };
      }

      expect(codexBackendMode).toBe('mcp');
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
        augmentEnv: ({ codexBackendMode }) => ({
          ...(codexBackendMode === 'mcp' ? { HAPPIER_CODEX_BACKEND_MODE_AFTER_FALLBACK: 'mcp' } : {}),
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

    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(2);
    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE).toBe('mcp');
    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE_AFTER_FALLBACK).toBe('mcp');
    expect(result.extraEnvForChild.HAPPIER_LEGACY_CODEX_ACP_SHADOW).toBeUndefined();
  });

  it('prefers explicit codexBackendMode=appServer over the legacy ACP experiment flag', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ codexBackendMode }) => {
      expect(codexBackendMode).toBe('appServer');
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
        augmentEnv: ({ codexBackendMode }) => ({
          ...(codexBackendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
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

  it('derives codex backend mode from runtimeDescriptorV1 when legacy fields are absent', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ codexBackendMode }) => {
      expect(codexBackendMode).toBe('appServer');
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
            vendorSessionId: 'codex-session-1',
          },
        },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
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

  it('canonicalizes legacy runtime descriptors before daemon spawn hooks observe runtime selection', async () => {
    const resolveRuntimePrerequisites = vi.fn(async (runtimeSelection) => {
      expect(runtimeSelection).toMatchObject({
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'legacy-thread',
          },
        },
      });
      expect(runtimeSelection).not.toHaveProperty('agentRuntimeDescriptorV1');
      return { ok: true as const };
    });
    const augmentEnv = vi.fn((runtimeSelection) => {
      expect(runtimeSelection).toMatchObject({
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'legacy-thread',
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
            vendorSessionId: 'legacy-thread',
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
      daemonSpawnHooks: null,
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

  it('falls back to MCP for new Codex sessions when ACP validation fails', async () => {
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
        resolveRuntimePrerequisites: async ({ codexBackendMode }) => {
          if (codexBackendMode === 'acp') {
            return { ok: false, reasonCode: 'codex_acp_unavailable' as const, errorMessage: 'codex-acp is missing' };
          }
          return { ok: true };
        },
        augmentEnv: ({ codexBackendMode }) => ({
          ...(codexBackendMode === 'acp' ? { HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' } : {}),
        }),
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraEnvForChild.HAPPIER_EXPERIMENTAL_CODEX_ACP).toBeUndefined();
    expect(result.extraEnvForChild.HAPPIER_CODEX_BACKEND_MODE).toBe('mcp');
    expect(logWarn).toHaveBeenCalled();
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

  it('sanitizes the fallback message passed to logs and child env', async () => {
    const logWarn = vi.fn();

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        experimentalCodexAcp: true,
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async ({ codexBackendMode }) => {
          if (codexBackendMode === 'acp') {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fallbackMessage = result.extraEnvForChild.HAPPIER_CODEX_ACP_FALLBACK_TO_MCP_MESSAGE;
    expect(fallbackMessage).toContain('Codex ACP could not start');
    expect(fallbackMessage).not.toContain('\n');
    expect(fallbackMessage).not.toContain('\r');
    expect(logWarn).toHaveBeenCalledWith(expect.not.stringContaining('\n'));
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
