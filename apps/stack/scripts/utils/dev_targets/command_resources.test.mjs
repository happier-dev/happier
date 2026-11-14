// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { HEAVYWEIGHT_COMMAND_RESOURCES } from './command_resources.mjs';
import { resolvePackageCommandPolicy, resolveHeavyweightMemoryFloorKiB } from './remote_commands.mjs';
import { resolveTypeScriptCliInvocation } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

test('every calibrated class uses its recorded measured maximum without a margin', async () => {
  const { COMMAND_MEMORY_MEASUREMENTS } = await import('./command_resources.mjs');
  assert.ok(COMMAND_MEMORY_MEASUREMENTS);
  let checked = 0;
  for (const [className, measurement] of Object.entries(COMMAND_MEMORY_MEASUREMENTS)) {
    assert.ok(measurement.samples >= 10, `${className} needs ten real runs`);
    assert.equal(resolveHeavyweightMemoryFloorKiB(className), Math.ceil(measurement.maxKiB / measurement.roundingKiB) * measurement.roundingKiB);
    checked += 1;
  }
  assert.equal(checked, Object.keys(COMMAND_MEMORY_MEASUREMENTS).length);
  assert.ok(checked > 0);
});


// The K=2 package batch peak rounds to a 5.5 GiB envelope.
test('package publishers admit at the measured half-GiB-rounded envelope', () => {
  assert.equal(resolveHeavyweightMemoryFloorKiB('package-dist'), 5.5 * 1024 * 1024);
  assert.equal(resolveHeavyweightMemoryFloorKiB('source-bundle'), 12 * 1024 * 1024,
    'producer startup has no separate heavy reservation; retain the source envelope');
});

for (const [compiler, expectedGiB] of [['tsrs', 10], ['microsoft', 20]]) {
  test(`UI admission consumes the canonical ${compiler} compiler selection at public and leaf entries`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-compiler-resources-' });
    const cwd = fixture.path('apps/ui');
    await mkdir(cwd, { recursive: true });
    const args = ['--project', 'tsconfig.json'];
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, files: [] }));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: {
      typecheck: 'node ../../scripts/workspaces/runTypeScriptCli.mjs --project tsconfig.json',
    } }));
    const env = { HAPPIER_TYPESCRIPT_COMPILER: compiler };
    const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: cwd, repoRoot: fixture.root, env,
      platform: 'linux', arch: 'x64' });
    const admissionClass = invocation.argsPrefix.find(arg => arg.startsWith('--class=')).slice('--class='.length);
    assert.equal(HEAVYWEIGHT_COMMAND_RESOURCES[admissionClass].memoryKiB, expectedGiB * 1024 * 1024);
    for (const command of [
      ['node', '../../scripts/workspaces/runTypeScriptCli.mjs', ...args],
      ['pnpm', 'run', 'typecheck'],
    ]) {
      const policy = await resolvePackageCommandPolicy(command, { cwd, repoRoot: fixture.root, env });
      assert.equal(policy.heavyClass, admissionClass);
      assert.equal(resolveHeavyweightMemoryFloorKiB(policy.heavyClass), expectedGiB * 1024 * 1024);
    }
    const overridden = await resolvePackageCommandPolicy(
      ['env', `HAPPIER_TYPESCRIPT_COMPILER=${compiler}`, 'pnpm', 'run', 'typecheck'],
      { cwd, repoRoot: fixture.root, env: { HAPPIER_TYPESCRIPT_COMPILER: compiler === 'tsrs' ? 'microsoft' : 'tsrs' } });
    assert.equal(resolveHeavyweightMemoryFloorKiB(overridden.heavyClass), expectedGiB * 1024 * 1024,
      'command environment assignments must select the same compiler as execution');
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: {
      typecheck: `env HAPPIER_TYPESCRIPT_COMPILER=${compiler} node ../../scripts/workspaces/runTypeScriptCli.mjs --project tsconfig.json`,
    } }));
    const manifestOverride = await resolvePackageCommandPolicy(['pnpm', 'run', 'typecheck'],
      { cwd, repoRoot: fixture.root, env: { HAPPIER_TYPESCRIPT_COMPILER: compiler === 'tsrs' ? 'microsoft' : 'tsrs' } });
    assert.equal(resolveHeavyweightMemoryFloorKiB(manifestOverride.heavyClass), expectedGiB * 1024 * 1024,
      'manifest environment assignments must reach the compiler selection owner');
    // The compiler-specific calibration must not shrink the finalizer or a build.
    const build = resolveTypeScriptCliInvocation({ args: ['--build'], admissionClass: 'compilation', env,
      platform: 'linux', arch: 'x64' });
    assert.ok(build.argsPrefix.includes('--class=compilation'));
    assert.equal(HEAVYWEIGHT_COMMAND_RESOURCES.compilation.memoryKiB, 38 * 1024 * 1024);
    assert.equal(HEAVYWEIGHT_COMMAND_RESOURCES['package-dist'].memoryKiB, 5.5 * 1024 * 1024);
    const general = resolveTypeScriptCliInvocation({ args: ['--noEmit'], admissionClass: 'compilation', env,
      platform: 'linux', arch: 'x64' });
    assert.ok(general.argsPrefix.includes('--class=compilation'));
    for (const [platform, arch, selectedGiB] of [
      ['linux', 'x64', 10], ['linux', 'arm64', 10], ['darwin', 'arm64', 10],
      ['darwin', 'x64', 20], ['win32', 'x64', 20],
    ]) {
      const automatic = resolveTypeScriptCliInvocation({ args, workspaceDir: cwd, repoRoot: fixture.root,
        platform, arch, env: {} });
      assert.equal(HEAVYWEIGHT_COMMAND_RESOURCES[automatic.admissionClass].memoryKiB, selectedGiB * 1024 * 1024,
        `${platform}/${arch} automatic compiler selection`);
    }
  });
}
