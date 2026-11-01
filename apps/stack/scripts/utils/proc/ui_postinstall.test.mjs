import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { ensureUiPostinstallOutputs, inspectUiPostinstallOutputs } from './ui_postinstall.mjs';
import { inspectDependencyRefresh, isDependencyRefreshLockActive, readDependencyPublicationState, resolveDependencyRefreshLockPath,
  withDependencyRefresh, withDependencyRefreshLock } from './dependency_refresh.mjs';

async function repairFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-repair-writer-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const uiDir = fixture.path('apps', 'ui');
  const output = fixture.path('node_modules', 'react-native-enriched-markdown', 'lib', 'module', 'web', 'streamingReveal.js');
  await mkdir(fixture.path('node_modules'));
  await mkdir(uiDir, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/app',
    scripts: { 'postinstall:real': 'node tools/postinstall.mjs' } }));
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const before = await readDependencyPublicationState({ installDir: fixture.root, env });
  const observeProcess = ({ writeOutput = false, status = 0, diagnostic = '' } = {}) => {
    const script = `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { dirname } from 'node:path';
      import { readDependencyPublicationState } from ${JSON.stringify(new URL('./dependency_refresh.mjs', import.meta.url).href)};
      const input = JSON.parse(process.argv[1]);
      const state = await readDependencyPublicationState({ installDir: input.installDir });
      if (input.writeOutput) {
        await mkdir(dirname(input.output), { recursive: true });
        await writeFile(input.output, 'export const repaired = true;');
      }
      process.stdout.write(JSON.stringify({ writerActive: state.writerActive,
        generationChanged: state.generation !== input.beforeGeneration }));
      process.stderr.write(input.diagnostic);
      process.exitCode = input.status;
    `;
    const result = spawnSync(process.execPath, ['--conditions=happier-source', '--import',
      new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url).href,
      '--input-type=module', '-e', script, JSON.stringify({ installDir: fixture.root, output,
        beforeGeneration: before.generation, writeOutput, status, diagnostic })], { env, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.stderr, diagnostic, 'the source-only child must load the real writer owner');
    return { status: result.status, state: JSON.parse(result.stdout), stderr: result.stderr };
  };
  return { fixture, uiDir, output, env, observeProcess };
}

test('direct UI repair and dependency restoration hold the writer and invalidate publication while healthy reads write nothing', async t => {
  const { fixture, uiDir, env, observeProcess } = await repairFixture(t);
  const quarantine = fixture.path('node_modules', '.ignored');
  const observed = [];
  let attempts = 0;
  await ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true, env,
    runPostinstall: async () => {
      const result = observeProcess({ status: attempts++ === 0 ? 2 : 0, writeOutput: attempts > 1 });
      observed.push(result.state);
      if (result.status !== 0) throw new Error('postinstall process failed');
    },
    restoreDependencies: async () => {
      observed.push(observeProcess().state);
      await mkdir(quarantine);
      await writeFile(join(quarantine, 'discarded'), 'restored dependency quarantine');
    } });
  await assert.rejects(lstat(quarantine), { code: 'ENOENT' });
  assert.deepEqual(observed, Array.from({ length: 3 }, () => ({ writerActive: true, generationChanged: true })),
    'the actual postinstall and restore subprocesses share the canonical writer exclusion');
  const afterRepair = await readDependencyPublicationState({ installDir: fixture.root, env });
  const lockPath = resolveDependencyRefreshLockPath(fixture.root, env);
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  await mkdir(quarantine);
  await ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true, env,
    runPostinstall: async () => assert.fail('healthy output inspection must not invoke a repair'),
    restoreDependencies: async () => assert.fail('healthy output inspection must not reinstall') });
  assert.deepEqual(await readDependencyPublicationState({ installDir: fixture.root, env }), afterRepair,
    'healthy inspection writes no generation token');
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  await withDependencyRefreshLock({ installDir: fixture.root, env, signal: t.signal }, async () => {
    await ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true, force: true, env,
      runPostinstall: async () => { assert.equal(isDependencyRefreshLockActive({ installDir: fixture.root, env }), true); },
      restoreDependencies: async () => assert.fail('healthy forced preparation needs no reinstall') });
  });
  assert.equal((await lstat(quarantine)).isDirectory(), true, 'output checks without installation preserve quarantine');
});

test('failed UI dependency restoration preserves the canonical pnpm error and leaves recovery pending', async t => {
  const { fixture, uiDir, env, observeProcess } = await repairFixture(t);
  const quarantine = fixture.path('node_modules', '.ignored');
  await assert.rejects(ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true, env,
    runPostinstall: async () => { throw new Error('postinstall subprocess requires pristine dependencies'); },
    restoreDependencies: async () => {
      await mkdir(quarantine);
      const child = observeProcess({ status: 3, diagnostic: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH\n' });
      assert.equal(child.status, 3);
      throw Object.assign(new Error('dependency restore subprocess failed'), { stderr: child.stderr });
    } }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED', pnpmErrorCode: 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH' });
  assert.equal((await lstat(quarantine)).isDirectory(), true, 'failed restoration preserves quarantine');
  await assert.rejects(ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true, env,
    runPostinstall: async () => { throw new Error('restored output remains invalid'); },
    restoreDependencies: async () => {} }), /restored output remains invalid/u);
  assert.equal((await lstat(quarantine)).isDirectory(), true, 'failed postinstall retry preserves quarantine');
});

