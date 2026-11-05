import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, holdNativeAdmissionFixtureMemory, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { withDependencyRefreshLock } from './dependency_refresh.mjs';
import { runSourceBuildCommand } from './runSourceBuildCommand.mjs';
import { resolveHeavyweightMemoryFloorKiB } from '../dev_targets/remote_commands.mjs';

for (const publication of ['absent', 'replaced']) {
  test(`finite source tool keeps one authored graph while workspace dist is ${publication}`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-source-dist-publication-' });
    const repoDir = fixture.root;
    const tool = fixture.path(publication === 'absent'
      ? 'apps/ui/scripts/prepare.mjs' : 'apps/stack/scripts/prepare.mjs');
    const packageDir = fixture.path('packages/example');
    for (const directory of ['apps/stack/bin', 'apps/stack/scripts', 'packages/cli-common',
      'packages/example/src', 'packages/example/dist', 'packages/example/staged', 'node_modules/@happier-dev']) {
      await mkdir(fixture.path(directory), { recursive: true });
    }
    await mkdir(dirname(tool), { recursive: true });
    await cp(new URL('../../../bin/localSourceRuntimeBootstrap.mjs', import.meta.url),
      fixture.path('apps/stack/bin/localSourceRuntimeBootstrap.mjs'));
    for (const name of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'cliRuntimeSidecars.mjs', 'sourceRuntimeDependencies.mjs']) {
      await cp(new URL(`../../../../../packages/cli-common/${name}`, import.meta.url), fixture.path('packages/cli-common', name));
    }
    // Keep the bootstrap's real installed-tree owner and its complete graph.
    // Only the authored package under publication is copied into this checkout.
    await mkdir(fixture.path('apps/stack/scripts/utils/proc'), { recursive: true });
    await writeFile(fixture.path('apps/stack/scripts/utils/proc/dependency_refresh.mjs'),
      `export * from ${JSON.stringify(new URL('./dependency_refresh.mjs', import.meta.url).href)};\n`);
    // Third-party transpilation and package installation are genuine system
    // boundaries; workspace resolution and the child import graph stay real.
    await symlink(dirname(createRequire(import.meta.url).resolve('tsx/package.json')),
      fixture.path('node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(packageDir, fixture.path('node_modules/@happier-dev/example'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module',
      exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
    for (const [directory, generation] of [['src', 'source'], ['dist', 'old'], ['staged', 'new']]) {
      await writeFile(join(packageDir, directory, directory === 'src' ? 'index.ts' : 'index.js'),
        `export const head = '${generation}'; export const read = async () => (await import('./leaf.js')).tail;`);
      await writeFile(join(packageDir, directory, directory === 'src' ? 'leaf.ts' : 'leaf.js'),
        `export const tail = '${generation}';`);
    }
    const releasePath = fixture.path('continue');
    const product = fixture.path('apps/cli/dist/entry.mjs');
    await mkdir(dirname(product), { recursive: true });
    await writeFile(product, `import {head,read} from '@happier-dev/example'; console.log(JSON.stringify({head,tail:await read()}));`);
    await writeFile(tool, `
      import {head,read} from '@happier-dev/example';
      import {existsSync,watch} from 'node:fs';
      import {execFileSync} from 'node:child_process';
      const gate = ${JSON.stringify(releasePath)};
      const released = new Promise(resolve => {
        const observer = watch(${JSON.stringify(repoDir)}, () => { if (existsSync(gate)) { observer.close(); resolve(); } });
        if (existsSync(gate)) { observer.close(); resolve(); }
      });
      console.log('linked');
      await released;
      const observed = {head,tail:await read()};
      ${publication === 'replaced' ? `observed.product = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(product)}], {encoding:'utf8'}));` : ''}
      console.log(JSON.stringify(observed));
    `);
    let output = '';
    let published = false;
    let publish;
    const stdoutStream = new Writable({ write(chunk, _encoding, done) {
      output += chunk;
      if (!published && output.includes('linked\n')) {
        published = true;
        publish = (async () => {
          await rename(join(packageDir, 'dist'), join(packageDir, 'backup'));
          if (publication === 'replaced') await rename(join(packageDir, 'staged'), join(packageDir, 'dist'));
          await writeFile(releasePath, 'continue');
        })();
        publish.then(() => done(), done);
      } else done();
    } });
    // An SSH worker does not inherit the controller preload. A finite child
    // must select its source authority even with a deliberately empty value.
    await runSourceBuildCommand({ repoDir, scriptPath: tool, env: { ...process.env, NODE_OPTIONS: '' },
      captureStdout: false, stdoutStream, signal: t.signal });
    await publish;
    assert.equal(published, true);
    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), { head: 'source', tail: 'source',
      ...(publication === 'replaced' ? { product: { head: 'new', tail: 'new' } } : {}) });
  });
}

