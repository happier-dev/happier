import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { z } from 'zod';

import { reloadConfiguration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import {
  createAdmittedPluginRuntimeFixture,
  createAuthoredAdmittedPluginRuntimeFixture,
} from '@/plugins/testkit/admittedRuntime';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { spawnTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import type { PreparedForegroundAgentRuntimeAdmission } from './foregroundAdmission';
import {
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  type ForegroundAgentRuntimeAdmissionOwnerRequestV1,
} from './foregroundAdmissionContract';
import {
  prepareForegroundAgentRuntimeAdmission,
  type PrepareForegroundAgentRuntimeAdmissionDependencies,
} from './prepareForegroundAdmission';

type RequestOverrides = Partial<z.input<typeof ForegroundAgentRuntimeAdmissionRequestV1Schema>>
  & Readonly<{ machineId?: string }>;

type FixtureOptions = Readonly<{
  plugins?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'];
  runtimeOptions?: NonNullable<Parameters<typeof createAdmittedPluginRuntimeFixture>[0]>['runtimeOptions'];
}>;

type FixtureContext = Readonly<{
  home: string;
  directory: string;
  foregroundPid: number;
  runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  request(overrides?: RequestOverrides): ForegroundAgentRuntimeAdmissionOwnerRequestV1;
  prepare(
    overrides?: RequestOverrides,
    dependencies?: PrepareForegroundAgentRuntimeAdmissionDependencies,
  ): ReturnType<typeof prepareForegroundAgentRuntimeAdmission>;
}>;

/** Real daemon-applied source custody and a real, inspectable foreground process. */
export async function withRealForegroundAdmissionFixture<T>(
  options: FixtureOptions,
  run: (context: FixtureContext) => Promise<T>,
): Promise<T> {
  return await withTempDir('happier-composed-foreground-', async (directory) => {
    const home = join(directory, 'home');
    const env = createEnvKeyScope([
      'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
      'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'CODEX_HOME',
    ]);
    let runtime: FixtureContext['runtime'] | null = null;
    let foreground: ReturnType<typeof spawnTestProcess> | null = null;
    const prepared: PreparedForegroundAgentRuntimeAdmission[] = [];
    resetActiveAccountSettingsSnapshotForTests();
    try {
      const serverUrl = `https://${basename(directory)}.example.test`;
      env.patch({
        HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: serverUrl,
        HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: serverUrl,
        HAPPIER_ACTIVE_SERVER_ID: 'fixture', CODEX_HOME: join(directory, 'native-home'),
      });
      reloadConfiguration();
      await mkdir(join(directory, 'native-home'), { recursive: true });
      // The process runs these physical bytes. The real OS identity adapter
      // and runner-entrypoint owner derive its authority; neither is replaced.
      const entrypoint = join(directory, 'foreground', 'dist', 'index.mjs');
      await mkdir(join(directory, 'foreground', 'dist'), { recursive: true });
      await writeFile(entrypoint, 'setInterval(() => {}, 1000);\n', 'utf8');
      foreground = spawnTestProcess(process.execPath, [entrypoint]);
      await once(foreground, 'spawn');
      if (!foreground.pid) throw new Error('Foreground fixture process has no OS identity');
      runtime = options.plugins
        ? await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: options.plugins, happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: options.runtimeOptions,
          })
        : await createAdmittedPluginRuntimeFixture({
            happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: options.runtimeOptions ?? { pluginIds: ['happier.agent.codex'] },
          });
      const request = (overrides: RequestOverrides = {}): ForegroundAgentRuntimeAdmissionOwnerRequestV1 => {
        const { machineId = 'machine-1', ...wireOverrides } = overrides;
        return {
          ...ForegroundAgentRuntimeAdmissionRequestV1Schema.parse({
            v: 1, attemptId: 'attempt-1', sessionId: 'session-1',
            foregroundPid: foreground!.pid, directory, agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            ...wireOverrides,
          }),
          machineId,
        };
      };
      return await run({
        home, directory, foregroundPid: foreground.pid, runtime, request,
        async prepare(overrides = {}, dependencies = {}) {
          const admission = await prepareForegroundAgentRuntimeAdmission(request(overrides), dependencies);
          if (admission.ok) prepared.push(admission.prepared);
          return admission;
        },
      });
    } finally {
      try {
        try {
          // Every tracked admission is idempotently released even when one
          // cleanup rejects, so a failed assertion cannot leak its siblings.
          const cleanups = await Promise.allSettled(prepared.map(admission => Promise.resolve().then(() => admission.cleanup())));
          const failed = cleanups.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        } finally {
          try {
            await runtime?.dispose();
          } finally {
            if (foreground?.pid) {
              foreground.kill();
              if (!await waitForProcessExit(foreground.pid)) throw new Error('Foreground fixture process did not exit');
            }
          }
        }
      } finally {
        resetActiveAccountSettingsSnapshotForTests();
        env.restore();
        reloadConfiguration();
      }
    }
  });
}
