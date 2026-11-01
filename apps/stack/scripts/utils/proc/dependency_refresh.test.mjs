import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { adoptDependencyInstallation, assertDependenciesReady, inspectDependencyRefresh, markDependencyMutation, readDependencyPublicationState,
  resolveDependencyRefreshLockPath, resolveDependencyRefreshMarkerPath, withDependencyRefresh, withDependencyRefreshLock } from './dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { inspectUiPostinstallOutputs } from './ui_postinstall.mjs';

test('publication retains Expo-consumed changes across server-only repairs and failed output attempts', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-publication-outputs-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const options = { installDir: fixture.root, env };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await withDependencyRefresh(options, () => mkdir(fixture.path('node_modules')));
  const installed = await readDependencyPublicationState(options);
  assert.deepEqual(installed.outputsChanged, ['install']);
  assert.equal(installed.completedExpoGeneration, installed.completedGeneration);
  const publish = output => withDependencyRefreshLock(options, () => markDependencyMutation({ ...options, output }));
  await publish('server-generated-client:prisma');
  const server = await readDependencyPublicationState(options);
  assert.deepEqual(server.outputsChanged, ['server-generated-client:prisma']);
  assert.notEqual(server.completedGeneration, installed.completedGeneration);
  assert.equal(server.completedExpoGeneration, installed.completedExpoGeneration);
  await publish('ui-dependency-outputs');
  const ui = await readDependencyPublicationState(options);
  await publish('server-generated-client:prisma');
  const trailingServer = await readDependencyPublicationState(options);
  assert.equal(trailingServer.completedExpoGeneration, ui.completedGeneration,
    'a server-only completion cannot hide an earlier UI publication from a delayed observer');
  assert.notEqual(trailingServer.completedExpoGeneration, installed.completedExpoGeneration);
  const failure = new Error('output producer failed');
  await assert.rejects(withDependencyRefreshLock(options, async () => {
    await markDependencyMutation({ ...options, output: 'ui-dependency-outputs' });
    throw failure;
  }), error => error === failure);
  const failed = await readDependencyPublicationState(options);
  assert.equal(failed.completedGeneration, trailingServer.completedGeneration);
  assert.equal(failed.completedExpoGeneration, trailingServer.completedExpoGeneration);
  await withDependencyRefresh({ ...options, force: true }, async () => {
    await markDependencyMutation({ ...options, output: 'server-generated-client:prisma' });
  });
  const nested = await readDependencyPublicationState(options);
  assert.deepEqual(nested.outputsChanged, ['install', 'server-generated-client:prisma']);
  assert.equal(nested.completedExpoGeneration, nested.completedGeneration,
    'a nested server repair cannot relabel the containing installation');
});

test('the publication reader accepts the observed legacy generation record', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-publication-legacy-' });
  const options = { installDir: fixture.root, env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root } };
  const path = `${resolveDependencyRefreshLockPath(fixture.root, options.env)}.generation`;
  await mkdir(join(path, '..'), { recursive: true });
  // The active pre-change dev writer publishes only these two fields.
  await writeFile(path, JSON.stringify({ generation: 'legacy-completion', completedGeneration: 'legacy-completion' }));
  const state = await readDependencyPublicationState(options);
  assert.equal(state.completedExpoGeneration, 'legacy-completion');
  assert.deepEqual(state.outputsChanged, ['install']);
});

test('a first server-only completion does not invent an Expo input generation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-publication-first-server-' });
  const options = { installDir: fixture.root, env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root } };
  await withDependencyRefreshLock(options, () => markDependencyMutation({ ...options,
    output: 'server-generated-client:prisma' }));
  const state = await readDependencyPublicationState(options);
  assert.equal(typeof state.completedGeneration, 'string');
  assert.equal(state.completedExpoGeneration, null);
});

