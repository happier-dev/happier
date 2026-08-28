import { describe, expect, it, vi } from 'vitest';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

function registryWithAgentAuthEnvironment(
  agentId: string,
  environmentVariables: readonly string[],
): ResolvedExecutablePluginRuntimeRegistry {
  return {
    contributes: {
      agentDefinitionsById: new Map([[agentId, {
        id: agentId,
        provenance: 'external',
        source: { kind: 'path' },
        definition: { id: agentId },
        cliMetadata: {
          executable: { binaryName: agentId, sourcePreference: 'system-first' },
          auth: { support: 'status_only', environmentVariables, loginLaunches: [] },
          install: { manual: { kind: 'command' }, managed: null },
        },
      }]]),
      activationTargets: Object.freeze([]),
      managedDependencies: Object.freeze([]),
    },
    hookHandlersByHookId: new Map(),
  } as unknown as ResolvedExecutablePluginRuntimeRegistry;
}

describe('resolveSpawnChildEnvironment (profile template expansion)', () => {
  it('keeps environment keys and values out of spawn diagnostics while preserving the child environment', async () => {
    const privateEnvironmentKey = 'PRIVATE_CUSTOMER_WORKSPACE_TOKEN';
    const privateEnvironmentValue = 'private-environment-value';
    const logDebug = vi.fn();
    const logInfo = vi.fn();
    const logWarn = vi.fn();

    const result = await resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        environmentVariables: {},
      },
      profileEnvironmentVariables: {
        [privateEnvironmentKey]: privateEnvironmentValue,
      },
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug,
      logInfo,
      logWarn,
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expandedEnvironmentVariables[privateEnvironmentKey]).toBe(
      privateEnvironmentValue,
    );
    const diagnostics = JSON.stringify({
      debug: logDebug.mock.calls,
      info: logInfo.mock.calls,
      warn: logWarn.mock.calls,
    });
    expect(diagnostics).not.toContain(privateEnvironmentKey);
    expect(diagnostics).not.toContain(privateEnvironmentValue);
  });

  it('keeps raw cleanup errors out of spawn diagnostics while rethrowing the original failure', async () => {
    const privateCleanupError = 'cleanup failed for /private/customer/worktree';
    const originalFailure = new Error('original spawn hook failure');
    const logWarn = vi.fn();

    await expect(resolveSpawnChildEnvironment({
      options: {
        directory: '.',
        environmentVariables: {},
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks: {
        augmentEnv: () => {
          throw originalFailure;
        },
      },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn,
      connectedServiceAuth: {
        env: {},
        cleanupOnFailure: () => {
          throw new Error(privateCleanupError);
        },
        cleanupOnExit: null,
      },
    })).rejects.toBe(originalFailure);

    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(privateCleanupError);
  });

  it('expands profile env templates from injected profile env', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        DEEPSEEK_AUTH_TOKEN: 'sk-test',
        ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_AUTH_TOKEN}',
      },
      daemonSpawnHooks: null,
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expandedEnvironmentVariables.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
  });

  it('fails closed when profile env references child-only daemon env injected after expansion', async () => {
    const options: SpawnSessionOptions = {
      directory: '.',
      environmentVariables: {},
    };

    const result = await resolveSpawnChildEnvironment({
      options,
      profileEnvironmentVariables: {
        ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_AUTH_TOKEN}',
      },
      daemonSpawnHooks: {
        augmentEnv: () => ({
          DEEPSEEK_AUTH_TOKEN: 'sk-child-only-secret',
        }),
      },
      resolvedAgentId: 'claude',
      pluginRuntimeRegistry: registryWithAgentAuthEnvironment('claude', [
        'ANTHROPIC_AUTH_TOKEN',
      ]),
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED);
    expect(result.errorMessage).toContain('ANTHROPIC_AUTH_TOKEN references ${DEEPSEEK_AUTH_TOKEN}');
  });

  it.each([
    ['claude', 'ANTHROPIC_API_KEY'],
    ['claude', 'ANTHROPIC_AUTH_TOKEN'],
    ['codex', 'CODEX_API_KEY'],
    ['codex', 'OPENAI_API_KEY'],
    ['acme.external-agent', 'ACME_API_KEY'],
  ])('refuses unresolved native credential key %s/%s from the selected Agent generation', async (
    agentId,
    environmentVariable,
  ) => {
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '.' },
      resolvedAgentId: agentId,
      pluginRuntimeRegistry: registryWithAgentAuthEnvironment(agentId, [environmentVariable]),
      profileEnvironmentVariables: { [environmentVariable]: '${MISSING_SECRET}' },
      daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.AUTH_ENV_UNEXPANDED,
    });
    if (result.ok) return;
    expect(result.errorMessage).toContain(`${environmentVariable} references \${MISSING_SECRET}`);
  });

  it('does not make a non-selected Agent credential declaration global', async () => {
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '.' },
      resolvedAgentId: 'claude',
      pluginRuntimeRegistry: registryWithAgentAuthEnvironment('claude', ['ANTHROPIC_API_KEY']),
      profileEnvironmentVariables: { CODEX_API_KEY: '${MISSING_CODEX_SECRET}' },
      daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.CODEX_API_KEY).toBe('${MISSING_CODEX_SECRET}');
  });

  it.each([
    ['replaces', 'resolved-by-provider'],
    ['unsets', null],
  ] as const)('%s a stale unresolved selected-Agent credential before final validation', async (
    _operation,
    providerValue,
  ) => {
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '.' },
      resolvedAgentId: 'claude',
      pluginRuntimeRegistry: registryWithAgentAuthEnvironment('claude', ['ANTHROPIC_API_KEY']),
      profileEnvironmentVariables: { ANTHROPIC_API_KEY: '${MISSING_SECRET}' },
      daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
      processEnv: {},
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      providerEnvironmentOverlay: [{
        name: 'ANTHROPIC_API_KEY',
        value: providerValue,
        source: 'provider',
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.ANTHROPIC_API_KEY).toBe(providerValue ?? undefined);
  });

  it('treats an exact Provider credential replacement as a literal rather than a profile template', async () => {
    const literalProviderCredential = 'token-with-${LITERAL_SEGMENT}';
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '.' },
      resolvedAgentId: 'claude',
      pluginRuntimeRegistry: registryWithAgentAuthEnvironment('claude', ['ANTHROPIC_API_KEY']),
      profileEnvironmentVariables: { ANTHROPIC_API_KEY: '${MISSING_SECRET}' },
      daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
      processEnv: { LITERAL_SEGMENT: 'must-not-replace-provider-bytes' },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: null,
      providerEnvironmentOverlay: [{
        name: 'ANTHROPIC_API_KEY',
        value: literalProviderCredential,
        source: 'provider',
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.ANTHROPIC_API_KEY).toBe(literalProviderCredential);
  });

  it('treats an exact Connected Account credential replacement as opaque material', async () => {
    const literalConnectedAccountCredential = 'token-with-${LITERAL_SEGMENT}';
    const result = await resolveSpawnChildEnvironment({
      options: { directory: '.' },
      resolvedAgentId: 'claude',
      pluginRuntimeRegistry: registryWithAgentAuthEnvironment('claude', ['ANTHROPIC_API_KEY']),
      profileEnvironmentVariables: { ANTHROPIC_API_KEY: '${MISSING_PROFILE_SECRET}' },
      daemonSpawnHooks: { resolveRuntimePrerequisites: async () => ({ ok: true }) },
      processEnv: { LITERAL_SEGMENT: 'must-not-replace-credential-bytes' },
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth: {
        env: { ANTHROPIC_API_KEY: literalConnectedAccountCredential },
        cleanupOnFailure: null,
        cleanupOnExit: null,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild.ANTHROPIC_API_KEY)
      .toBe(literalConnectedAccountCredential);
  });
});
