import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentCliManagedCommandPath } from '@/packagedRuntime/managedTools/agentCliResolution';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

const tempDirs = new Set<string>();

async function writeManagedExecutable(filePath: string, contents: string): Promise<void> {
  await writeExecutableShim({
    dir: dirname(filePath),
    fileName: basename(filePath),
    contents,
  });
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

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

  it('passes effective cwd and connected-service environment to daemon spawn prerequisites', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ cwd, directory, env }) => {
      expect(cwd).toBe('/repo');
      expect(directory).toBe('/repo');
      expect(env).toMatchObject({
        PROFILE_ONLY: 'profile-value',
        GEMINI_API_KEY: 'connected-key',
      });
      return { ok: true as const };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {
        PROFILE_ONLY: 'profile-value',
        GEMINI_API_KEY: 'profile-key',
      },
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { GEMINI_API_KEY: 'connected-key' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(true);
    expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
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

  it('fails closed before spawn when a built-in provider CLI is unavailable', async () => {
    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: expect.stringContaining('Qwen CLI (qwen) is not available'),
    }));
  });

  it('allows hookless built-in providers when their managed CLI is available', async () => {
    const happyHomeDir = await createTempDir('happier-spawn-managed-provider-', tmpdir());
    tempDirs.add(happyHomeDir);
    const managedQwenPath = resolveAgentCliManagedCommandPath('qwen', { happyHomeDir });
    await writeManagedExecutable(managedQwenPath, '#!/bin/sh\necho ok\n');

    const result = await resolveSpawnChildEnvironment({
      happyHomeDir,
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {
        HAPPIER_HOME_DIR: happyHomeDir,
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
  });

  it('uses the configured happy home when validating hookless managed provider CLIs', async () => {
    const happyHomeDir = await createTempDir('happier-spawn-managed-provider-home-', tmpdir());
    tempDirs.add(happyHomeDir);
    const managedQwenPath = resolveAgentCliManagedCommandPath('qwen', { happyHomeDir });
    await writeManagedExecutable(managedQwenPath, '#!/bin/sh\necho ok\n');

    const result = await resolveSpawnChildEnvironment({
      happyHomeDir,
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
  });

  it('uses profile-provided provider CLI overrides when validating hookless built-in providers', async () => {
    const root = await createTempDir('happier-spawn-profile-provider-', tmpdir());
    tempDirs.add(root);
    const qwenPath = await writeExecutableShim({
      dir: root,
      fileName: 'qwen',
      contents: '#!/bin/sh\necho ok\n',
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {
        HAPPIER_QWEN_PATH: qwenPath,
      },
      daemonSpawnHooks: null,
      processEnv: {
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
  });

  it('fails closed for invalid profile provider CLI overrides even when the daemon can resolve another CLI', async () => {
    const root = await createTempDir('happier-spawn-invalid-profile-provider-', tmpdir());
    tempDirs.add(root);
    await writeExecutableShim({
      dir: root,
      fileName: 'qwen',
      contents: '#!/bin/sh\necho ok\n',
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {
        HAPPIER_QWEN_PATH: `${root}/missing-qwen`,
      },
      daemonSpawnHooks: null,
      processEnv: {
        PATH: root,
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: expect.stringContaining('HAPPIER_QWEN_PATH is set but does not point'),
    }));
  });

  it('preserves connected-service cleanup and diagnostics when hookless provider CLI validation fails', async () => {
    const cleanupOnFailure = vi.fn();
    const cleanupOnExit = vi.fn();
    const diagnostics = [{
      code: 'connected_service_materialized',
      severity: 'info',
      message: 'connected service prepared',
    }] as const;

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      processEnv: {
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { SOME_CONNECTED_SERVICE_TOKEN: 'secret' },
        cleanupOnFailure,
        cleanupOnExit,
        diagnostics,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      cleanupOnFailure,
      cleanupOnExit,
      materializationDiagnostics: diagnostics,
    }));
  });

  it('still applies generic provider CLI validation when only spawn env augmentation is configured', async () => {
    const augmentEnv = vi.fn(() => ({ HAPPIER_QWEN_AUGMENTED: '1' }));

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        augmentEnv,
      },
      processEnv: {
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorMessage: expect.stringContaining('Qwen CLI (qwen) is not available'),
    }));
    expect(augmentEnv).not.toHaveBeenCalled();
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
          agentId: 'codex',
          agent: {
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
          agentId: 'codex',
          agent: {
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
          agentId: 'codex',
          agent: {
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
          agentId: 'codex',
          agent: {
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
        resolveRuntimePrerequisites: async () => ({ ok: true }),
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
