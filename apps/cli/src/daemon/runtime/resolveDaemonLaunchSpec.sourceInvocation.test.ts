import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';

import { resolveDaemonLaunchSpec } from './resolveDaemonLaunchSpec';

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];

afterEach(() => {
  process.argv = [...originalArgv];
  process.execArgv = [...originalExecArgv];
});

describe('daemon source subprocess invocation', () => {
  it('starts the selected source daemon while a promoted managed payload remains installed', async () => {
    await withTempDir('daemon-promoted-source-', async root => {
      const cliDir = join(root, 'source', 'apps', 'cli');
      const selected = join(cliDir, 'src', 'index.mjs');
      const promoted = join(root, 'managed', 'versions', 'promoted', 'package-dist', 'index.mjs');
      mkdirSync(join(cliDir, 'src'), { recursive: true });
      mkdirSync(join(root, 'managed', 'versions', 'promoted', 'package-dist'), { recursive: true });
      writeFileSync(selected, 'process.stdout.write("selected-source");');
      writeFileSync(promoted, 'process.stdout.write("promoted-payload");');
      const statePath = join(root, 'stack.runtime.json');
      writeFileSync(statePath, JSON.stringify({ sourceRuntimeLaunch: { cliDir, entrypoint: selected } }));
      process.argv = [process.execPath, selected, promoted];
      process.execArgv = [];
      const launch = await resolveDaemonLaunchSpec(['daemon', 'start-sync'], {
        HAPPIER_STACK_STACK: 'promoted-source-fixture', HAPPIER_STACK_RUNTIME_STATE_PATH: statePath,
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: selected, HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      });
      const child = spawnSync(launch.filePath, launch.args, {
        cwd: root, env: { ...process.env, ...launch.env }, encoding: 'utf8',
      });
      expect({ status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({
        status: 0, stdout: 'selected-source', stderr: '',
      });
      expect(launch.env?.HAPPIER_CLI_ROOT_DIR).toBe(cliDir);
      expect(launch.args).not.toContain(promoted);
    });
  });

  it('keeps a source parent on source when a stale dist exists without dev or Stack preferences', async () => {
    await withTempDir('FIX14-NL1-source-parent-', async (root) => {
      const sourceEntrypoint = join(root, 'src', 'index.ts');
      const staleDist = join(root, 'dist', 'index.mjs');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.runtime.json'), JSON.stringify({
        compilerOptions: { module: 'esnext', target: 'es2022' },
      }));
      writeFileSync(sourceEntrypoint,
        'import { parseOptionalBooleanEnv } from "@happier-dev/protocol/env/parseBooleanEnv"; process.stdout.write(String(parseOptionalBooleanEnv("1")));');
      writeFileSync(staleDist, 'throw new Error("stale_cli_dist_loaded");');
      // Include the existing artifact in argv discovery so the real packaged
      // resolver sees this fixture, without mocking either launch owner.
      process.argv = [process.execPath, sourceEntrypoint, staleDist];
      process.execArgv = [];

      const launch = await resolveDaemonLaunchSpec(['daemon', 'start-sync'], {});

      expect(launch.args).toContain(sourceEntrypoint);
      expect(launch.args).not.toContain(staleDist);
      expect(launch.args.slice(-2)).toEqual(['daemon', 'start-sync']);
      const child = spawnSync(launch.filePath, launch.args, {
        cwd: root, env: { ...process.env, ...launch.env }, encoding: 'utf8',
      });
      expect({ error: child.error, status: child.status, stdout: child.stdout, stderr: child.stderr }).toEqual({
        error: undefined, status: 0, stdout: 'true', stderr: '',
      });

      process.argv = [process.execPath, staleDist];
      const packagedLaunch = await resolveDaemonLaunchSpec(['daemon', 'start-sync'], {});
      expect(packagedLaunch).toEqual({
        filePath: process.execPath, args: [staleDist, 'daemon', 'start-sync'],
      });
    });
  });

  it('resolves workspace source from an arbitrary cwd instead of stale installed protocol dist', async () => {
    await withTempDir('daemon source resolution ', async (cwd) => {
      const installedProtocol = join(cwd, 'node_modules', '@happier-dev', 'protocol');
      mkdirSync(join(installedProtocol, 'dist'), { recursive: true });
      // Published copies omit source exports. Bare tsx captures this stale graph.
      writeFileSync(join(installedProtocol, 'package.json'), JSON.stringify({
        name: '@happier-dev/protocol', type: 'module',
        exports: { './actions/invocationAuthority': './dist/invocationAuthority.js' },
      }));
      writeFileSync(join(installedProtocol, 'dist', 'invocationAuthority.js'), 'export {};');

      const launch = await resolveDaemonLaunchSpec(['daemon', 'start-sync'], {
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1',
      });
      const entrypointIndex = launch.args.indexOf(join(projectPath(), 'src', 'index.ts'));
      expect(entrypointIndex).toBeGreaterThanOrEqual(0);
      // Run the real daemon's runtime flags in a finite child without starting
      // a daemon or touching its retained Home. The probe observes Node resolution.
      const child = spawnSync(launch.filePath, [
        ...launch.args.slice(0, entrypointIndex),
        '--input-type=module', '--eval',
        'process.stdout.write(import.meta.resolve("@happier-dev/protocol/actions/invocationAuthority"));',
      ], { cwd, env: { ...process.env, ...launch.env }, encoding: 'utf8' });

      expect({ error: child.error, status: child.status, stderr: child.stderr }).toEqual({
        error: undefined, status: 0, stderr: '',
      });
      expect(child.stdout).toBe(pathToFileURL(join(
        projectPath(), '..', '..', 'packages', 'protocol', 'src', 'actions', 'invocationAuthority.ts',
      )).href);
    });
  });
});
