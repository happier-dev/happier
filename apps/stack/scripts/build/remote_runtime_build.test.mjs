import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntimeArtifactComponentsAtPlacement, resolveRuntimeBuildPlacement } from './remote_runtime_build.mjs';
import { buildRuntimeArtifactComponents } from './build_stack_artifacts.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { resolveRemoteCommandPolicy } from '../utils/dev_targets/remote_commands.mjs';
import { resolveMutagenSessionName } from '../utils/dev_targets/mutagen_project.mjs';
import { REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX } from '../utils/dev_targets/remote_commands.mjs';

test('build placement rejects a mismatched worker and accepts an observed matching WSL worker', () => {
  const config = { runtimePlacement: { build: { mode: 'prefer-target', target: 'worker' } }, targets: [
    { name: 'worker', platform: 'posix', repoDir: '/home/dev/source', cliHomeDir: '/home/dev/builds', managedRuntime: { kind: 'wsl' } },
  ] };
  const hostTarget = { platform: 'linux', arch: 'arm64' };
  assert.equal(resolveRuntimeBuildPlacement({ config, hostTarget, observedTarget: { ok: true, runtimeTarget: { platform: 'linux', arch: 'x64' } } }).target, null);
  assert.equal(resolveRuntimeBuildPlacement({ config, hostTarget, observedTarget: { ok: true, runtimeTarget: hostTarget } }).target, config.targets[0]);
  assert.equal(resolveRemoteCommandPolicy(['node', 'apps/stack/scripts/build/remote_runtime_build.mjs', '--worker-request=/request']).heavyClass, 'compilation');
});

test('admitted source transfer stays independent of later producer edits and a dispatched failure is never replayed locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-source-'));
  try {
    const repoDir = join(root, 'repo');
    const stackBaseDir = join(root, 'producer');
    await mkdir(join(repoDir, 'apps/server/sources'), { recursive: true });
    await mkdir(stackBaseDir);
    for (const name of ['cli', 'ui', 'server']) {
      await mkdir(join(repoDir, 'apps', name), { recursive: true });
      await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}` }));
    }
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
    await writeFile(join(repoDir, 'apps/server/package.json'), JSON.stringify({ name: '@happier-dev/server', dependencies: { '@happier-dev/example': '0.0.0' } }));
    await mkdir(join(repoDir, 'packages/example'), { recursive: true });
    await writeFile(join(repoDir, 'packages/example/package.json'), JSON.stringify({ name: '@happier-dev/example' }));
    await writeFile(join(repoDir, 'packages/example/tsconfig.json'), JSON.stringify({ extends: './tsconfig.tests.json' }));
    await writeFile(join(repoDir, 'packages/example/tsconfig.tests.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    const input = join(repoDir, 'apps/server/sources/index.ts');
    await writeFile(input, 'captured input');
    await writeFile(join(repoDir, '.gitignore'), 'apps/server/sources/generated.ts\npackages/example/tsconfig.tests.json\n');
    await writeFile(join(repoDir, 'apps/server/sources/generated.ts'), 'consumed generated input');
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    const target = { name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/worker' };
    await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target], runtimePlacement: { build: { mode: 'prefer-target', target: 'worker' } } }));
    const archive = join(root, 'source.tar');
    let request;
    const options = { rootDir: join(repoDir, 'apps/stack'), stackBaseDir, selection: { components: { server: true } }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir },
      buildLocal: buildRuntimeArtifactComponents,
      transport: {
        doctorDependencies: { runProcess: async () => ({ code: 0, stdout: REMOTE_DOCTOR_RUNTIME_TARGET_PREFIX + JSON.stringify({ platform: process.platform, arch: process.arch }) }) },
        syncDependencies: { runCaptureResult: async () => ({ ok: true, out: JSON.stringify([{ name: resolveMutagenSessionName('worker'), paused: false, status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]) }) },
        transfer: async ({ localPath, remotePath }) => {
          if (remotePath.endsWith('source.tar')) await writeFile(archive, await readFile(localPath));
          else request = JSON.parse(await readFile(localPath, 'utf8'));
        },
        runCommand: async ({ commandArgs }) => {
          if (!commandArgs.some(arg => arg.startsWith('--worker-request='))) return { code: 0 };
          await writeFile(input, 'newer producer input');
          return { code: 23 };
        },
      },
    };
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options), /exit 23.*no local replay/);
    assert.equal(await readFile(input, 'utf8'), 'newer producer input');
    const captured = join(root, 'captured');
    await mkdir(captured);
    execFileSync('tar', ['-xf', archive, '-C', captured]);
    assert.equal(await readFile(join(captured, 'apps/server/sources/index.ts'), 'utf8'), 'captured input');
    assert.equal(await readFile(join(captured, 'apps/server/sources/generated.ts'), 'utf8'), 'consumed generated input');
    assert.deepEqual(JSON.parse(await readFile(join(captured, 'packages/example/tsconfig.tests.json'), 'utf8')), { compilerOptions: { strict: true } });
    assert.ok(request.expectedInputs.server);
    assert.equal(request.env[WORKSPACE_BUILD_MODE_ENV], 'qa-runtime');
    assert.notEqual(request.workspaceDir + '/repo', target.repoDir);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unavailable runtime worker uses the real local component owner and preserves its failure without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-fallback-'));
  try {
    const stackBaseDir = join(root, 'stack');
    await mkdir(stackBaseDir);
    await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3,
      targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/builds' }],
      runtimePlacement: { build: { mode: 'prefer-target', target: 'worker' } },
    }));
    const options = { rootDir: root, stackBaseDir, selection: { components: {} }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: root },
      buildLocal: buildRuntimeArtifactComponents,
      transport: { doctorDependencies: { runProcess: async () => ({ code: 1 }) } },
    };
    const result = await buildRuntimeArtifactComponentsAtPlacement(options);
    assert.deepEqual(result.artifacts, {});
    assert.equal(result.buildPlacement.fallbackFrom, 'worker');
    // Observe the real owner's missing-input failure. It must propagate once,
    // not be caught as another remote preflight failure.
    let probes = 0;
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement({ ...options, selection: { components: { web: true } },
      buildLocal: input => { probes += 1; return buildRuntimeArtifactComponents(input); },
    }), /no readable source inputs/);
    assert.equal(probes, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