test('successful dependency installation removes quarantined packages only from its declared workspace tree', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-install-quarantine-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  for (const name of ['stack', 'ui', 'cli', 'server', 'borrowed']) {
    await mkdir(fixture.path('apps', name), { recursive: true });
    await writeFile(fixture.path('apps', name, 'package.json'), '{}');
  }
  const external = fixture.path('external-dependencies');
  await mkdir(join(external, '.ignored'), { recursive: true });
  await writeFile(join(external, '.ignored', 'retained'), 'external owner');
  await symlink(external, fixture.path('apps', 'borrowed', 'node_modules'), 'junction');
  const nested = fixture.path('.nested-copy', 'node_modules', '.ignored');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'retained'), 'undeclared checkout');
  const ignored = [fixture.path('node_modules', '.ignored'), fixture.path('apps', 'stack', 'node_modules', '.ignored')];
  const options = { installDir: fixture.root, componentDir: fixture.path('apps', 'stack'), env };
  await withDependencyRefresh({ ...options, onDependenciesReady: async () => {
    // The output owner may itself restore dependencies before admission.
    await mkdir(ignored[1], { recursive: true });
    await writeFile(join(ignored[1], 'discarded'), 'postinstall quarantine');
  } }, async () => {
    await mkdir(ignored[0], { recursive: true });
    await writeFile(join(ignored[0], 'discarded'), 'installer quarantine');
    await writeFile(fixture.path('node_modules', 'live'), 'installed package');
  });
  for (const path of ignored) await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.equal(await readFile(fixture.path('node_modules', 'live'), 'utf8'), 'installed package');
  assert.equal(await readFile(join(nested, 'retained'), 'utf8'), 'undeclared checkout');
  assert.equal(await readFile(join(external, '.ignored', 'retained'), 'utf8'), 'external owner');
  await mkdir(ignored[0]);
  await withDependencyRefresh(options, async () => assert.fail('a warm tree must remain read-only'));
  assert.equal((await lstat(ignored[0])).isDirectory(), true);
  await withDependencyRefresh({ ...options, force: true, env: { ...env,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' } },
  async () => assert.fail('disabled refresh must not install'));
  assert.equal((await lstat(ignored[0])).isDirectory(), true, 'disabled refresh must not remove quarantine');
  await assert.rejects(withDependencyRefresh({ ...options, force: true }, async () => {
    throw new Error('installer boundary failed');
  }), { code: 'HAPPIER_DEPENDENCY_REFRESH_FAILED' });
  assert.equal((await lstat(ignored[0])).isDirectory(), true, 'failed installs retain their diagnostic quarantine');
  const outputFailure = new Error('output owner failed');
  // Output completion is part of the same cold installation error contract.
  await assert.rejects(withDependencyRefresh({ ...options, force: true,
    onDependenciesReady: async () => { throw outputFailure; } }, async () => {}),
  error => error.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED' && error.cause === outputFailure);
  assert.equal((await lstat(ignored[0])).isDirectory(), true, 'failed output preparation retains quarantine');
});

test('unchanged dependency-ready preparation and adoption publish no dependency mutation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-noop-publication-' });
  const options = { installDir: fixture.root, env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' } };
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await withDependencyRefresh(options, async () => {});
  const before = await readDependencyPublicationState(options);
  const paths = [resolveDependencyRefreshMarkerPath(fixture.root),
    `${resolveDependencyRefreshLockPath(fixture.root, options.env)}.generation`];
  const snapshot = () => Promise.all(paths.map(async path => ({ bytes: await readFile(path, 'utf8'),
    mtime: (await lstat(path)).mtimeMs })));
  const publications = await snapshot();
  let checks = 0;
  const onDependenciesReady = async () => { checks++; };
  await withDependencyRefresh({ ...options, onDependenciesReady }, async () => assert.fail('current tree must not install'));
  await adoptDependencyInstallation({ ...options, onDependenciesReady });
  assert.equal(checks, 2);
  assert.deepEqual(await readDependencyPublicationState(options), before,
    'verification callbacks must not advance generation, completion or identity');
  assert.deepEqual(await snapshot(), publications, 'unchanged readiness must not rewrite publication files');
});

