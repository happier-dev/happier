import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { describe, expect, it } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

describe('managed Agent daemon prerequisite admission', () => {
  it.each([false, true])('admits installed Oh My Pi without omp on PATH (Claude profile: %s)', async (withProfile) => {
    // Only the native executable is a fixture: the actual admitted plugin,
    // daemon hook dispatch, tool resolver and final launch admission stay real.
    if (process.platform === 'win32') return;
    const fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: ['happier.agent.ohmypi'] },
    });
    try {
      const command = resolveAgentCliManagedCommandPathForRuntime(getAgentCliRuntimeSpec('ohMyPi'), {
        happyHomeDir: fixture.happyHomeDir,
      });
      await mkdir(dirname(command), { recursive: true });
      const writeModels = async (available: boolean) => {
        const models = available ? [{ provider: 'anthropic', id: 'claude-sonnet-4-5', kind: 'chat' }] : [];
        await writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ models })}'\n`);
        await chmod(command, 0o755);
      };
      await writeModels(true);
      await fixture.registry.activateContributionsOnDemand([
        { pluginId: 'happier.agent.ohmypi', family: 'agents', localId: 'ohmypi' },
      ]);
      const input = {
        happyHomeDir: fixture.happyHomeDir,
        pluginRuntimeRegistry: fixture.registry,
        resolvedAgentId: 'ohMyPi',
        options: {
          directory: fixture.happyHomeDir,
          backendTarget: { kind: 'backend', backendId: 'ohMyPi', sourceKind: 'built_in' },
        },
        processEnv: { PATH: '', HOME: fixture.happyHomeDir, USERPROFILE: fixture.happyHomeDir,
          HAPPIER_HOME_DIR: fixture.happyHomeDir, HAPPIER_OHMYPI_PATH: undefined,
          ANTHROPIC_API_KEY: 'fixture-native-api-key' },
        profileEnvironmentVariables: withProfile ? { ANTHROPIC_OAUTH_TOKEN: 'fixture-access-only' } : {},
        daemonSpawnHooks: null,
        logDebug() {}, logInfo() {}, logWarn() {},
      } satisfies Parameters<typeof resolveSpawnChildEnvironment>[0];

      const admitted = await resolveSpawnChildEnvironment(input);
      expect(admitted, JSON.stringify(admitted)).toMatchObject({
        ok: true, agentCliLaunchSpec: { resolvedPath: command, source: 'managed' },
      });
      await writeModels(false);
      expect(await resolveSpawnChildEnvironment(input)).toMatchObject({
        ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: expect.stringContaining('models'),
      });
      await writeModels(true);
      expect(await resolveSpawnChildEnvironment(input)).toMatchObject({ ok: true });
      await rm(command);
      expect(await resolveSpawnChildEnvironment(input)).toMatchObject({
        ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
      });
    } finally {
      await fixture.dispose();
    }
  });
});
