// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';
import { inspectUiPostinstallOutputs } from '../proc/ui_postinstall.mjs';
import { prepareRemoteValidationWorkspace } from './remote_validation_preparation.mjs';

test('validation preparation waits for an active dependency refresh before loading its build owner', async t => {
  const fixture = await createTempFixture(t, { prefix: 'validation-dependency-consumption-' });
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  for (const app of ['ui', 'cli', 'server']) {
    await mkdir(fixture.path('apps', app), { recursive: true });
    await writeFile(fixture.path('apps', app, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root };
  let releaseWriter, writerStarted;
  const held = new Promise(resolve => { releaseWriter = resolve; });
  const started = new Promise(resolve => { writerStarted = resolve; });
  const writer = withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
    writerStarted();
    await held;
  });
  await started;
  let settled = false;
  const preparation = prepareRemoteValidationWorkspace({ repoDir: fixture.root,
    componentRelativeDir: 'apps/server', validationKind: 'runtime', env });
  preparation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, 'preparation must wait while the installed tree is being refreshed');
  } finally {
    releaseWriter();
    await writer;
    await preparation;
  }
});

test('UI dependency inspection waits for a refreshing package instead of reporting missing streaming files', async t => {
  const fixture = await createTempFixture(t, { prefix: 'ui-dependency-consumption-' });
  const ui = fixture.path('apps/ui');
  await mkdir(ui, { recursive: true });
  await writeFile(fixture.path('apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/app', scripts: { 'postinstall:real': 'fixture' } }));
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root };
  let releaseWriter, writerStarted;
  const held = new Promise(resolve => { releaseWriter = resolve; });
  const started = new Promise(resolve => { writerStarted = resolve; });
  const writer = withDependencyRefreshLock({ installDir: fixture.root, env }, async () => {
    writerStarted();
    await held;
    const output = fixture.path('node_modules/react-native-enriched-markdown/lib/module/web');
    await mkdir(output, { recursive: true });
    await writeFile(output + '/streamingReveal.js', 'export {};');
  });
  await started;
  let settled = false;
  const inspection = inspectUiPostinstallOutputs(ui, fixture.root, { env });
  inspection.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, 'inspection must not read the partially installed tree');
  } finally {
    releaseWriter();
    await writer;
    assert.deepEqual(await inspection, []);
  }
});