test('cold output completion fails once without publishing readiness and preserves enclosing cancellation', async t => {
  for (const cancelled of [false, true]) await t.test(cancelled ? 'cancelled completion' : 'failed completion', async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-cold-completion-failure-' });
    await writeFile(fixture.path('package.json'), '{"private":true}');
    const controller = new AbortController();
    const failure = new Error('output completion failed');
    const cancellation = new Error('enclosing installation cancelled');
    let completions = 0;
    const options = { installDir: fixture.root, signal: controller.signal,
      env: { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
        HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' },
      onDependenciesReady: async () => {
        completions++;
        if (cancelled) controller.abort(cancellation);
        throw failure;
      },
    };
    await assert.rejects(withDependencyRefresh(options, async () => mkdir(fixture.path('node_modules'))),
      error => cancelled ? error === cancellation
        : error.code === 'HAPPIER_DEPENDENCY_REFRESH_FAILED' && error.cause === failure);
    assert.equal(completions, 1, 'a failed output producer must not be replayed');
    await assert.rejects(readFile(resolveDependencyRefreshMarkerPath(fixture.root)), { code: 'ENOENT' });
    const publication = await readDependencyPublicationState(options);
    assert.notEqual(publication.generation, publication.completedGeneration);
  });
});

test('fresh provisioner adoption removes installation quarantine while warm and disabled adoption stay read-only', async t => {
  for (const disabled of [false, true]) {
    const fixture = await createTempFixture(t, { prefix: 'hstack-adopt-quarantine-' });
    const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: disabled ? '1' : '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: disabled ? '1' : '0' };
    await writeFile(fixture.path('package.json'), '{"private":true}');
    const ignored = fixture.path('node_modules', '.ignored');
    await mkdir(ignored, { recursive: true });
    const options = { installDir: fixture.root, env };
    await adoptDependencyInstallation(options);
    if (disabled) assert.equal((await lstat(ignored)).isDirectory(), true);
    else await assert.rejects(lstat(ignored), { code: 'ENOENT' });
    await mkdir(ignored, { recursive: true });
    await adoptDependencyInstallation(options);
    assert.equal((await lstat(ignored)).isDirectory(), true, 'already admitted adoption does not represent another installation');
  }
});