test('direct UI repair cannot certify a partial failed installation and an ordinary installer still recovers it', async t => {
  const { fixture, uiDir, env, observeProcess } = await repairFixture(t);
  const options = { installDir: fixture.root, env };
  const linked = fixture.path('node_modules', 'linked.js');
  await assert.rejects(withDependencyRefresh({ ...options, force: true }, async () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[1], 'partial'); process.exitCode = 2;", linked],
    { encoding: 'utf8' });
    if (child.error) throw child.error;
    assert.equal(child.status, 2);
    throw new Error('installer subprocess failed after linking');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  const failed = await readDependencyPublicationState(options);
  await ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true, env,
    runPostinstall: async () => { assert.equal(observeProcess({ writeOutput: true }).status, 0); },
    restoreDependencies: async () => assert.fail('the direct UI output repair succeeds') });
  const repaired = await readDependencyPublicationState(options);
  assert.equal(repaired.completedGeneration, failed.completedGeneration,
    'a successful UI repair cannot prove that the rest of a failed dependency tree is intact');
  assert.equal((await inspectDependencyRefresh(options)).required, true);
  assert.equal(await readFile(linked, 'utf8'), 'partial');
  let installations = 0;
  assert.equal((await withDependencyRefresh(options, async () => {
    installations++;
    await writeFile(linked, 'complete');
  })).refreshed, true);
  assert.equal(installations, 1);
  assert.equal((await inspectDependencyRefresh(options)).required, false);
  assert.equal(await readFile(linked, 'utf8'), 'complete');
});

test('UI output freshness reruns only tasks whose declared inputs changed', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-ui-output-inputs-' });
  const uiDir = fixture.path('apps', 'ui');
  const toolDir = join(uiDir, 'tools');
  await mkdir(join(toolDir, 'postinstall'), { recursive: true });
  await mkdir(join(toolDir, 'codemirror'));
  await mkdir(join(toolDir, 'xterm'));
  await mkdir(join(uiDir, 'public'));
  await writeFile(join(uiDir, 'public', 'canvaskit.wasm'), 'wasm');
  const { happier } = JSON.parse(await readFile(new URL('../../../../ui/package.json', import.meta.url), 'utf8'));
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: '@happier-dev/app', happier,
    scripts: { 'postinstall:real': 'node tools/postinstall.mjs' } }));
  await cp(new URL('../../../../ui/tools/resolveUiPostinstallTasks.mjs', import.meta.url),
    join(toolDir, 'resolveUiPostinstallTasks.mjs'));
  await writeFile(join(toolDir, 'postinstall', 'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs'),
    'export function verifyUiPatchedDependencies() {}\n');
  const codeMirrorInput = join(toolDir, 'codemirror', 'buildCodeMirrorWebViewBundle.mjs');
  await writeFile(codeMirrorInput, 'export const revision = 1;\n');
  await writeFile(join(toolDir, 'xterm', 'buildXtermWebViewBundle.mjs'), 'export const revision = 1;\n');
  const observed = [];
  // The package-manager subprocess is the genuine boundary. Resolve the tasks
  // with the production owner rather than a fixture imitation of its selector.
  const { resolveUiPostinstallTasks } = await import(new URL('../../../../ui/tools/resolveUiPostinstallTasks.mjs', import.meta.url));
  const prepare = () => ensureUiPostinstallOutputs(uiDir, fixture.root, { quiet: true,
    runPostinstall: async env => { observed.push(resolveUiPostinstallTasks({ env })); },
    restoreDependencies: async () => assert.fail('source changes must not reinstall dependencies') });
  await prepare();
  assert.equal(observed.length, 1, 'existing outputs need their initial input admission');
  assert.deepEqual(await inspectUiPostinstallOutputs(uiDir, fixture.root), []);
  await prepare();
  assert.equal(observed.length, 1, 'unchanged task inputs reuse prepared outputs');
  await writeFile(codeMirrorInput, 'export const revision = 2;\n');
  assert.notDeepEqual(await inspectUiPostinstallOutputs(uiDir, fixture.root), [], 'the output check observes changed declared inputs');
  await prepare();
  assert.deepEqual(observed.at(-1), ['vendor-codemirror-webview-bundle']);
  assert.equal(observed.length, 2);
  await writeFile(join(toolDir, 'codemirror', 'builder.test.mjs'), '// regression tests are not producer inputs\n');
  await prepare();
  assert.equal(observed.length, 2, 'test-only edits cause zero output tasks');
  await writeFile(join(toolDir, 'xterm', 'buildXtermWebViewBundle.mjs'), 'export const revision = 2;\n');
  await prepare();
  assert.deepEqual(observed.at(-1), ['vendor-xterm-webview-bundle']);
  await writeFile(join(uiDir, 'public', 'canvaskit.wasm'), '');
  await assert.rejects(prepare(), /Missing or empty UI postinstall asset/,
    'a matching input stamp never replaces the mandatory output verification');
});
