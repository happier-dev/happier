import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('bootstraps the requested home before resolving an admitted closure from a native launcher', async () => {
  await withTempDir('happier-native-daemon-bootstrap-', async (root) => {
    const closure = publishPinnedRunnerSnapshotFixture({
      stagingRoot: join(root, '.runner-snapshots', '.staging'),
      workspaceRuntimeIdentity: '3'.repeat(64),
    });
    const runtimeStatePath = join(root, 'stack.runtime.json');
    writeFileSync(runtimeStatePath, JSON.stringify({ version: 1, stackName: 'qa-native', daemon: {} }));
    const environment: NodeJS.ProcessEnv = {
      HAPPIER_HOME_DIR: join(root, 'requested-home'),
      HAPPIER_STACK_STACK: 'qa-native',
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: closure.snapshotEntrypoint,
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: closure.fingerprint,
      HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
      PATH: '',
    };
    // Only the official-release network boundary is substituted. Resolution,
    // bootstrap, filesystem admission, and launch construction remain real.
    const offline = new Error('Node release service unavailable');
    vi.stubGlobal('fetch', async () => { throw offline; });
    const originalExecPath = process.execPath;
    Object.defineProperty(process, 'execPath', { configurable: true, value: join(root, 'happier') });
    try {
      const { resolveDaemonLaunchSpec } = await import('./resolveDaemonLaunchSpec');
      await expect(resolveDaemonLaunchSpec(['daemon', 'start-sync'], environment)).rejects.toMatchObject({
        message: 'Managed JavaScript runtime is unavailable: bootstrap failed',
        cause: offline,
      });

      const managedRoot = join(environment.HAPPIER_HOME_DIR!, 'tools', 'js-runtime', 'current');
      const runtimeExecutable = join(managedRoot, 'bin', process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
      const nodeExecutable = process.platform === 'win32'
        ? join(managedRoot, 'runtime', 'node.exe')
        : join(managedRoot, 'runtime', 'bin', 'node');
      for (const executable of [runtimeExecutable, nodeExecutable]) {
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, 'managed runtime fixture');
        chmodSync(executable, 0o755);
      }
      const launch = await resolveDaemonLaunchSpec(['daemon', 'start-sync'], environment);
      expect(launch.filePath).toBe(runtimeExecutable);
      const launchedEntrypoint = launch.args.find((arg) => arg.endsWith('index.mjs'))!;
      expect(cliDistBuildManifest.readCliDistBuildManifest(launchedEntrypoint)).toMatchObject({
        ok: true, fingerprint: closure.fingerprint,
      });
      expect(readFileSync(launchedEntrypoint, 'utf8')).toBe(readFileSync(closure.snapshotEntrypoint, 'utf8'));
      expect(launch.args.slice(-2)).toEqual(['daemon', 'start-sync']);
      expect(launch.args).not.toContain('--import');
    } finally {
      Object.defineProperty(process, 'execPath', { configurable: true, value: originalExecPath });
    }
  });
});