async function borrowedTree(t, { matching = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-borrowed-dependencies-' });
  const owner = fixture.path('owner');
  const borrower = fixture.path('borrower');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home'),
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(borrower, 'cache'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(join(owner, 'node_modules'), { recursive: true });
  await mkdir(borrower);
  for (const dir of [owner, borrower]) {
    await writeFile(join(dir, 'package.json'), '{"private":true,"packageManager":"pnpm@10.15.1"}');
    await writeFile(join(dir, 'pnpm-lock.yaml'), dir === owner || matching ? '# owner inputs\n' : '# borrower inputs\n');
  }
  await writeFile(join(owner, 'node_modules', '.modules.yaml'), 'owner installation\n');
  await withDependencyRefresh({ installDir: owner, env }, async () => {});
  await symlink(join(owner, 'node_modules'), join(borrower, 'node_modules'), 'junction');
  const paths = [owner, borrower, join(owner, 'node_modules'),
    resolveDependencyRefreshMarkerPath(owner), join(owner, 'node_modules', '.modules.yaml'),
    ...[owner, borrower].flatMap(installDir => {
      const lock = resolveDependencyRefreshLockPath(installDir, env);
      return [lock, `${lock}.generation`];
    })];
  const snapshot = () => Promise.all(paths.map(async path => {
    const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { path, mtimeMs: stat?.mtimeMs ?? null,
      bytes: stat?.isFile() ? await readFile(path, 'utf8') : null };
  }));
  return { owner, borrower, env, snapshot };
}

test('borrowed dependency inputs refuse refresh before writing the owner tree', async t => {
  const { owner, borrower, env, snapshot } = await borrowedTree(t);
  const before = await snapshot();
  let installed = false;
  await assert.rejects(withDependencyRefresh({ installDir: borrower, env }, async () => {
    installed = true;
    await writeFile(join(borrower, 'node_modules', '.modules.yaml'), 'borrower installed into owner\n');
  }), error => {
    assert.equal(error.code, 'HAPPIER_DEPENDENCIES_BORROWED');
    assert.equal(error.installDir, borrower);
    assert.equal(error.linkTarget, join(owner, 'node_modules'));
    assert.ok(error.message.includes(join(owner, 'node_modules')));
    return true;
  });
  assert.equal(installed, false);
  assert.deepEqual(await snapshot(), before, 'marker, generation, modules bytes/mtimes and directories must stay unchanged');
});

test('borrowed dependency admission is read-only and requires a completed matching publication', async t => {
  const { owner, borrower, env, snapshot } = await borrowedTree(t, { matching: true });
  const before = await snapshot();
  assert.equal((await assertDependenciesReady({ installDir: borrower, env })).required, false);
  assert.deepEqual(await withDependencyRefresh({ installDir: borrower, env }, async () => {
    assert.fail('matching borrowed dependencies must never install');
  }), { refreshed: false, reason: 'up-to-date' });
  assert.deepEqual(await snapshot(), before);
  await writeFile(`${resolveDependencyRefreshLockPath(owner, env)}.generation`,
    JSON.stringify({ generation: 'interrupted-owner-write', completedGeneration: null }));
  const interrupted = await snapshot();
  await assert.rejects(assertDependenciesReady({ installDir: borrower, env }), { code: 'HAPPIER_DEPENDENCIES_BORROWED' });
  assert.deepEqual(await snapshot(), interrupted);
});

test('an owned node_modules symlink inside the installation root can still refresh', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-owned-dependency-link-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('dependencies'));
  await symlink(fixture.path('dependencies'), fixture.path('node_modules'), 'junction');
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const result = await withDependencyRefresh({ installDir: fixture.root, env }, async () => {
    await writeFile(fixture.path('node_modules', '.modules.yaml'), 'owned installation\n');
  });
  assert.equal(result.refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
});

test('unregistered patch edits cause zero installations', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-unregistered-patch-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await mkdir(fixture.path('patches'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  for (let edit = 0; edit < 24; edit++) {
    await writeFile(fixture.path('patches', 'unregistered.patch'), `not a registered input ${edit}`);
    assert.equal((await withDependencyRefresh({ installDir: fixture.root, env },
      async () => assert.fail('unregistered patches must not trigger an installation'))).refreshed, false);
  }
});

for (const worker of [false, true]) test(`dependency refresh reports running Stacks without blocking or stopping them (worker=${worker})`, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-runtime-dependency-consumer-' });
  const baseDir = worker ? fixture.path('target-home', 'stack-state', 'qa') : fixture.path('stacks', 'qa');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0',
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_REPO_DIR: fixture.root, HAPPIER_STACK_PM_CACHE_BASE_DIR: fixture.path('target-home', 'cache') };
  await mkdir(fixture.path('node_modules'));
  await mkdir(baseDir, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${fixture.root}\n`);
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const marker = fixture.path('node_modules', '.happier-stack-dependencies-ready');
  const statePath = join(baseDir, 'stack.runtime.json');
  const messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  let mutations = 0;
  for (const state of [{ ownerPid: process.pid }, { ownerPid: null, processes: { daemonPid: process.pid } },
    { ownerPid: null, processes: { serverPid: process.pid } }]) {
    await writeFile(statePath, JSON.stringify({ stackName: 'qa', ...state }));
    assert.equal((await withDependencyRefresh({ installDir: fixture.root, env }, async () => { mutations++; })).refreshed, false,
      'warm readiness remains a reader even while a Stack is running');
    const recorded = await readFile(statePath, 'utf8');
    const result = await withDependencyRefresh({ installDir: fixture.root, env, force: true }, async () => { mutations++; });
    assert.equal(result.refreshed, true);
    assert.deepEqual(result.stacksNeedingRestart, ['qa']);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')).stacksNeedingRestart, ['qa']);
    assert.equal(await readFile(statePath, 'utf8'), recorded, 'refresh must leave running Stack ownership intact');
    assert.match(messages.at(-1), /restart.*qa/);
  }
  assert.equal(mutations, 3);
  const beforeFailure = messages.length;
  const failure = new Error('installer boundary failed');
  await assert.rejects(withDependencyRefresh({ installDir: fixture.root, env, force: true }, async () => {
    throw failure;
  }), error => error.cause === failure);
  assert.equal(messages.length, beforeFailure, 'a failed refresh must not publish a restart advisory');
  await writeFile(statePath, JSON.stringify({ stackName: 'qa', ownerPid: null, processes: {} }));
  const stopped = await withDependencyRefresh({ installDir: fixture.root, env, force: true }, async () => { mutations++; });
  assert.deepEqual(stopped.stacksNeedingRestart, []);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')).stacksNeedingRestart, []);
  assert.equal(mutations, 4, 'stopped consumers must permit refresh without a stale advisory');
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${fixture.path('unrelated')}\n`);
  await writeFile(statePath, JSON.stringify({ stackName: 'qa', ownerPid: process.pid }));
  const unrelated = await withDependencyRefresh({ installDir: fixture.root, env, force: true }, async () => { mutations++; });
  assert.deepEqual(unrelated.stacksNeedingRestart, []);
  assert.equal(mutations, 5, 'a different installed tree must not be listed for this refresh');
});

