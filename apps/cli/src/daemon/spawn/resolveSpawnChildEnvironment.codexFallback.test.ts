import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentCliManagedCommandPath } from '@/packagedRuntime/managedTools/agentCliResolution';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';

const tempDirs = new Set<string>();
const emptyPluginRuntimeRegistry = Object.freeze({
  contributes: Object.freeze({ activationTargets: Object.freeze([]) }),
  hookHandlersByHookId: new Map(),
});

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
  it('passes the Codex runtime descriptor through generic Agent runtime selection', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ runtimeDescriptorV1, tools }) => {
      expect(runtimeDescriptorV1).toEqual({
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'acp' },
      });
      expect(tools.resolveManagedInstallable).toBeTypeOf('function');
      return { ok: true as const };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'acp' },
        },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv: ({ runtimeDescriptorV1 }) => ({
          ...(runtimeDescriptorV1?.agent.backendMode === 'acp' ? { HAPPIER_CODEX_BACKEND_MODE_CONFIRMED: 'acp' } : {}),
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
    const resolveRuntimePrerequisites = vi.fn(async ({ runtimeDescriptorV1 }) => {
      expect(runtimeDescriptorV1).toEqual({
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'acp' },
      });
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
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'acp' },
        },
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
      runtimePrerequisitesAlreadyResolved: true,
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
      runtimePrerequisitesAlreadyResolved: true,
      pluginRuntimeRegistry: emptyPluginRuntimeRegistry as never,
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
      runtimePrerequisitesAlreadyResolved: true,
      pluginRuntimeRegistry: emptyPluginRuntimeRegistry as never,
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

  it('retains the exact non-secret launch spec selected by a profile Agent CLI override', async () => {
    if (process.platform === 'win32') return;

    const root = await createTempDir('happier-spawn-profile-agent-cli-', tmpdir());
    tempDirs.add(root);
    const profileClaudePath = await writeExecutableShim({
      dir: root,
      fileName: 'claude-profile',
      contents: '#!/bin/sh\necho profile-claude\n',
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {
        HAPPIER_CLAUDE_PATH: profileClaudePath,
        PRIVATE_LAUNCH_SECRET: 'must-not-be-retained',
      },
      daemonSpawnHooks: null,
      processEnv: {
        HAPPIER_CLAUDE_PATH: process.execPath,
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    const launchSpec = (result as unknown as {
      agentCliLaunchSpec?: unknown;
    }).agentCliLaunchSpec;
    expect(launchSpec).toEqual({
      source: 'override',
      resolvedPath: profileClaudePath,
      command: profileClaudePath,
      args: [],
    });
  });

  it('keeps an invalid profile CLI override closed after earlier runtime prerequisites resolved', async () => {
    const root = await createTempDir('happier-spawn-invalid-profile-agent-cli-', tmpdir());
    tempDirs.add(root);
    const daemonClaudePath = await writeExecutableShim({
      dir: root,
      fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      contents: process.platform === 'win32'
        ? '@echo off\r\necho daemon-claude\r\n'
        : '#!/bin/sh\necho daemon-claude\n',
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      profileEnvironmentVariables: {
        HAPPIER_CLAUDE_PATH: `${root}/missing-claude`,
      },
      daemonSpawnHooks: null,
      processEnv: {
        HAPPIER_CLAUDE_PATH: daemonClaudePath,
        PATH: '',
      },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      runtimePrerequisitesAlreadyResolved: true,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: expect.stringContaining('HAPPIER_CLAUDE_PATH is set but does not point'),
    }));
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

  it('publishes the descriptor-selected provider backend mode', async () => {
    const resolveRuntimePrerequisites = vi.fn(async ({ runtimeDescriptorV1 }) => {
      expect(runtimeDescriptorV1).toEqual({
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      });
      return { ok: true as const };
    });

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites,
        augmentEnv: ({ runtimeDescriptorV1 }) => ({
          ...(runtimeDescriptorV1?.agent.backendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
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
    const resolveRuntimePrerequisites = vi.fn(async ({ runtimeDescriptorV1 }) => {
      expect(runtimeDescriptorV1).toEqual({
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'codex-session-1',
        },
      });
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
        augmentEnv: ({ runtimeDescriptorV1 }) => ({
          ...(runtimeDescriptorV1?.agent.backendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
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
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
      workspaceId: ' ws_payments ',
      workspaceLocationId: ' loc_local ',
      workspaceCheckoutId: ' checkout_feature_auth ',
    };
    const result = await resolveSpawnChildEnvironment({
      options: options as SpawnSessionOptions,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async () => ({ ok: true }),
        augmentEnv: ({ runtimeDescriptorV1 }) => ({
          ...(runtimeDescriptorV1?.agent.backendMode === 'appServer' ? { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } : {}),
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
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'acp' },
      },
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async ({ runtimeDescriptorV1 }) => {
          if (runtimeDescriptorV1?.agent.backendMode === 'acp') {
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
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'acp' },
        },
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
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'acp' },
        },
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        resolveRuntimePrerequisites: async ({ runtimeDescriptorV1 }) => {
          if (runtimeDescriptorV1?.agent.backendMode === 'acp') {
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
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'acp' },
      },
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