test('finite source preparation uses the native memory queue and releases it on completion and cancellation',
  { skip: process.platform !== 'linux', timeout: 20000 }, async (t) => {
    const fixture = await createTempFixture(t, { prefix: 'happier-source-admission-' });
    const native = await installNativeAdmissionFixture({ root: fixture.root });
    const adapter = join(fixture.root, 'native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
    const adapterSource = new URL('./runSourceBuildCommand.mjs', import.meta.url);
    await writeFile(adapter, (await readFile(adapterSource, 'utf8')).replace(
      "from '../dev/devReloadCoordinator.mjs'", `from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs', adapterSource).href)}`));
    const { runSourceBuildCommand } = await import(pathToFileURL(adapter));
    const validationFloorKiB = resolveHeavyweightMemoryFloorKiB('validation');
    const pressureMemory = { totalKiB: 16777216, availableKiB: validationFloorKiB - 1 };
    const pressure = await holdNativeAdmissionFixtureMemory(t, native, pressureMemory);
    const env = { ...buildNativeAdmissionFixtureEnv(), HAPPIER_DEV_TARGET_EXECUTION: '1' };
    const marker = fixture.path('executed');
    const scriptPath = fixture.path('prepare.mjs');
    await writeFile(scriptPath, `
      import {writeFileSync} from 'node:fs';
      import {requestAdmissionSample} from ${JSON.stringify(pathToFileURL(native.admissionClientPath).href)};
      const {activeCount,waitingCount,reservedMemoryKiB}=await requestAdmissionSample(${JSON.stringify(native.admissionRoot)});
      writeFileSync(${JSON.stringify(marker)},'executed');
      console.log(JSON.stringify({activeCount,waitingCount,reservedMemoryKiB}));
    `);
    const queued = async () => {
      while ((await native.brokerStatus()).waitingCount !== 1) {
        await delay(10, undefined, { signal: t.signal });
      }
    };
    const assertIdle = async () => {
      const { activeCount, waitingCount } = await native.brokerStatus();
      assert.deepEqual({ activeCount, waitingCount }, { activeCount: 0, waitingCount: 0 });
    };
    const pending = runSourceBuildCommand({ repoDir: fixture.root, scriptPath, env, signal: t.signal });
    await queued();
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await withDependencyRefreshLock({ installDir: fixture.root, env, signal: t.signal }, async () => {});
    await pressure.release();
    assert.deepEqual(JSON.parse(await pending), { activeCount: 1, waitingCount: 0,
      reservedMemoryKiB: validationFloorKiB });
    await assertIdle();
    assert.deepEqual(JSON.parse(await runSourceBuildCommand({ repoDir: fixture.root,
      scriptPath, env, signal: t.signal, admissionClass: 'source-bundle' })), { activeCount: 1, waitingCount: 0,
      reservedMemoryKiB: resolveHeavyweightMemoryFloorKiB('source-bundle') });
    await assertIdle();
    await writeFile(scriptPath, 'process.exit(47);');
    await assert.rejects(runSourceBuildCommand({ repoDir: fixture.root, scriptPath, env, signal: t.signal }), { code: 47 });
    const externalCommand = fixture.path('external-source-command');
    await writeFile(externalCommand, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    await chmod(externalCommand, 0o755);
    await assert.rejects(runSourceBuildCommand({ repoDir: fixture.root,
      command: externalCommand, args: [scriptPath], env, signal: t.signal }), { code: 47 });
    const cancellationPressureOwner = await holdNativeAdmissionFixtureMemory(t, native, pressureMemory);
    const controller = new AbortController();
    const cancelled = runSourceBuildCommand({ repoDir: fixture.root,
      command: externalCommand, args: [scriptPath], env, signal: AbortSignal.any([controller.signal, t.signal]) });
    // Attach before abort so the preserved OS cancellation cannot be unhandled.
    const cancellationResult = assert.rejects(cancelled, { name: 'AbortError' });
    await queued();
    controller.abort();
    await cancellationResult;
    await cancellationPressureOwner.release();
    await assertIdle();
  });