test('dependency refresh installs new verifier dependencies before probing UI outputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-refresh-verifier-prerequisite-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const uiDir = fixture.path('apps', 'ui');
  const verifierDir = join(uiDir, 'tools', 'postinstall');
  const dependencyDir = fixture.path('node_modules', 'verifier-prerequisite');
  await mkdir(verifierDir, { recursive: true });
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-lock.yaml'), '# current dependency inputs\n');
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/app', scripts: { 'postinstall:real': 'node postinstall.mjs' },
  }));
  await writeFile(join(dependencyDir, 'package.json'), '{"type":"module","exports":"./index.mjs"}');
  await writeFile(join(dependencyDir, 'index.mjs'), 'export const oldApi = true;\n');
  await writeFile(join(verifierDir, 'verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs'),
    "import { ready } from 'verifier-prerequisite';\nexport function verifyUiPatchedDependencies() { if (!ready) throw new Error('dependency not installed'); }\n");
  const result = await withDependencyRefresh({ installDir: fixture.root, componentDir: uiDir, env,
    onDependenciesReady: async () => assert.deepEqual(await inspectUiPostinstallOutputs(uiDir, fixture.root), []),
  }, async () => {
    await writeFile(join(dependencyDir, 'index.mjs'), 'export const ready = true;\n');
  });
  assert.equal(result.refreshed, true);
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, componentDir: uiDir, env })).required, false);
});

test('pnpm lockfile, workspace configuration and patch bytes invalidate installed dependency freshness', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-pnpm-freshness-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await mkdir(fixture.path('patches'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const workspace = 'packages: []\npatchedDependencies:\n  dependency@1.0.0: patches/dependency.patch\n';
  await writeFile(fixture.path('pnpm-workspace.yaml'), workspace);
  for (const input of ['pnpm-lock.yaml', 'patches/dependency.patch']) {
    await writeFile(fixture.path(input), 'initial');
  }
  for (const input of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/dependency.patch']) {
    await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
    assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, env })).required, false);
    await writeFile(fixture.path(input), input === 'pnpm-workspace.yaml' ? `${workspace}# changed\n` : 'changed');
    assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, env })).required, true, input);
  }
});

