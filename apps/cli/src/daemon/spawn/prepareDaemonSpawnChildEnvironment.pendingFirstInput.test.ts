import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY } from './pendingFirstInput';
import { HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY } from './persistedTakeoverAdmission';
import { prepareDaemonSpawnChildEnvironment } from './prepareDaemonSpawnChildEnvironment';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

vi.mock('./resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: vi.fn(),
}));

// The low-level resolver is mocked; this fixture only proves registry identity crosses the wrapper.
const pluginRuntimeRegistry = Object.freeze({}) as unknown as ResolvedExecutablePluginRuntimeRegistry;

describe('prepareDaemonSpawnChildEnvironment pending first input', () => {
  beforeEach(() => {
    vi.mocked(resolveSpawnChildEnvironment).mockReset();
  });

  it('carries the exact input only in the live child environment', async () => {
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValue({
      ok: true,
      expandedEnvironmentVariables: { SAFE_PROFILE_VALUE: 'profile' },
      extraEnvForChild: {
        SAFE_CHILD_VALUE: 'child',
        [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: 'ambient-value-must-not-win',
      },
      providerEnvKeys: [],
      cleanupOnFailure: null,
      cleanupOnExit: null,
    });

    const result = await prepareDaemonSpawnChildEnvironment({
      effectiveModelSelection: undefined,
      options: {
        directory: '/tmp/repo',
        spawnNonce: 'attempt-1',
        pendingFirstInput: {
          text: '  exact first input\n',
          localId: ' spawn-first-turn:attempt-1 ',
        },
      },
      terminal: undefined,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      pluginRuntimeRegistry,
      processEnv: {},
      connectedServiceAuth: null,
      connectedServiceMaterializationIdentity: null,
      providerBindingAttempt: null,
      providerAgentTargetKey: null,
      providerDiagnosticRedactionLease: createProviderRedactionLease({ values: [] }),
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      pluginRuntimeRegistry,
    }));
    expect(JSON.parse(result.extraEnvForChild[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]!)).toEqual({
      text: '  exact first input\n',
      localId: ' spawn-first-turn:attempt-1 ',
    });
    expect(result.extraEnv).not.toHaveProperty(HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY);
    expect(result.trackedSpawnOptions).not.toHaveProperty('pendingFirstInput');
    expect(result.trackedSpawnOptions.environmentVariables).toEqual({
      SAFE_PROFILE_VALUE: 'profile',
    });
    expect(result.trackedSpawnOptions.environmentVariables).not.toHaveProperty(
      HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
    );
  });

  it('removes an ambient handoff value when the request has no first input', async () => {
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValue({
      ok: true,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {
        [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: 'ambient-value-must-not-leak',
      },
      providerEnvKeys: [],
      cleanupOnFailure: null,
      cleanupOnExit: null,
    });

    const result = await prepareDaemonSpawnChildEnvironment({
      effectiveModelSelection: undefined,
      options: { directory: '/tmp/repo' },
      terminal: undefined,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      pluginRuntimeRegistry,
      processEnv: {},
      connectedServiceAuth: null,
      connectedServiceMaterializationIdentity: null,
      providerBindingAttempt: null,
      providerAgentTargetKey: null,
      providerDiagnosticRedactionLease: createProviderRedactionLease({ values: [] }),
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraEnvForChild).not.toHaveProperty(HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY);
    expect(result.trackedSpawnOptions).not.toHaveProperty('pendingFirstInput');
  });

  it('carries takeover correlation only into the first live child environment', async () => {
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValue({
      ok: true,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {
        [HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]:
          'ambient-value-must-not-win',
      },
      providerEnvKeys: [],
      cleanupOnFailure: null,
      cleanupOnExit: null,
    });

    const result = await prepareDaemonSpawnChildEnvironment({
      effectiveModelSelection: undefined,
      options: {
        directory: '/tmp/repo',
        persistedTakeoverAdmission: {
          mode: 'persisted',
          operationId: 'operation-1',
          attemptId: 'attempt-1',
        },
      },
      terminal: undefined,
      profileEnvironmentVariables: {},
      daemonSpawnHooks: null,
      pluginRuntimeRegistry,
      processEnv: {},
      connectedServiceAuth: null,
      connectedServiceMaterializationIdentity: null,
      providerBindingAttempt: null,
      providerAgentTargetKey: null,
      providerDiagnosticRedactionLease: createProviderRedactionLease({ values: [] }),
      launchResourceScope: createProviderLaunchResourceScope(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(
      result.extraEnvForChild[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY]!,
    )).toEqual({
      mode: 'persisted',
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    });
    expect(result.trackedSpawnOptions).not.toHaveProperty(
      'persistedTakeoverAdmission',
    );
    expect(result.trackedSpawnOptions.environmentVariables ?? {}).not.toHaveProperty(
      HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
    );
  });
});