test('registered patch paths outside the conventional directory remain install inputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-registered-patch-path-' });
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await mkdir(fixture.path('changes'));
  await writeFile(fixture.path('package.json'), '{"private":true}');
  await writeFile(fixture.path('pnpm-workspace.yaml'), "patchedDependencies: # registered paths\n  '@scope/dependency@1.0.0': 'changes/dependency.diff' # canonical\n");
  await writeFile(fixture.path('changes/dependency.diff'), 'registered');
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  await writeFile(fixture.path('changes/dependency.diff'), 'changed');
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
  await rm(fixture.path('changes/dependency.diff'));
  assert.equal((await inspectDependencyRefresh({ installDir: fixture.root, env })).required, true);
});

test('source edits during and after installation preserve dependency readiness', async (t) => {
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const root = await mkdtemp(join(tmpdir(), 'happier-password-source-freshness-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  for (const component of ['ui', 'cli', 'server']) {
    const dir = join(root, 'apps', component);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  const protocolDir = join(root, 'packages', 'protocol');
  await mkdir(join(protocolDir, 'src', 'auth'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, workspaces: ['apps/*', 'packages/*'],
  }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  // Real package metadata is the production boundary: the freshness owner must
  // observe this asset dependency, not a test-only declaration of its inputs.
  await cp(new URL('../../../../../packages/protocol/package.json', import.meta.url), join(protocolDir, 'package.json'));
  await cp(new URL('../../../../ui/package.json', import.meta.url), join(root, 'apps', 'ui', 'package.json'));
  const workerPath = join(root, 'apps', 'ui', 'sources', 'auth', 'password', 'passwordKdf.worker.ts');
  await mkdir(join(workerPath, '..'), { recursive: true });
  await writeFile(workerPath, 'export const sourceRevision = 1;\n');
  const codecPath = join(protocolDir, 'src', 'auth', 'accountPasswordCredential.ts');
  await writeFile(codecPath, 'export const codecRevision = 1;\n');
  const uiToolPath = join(root, 'apps', 'ui', 'tools', 'codemirror', 'buildCodeMirrorWebViewBundle.mjs');
  const schemaPath = join(root, 'apps', 'server', 'prisma', 'schema.prisma');
  await mkdir(join(uiToolPath, '..'), { recursive: true });
  await mkdir(join(schemaPath, '..'), { recursive: true });
  await writeFile(uiToolPath, 'export const revision = 1;\n');
  await writeFile(schemaPath, '// initial schema\n');
  await withDependencyRefresh({ installDir: root, env }, async () => {
    await writeFile(codecPath, 'export const codecRevision = 2;\n');
    await writeFile(workerPath, 'export const sourceRevision = 2;\n');
  });
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false);
  await writeFile(codecPath, 'export const codecRevision = 3;\n');
  await writeFile(workerPath, 'export const sourceRevision = 3;\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false,
    'source asset compilation owns its last-green output, not installed dependency identity');
  await writeFile(uiToolPath, 'export const revision = 2;\n');
  await writeFile(schemaPath, '// changed schema\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false,
    'UI tool and Prisma schema edits require their output owner, never an install');
  await writeFile(join(root, 'pnpm-lock.yaml'), '# dependency change\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, true,
    'lockfile changes still require an explicit dependency refresh');
});

for (const scope of ['workspace', 'root']) test(`${scope} dependency freshness ignores runtime exports and commands but observes install inputs`, async (t) => {
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-workspace-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), JSON.stringify({ name: `fixture-${component}` }));
  }
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'packages', 'fixture'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  const manifestPath = scope === 'root' ? join(root, 'package.json') : join(root, 'packages', 'fixture', 'package.json');
  const manifest = { name: 'workspace-fixture', version: '1.0.0', dependencies: { a: '1', b: '2' },
    ...(scope === 'root' ? { private: true, workspaces: ['apps/*', 'packages/*'] } : {}),
    scripts: { postinstall: 'patch-fixture', test: 'old-test', ...(scope === 'root' ? { prepare: 'prepare-fixture', prepublish: 'publish-fixture' } : {}) },
    exports: { '.': './src/index.js' } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await withDependencyRefresh({ installDir: root, env }, async () => {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, exports: { '.': './dist/index.js' } }));
  });
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false,
    'exports advancing during installation do not supersede admitted install inputs');
  const changed = { ...manifest, exports: { '.': './dist/index.js', './new': './dist/new.js' }, main: './dist/index.js',
    types: './dist/index.d.ts', scripts: { ...manifest.scripts, test: 'new-test', build: 'build-fixture' },
    dependencies: { b: '2', a: '1' } };
  await writeFile(manifestPath, JSON.stringify(changed, null, 2));
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false,
    'runtime entry points, non-install commands, formatting and dependency map order do not require installation');
  await withDependencyRefresh({ installDir: root, env }, async () => assert.fail('exports-only edits must not install'));
  const mutations = [
    { name: 'renamed-fixture' }, { version: '2.0.0' }, { dependencies: { a: '2', b: '2' } },
    { devDependencies: { c: '1' } }, { optionalDependencies: { c: '1' } }, { peerDependencies: { c: '1' } },
    { peerDependenciesMeta: { c: { optional: true } } }, { bin: './cli.js' }, { directories: { bin: './bin' } },
    { workspaces: ['nested/*'] }, { resolutions: { c: '1' } }, { overrides: { c: '1' } },
    { packageManager: 'pnpm@12.14.0' }, { engines: { node: '>=24' } }, { os: ['linux'] }, { cpu: ['x64'] },
    { flat: true }, { bundledDependencies: ['a'] }, { bundleDependencies: ['b'] },
    ...['preinstall', 'install', 'postinstall', ...(scope === 'root' ? ['prepare', 'prepublish'] : [])]
      .map(stage => ({ scripts: { ...changed.scripts, [stage]: 'changed-install' } })),
  ];
  for (const mutation of mutations) {
    await writeFile(manifestPath, JSON.stringify({ ...changed, ...mutation }));
    assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, true,
      `install-relevant change ${Object.keys(mutation)[0]} must remain stale`);
  }
});

test('dependency readiness survives relocation of a byte-identical installed tree', async (t) => {
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'happier-dependency-relocation-'));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const sourceRoot = join(fixtureRoot, 'source');
  const relocatedRoot = join(fixtureRoot, 'relocated');
  await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await writeFile(join(sourceRoot, 'install-input.txt'), 'fixture input\n', 'utf8');
  await symlink(join(sourceRoot, 'install-input.txt'), join(sourceRoot, 'install-input-link'));
  await Promise.all([
    writeFile(join(sourceRoot, 'package.json'), '{"name":"fixture","private":true,"packageManager":"pnpm@12.14.0","happier":{"installFreshnessInputs":["install-input-link"]}}\n', 'utf8'),
    writeFile(join(sourceRoot, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: sourceRoot, env }, async () => {
    refreshCount += 1;
    await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
    await writeFile(join(sourceRoot, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nnodeLinker: hoisted\n');
  });
  assert.equal(refreshCount, 1);
  const sourceInspection = await inspectDependencyRefresh({ installDir: sourceRoot, env });
  assert.equal(sourceInspection.required, false);
  const marker = JSON.parse(await readFile(sourceInspection.markerPath, 'utf8'));
  assert.equal(marker.version, 7);
  assert.equal(Object.hasOwn(marker, 'installDir'), false);
  assert.equal(JSON.stringify(marker).includes(sourceRoot), false, 'the readiness identity must not contain absolute installation paths');

  await cp(sourceRoot, relocatedRoot, { recursive: true });
  assert.equal(
    (await inspectDependencyRefresh({ installDir: relocatedRoot, env })).required,
    false,
    'absolute installation paths must not participate in dependency freshness identity',
  );
  await withDependencyRefresh({ installDir: relocatedRoot, env }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1, 'relocating a ready tree must not trigger another install');
});

test('dependency readiness rejects legacy markers and a different toolchain identity', async (t) => {
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true,"packageManager":"pnpm@12.14.0"}\n', 'utf8'),
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);
  const armIdentity = {
    packageManager: 'pnpm@12.14.0',
    nodeVersion: '24.0.0',
    nodeAbi: '137',
    platform: 'linux',
    architecture: 'arm64',
    installMode: 'development-full-v1',
  };
  const x64Identity = { ...armIdentity, architecture: 'x64' };

  await withDependencyRefresh({ installDir: root, env, runtimeIdentity: armIdentity }, async () => {
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', '.modules.yaml'), 'packageManager: pnpm@12.14.0\nnodeLinker: hoisted\n');
  });
  const admitted = await inspectDependencyRefresh({ installDir: root, env, runtimeIdentity: armIdentity });
  assert.equal(admitted.required, false);
  assert.equal((await inspectDependencyRefresh({ installDir: root, env,
    runtimeIdentity: { ...armIdentity, nodeVersion: '24.1.0' } })).required, false,
  'Node versions sharing an ABI reuse installed native dependencies');
  assert.equal((await inspectDependencyRefresh({ installDir: root, env,
    runtimeIdentity: { ...armIdentity, nodeAbi: '138' } })).required, true,
  'a different Node ABI still requires installation');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, env, runtimeIdentity: x64Identity })).required,
    true,
    'architecture-sensitive dependency state must not cross worker architectures',
  );

  const marker = JSON.parse(await readFile(admitted.markerPath, 'utf8'));
  await writeFile(admitted.markerPath, `${JSON.stringify({ ...marker, version: 5 })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, env, runtimeIdentity: armIdentity })).required,
    true,
    'v5 markers may have admitted scriptless installs as full installs and must be refreshed',
  );
  await writeFile(admitted.markerPath, `${JSON.stringify({
    ...marker,
    version: 4,
    installDir: root,
  })}\n`, 'utf8');
  assert.equal(
    (await inspectDependencyRefresh({ installDir: root, env, runtimeIdentity: armIdentity })).required,
    true,
    'v4 absolute-path markers remain stale on read',
  );
});

test('dependency admission repairs an exact node_modules self-link without reinstalling', async (t) => {
  const env = { ...process.env, HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-self-link-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const nodeModules = join(root, 'node_modules');
  await Promise.all([
    mkdir(nodeModules, { recursive: true }),
    writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8'),
    writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n', 'utf8'),
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n'),
  ]);

  let refreshCount = 0;
  await withDependencyRefresh({ installDir: root, env }, async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 1);
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false);

  const invalidLink = join(nodeModules, 'node_modules');
  await symlink(nodeModules, invalidLink, 'dir');
  const corrupted = await inspectDependencyRefresh({ installDir: root, env });
  assert.equal(corrupted.required, true);
  assert.equal(corrupted.selfReferentialNodeModulesLinkPath, invalidLink);

  const repaired = await withDependencyRefresh({ installDir: root, env }, async () => {
    refreshCount += 1;
  });
  assert.deepEqual(repaired, {
    refreshed: false,
    reason: 'repaired-self-referential-node-modules-link',
  });
  assert.equal(refreshCount, 1, 'repairing the exact self-link must not run a package install');
  await assert.rejects(() => lstat(invalidLink), { code: 'ENOENT' });
  assert.equal((await inspectDependencyRefresh({ installDir: root, env })).required, false);
});
