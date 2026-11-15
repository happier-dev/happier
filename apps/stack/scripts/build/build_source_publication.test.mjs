import assert from 'node:assert/strict';
import fs, { existsSync } from 'node:fs';
import { mkdir, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { reclaimPrivateSourceWebExports, sourceBundleBuildLockPath, withSourceBundlePublication } from './build_source_runtime.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';

async function completedBundle(stacksRoot, name, completedMs = Date.now()) {
  const directory = join(stacksRoot, 'source-bundles', `runtime-${name}`);
  const entrypoint = join(directory, 'entry.mjs');
  await mkdir(directory, { recursive: true });
  await writeFile(entrypoint, 'export const ready = true;');
  const recordPath = join(directory, 'source-bundle.json');
  await writeFile(recordPath, JSON.stringify({ component: 'server', entrypoint }));
  await utimes(recordPath, completedMs / 1000, completedMs / 1000);
  return { directory, entrypoint };
}

test('shared bundle maintenance reclaims obsolete products without changing selections or private outputs',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-shared-bundle-maintenance-' });
    const stacksRoot = fixture.path('stacks');
    const stackBaseDir = join(stacksRoot, 'consumer');
    const obsolete = await completedBundle(stacksRoot, 'obsolete', Date.now() - 20000);
    const selected = await completedBundle(stacksRoot, 'selected', Date.now() - 10000);
    const newest = await completedBundle(stacksRoot, 'newest');
    const privateOutput = join(stackBaseDir, 'source-runtime/bundle-private/entry.mjs');
    await mkdir(dirname(privateOutput), { recursive: true });
    await writeFile(privateOutput, 'export const retained = true;');
    const selectionPath = join(stackBaseDir, 'source-runtime/selected-server.json');
    const selection = JSON.stringify({ entrypoint: selected.entrypoint });
    await writeFile(selectionPath, selection);
    // Selections pin shared bundles while their Stack runs.
    await writeFile(join(stackBaseDir, 'stack.runtime.json'), JSON.stringify({ ownerPid: process.pid, processes: {} }));
    // Process discovery is the OS boundary; retain the real pin and retirement owners.
    const readdir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (path, ...args) =>
      String(path) === '/proc' ? [] : await readdir(path, ...args));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const { reclaimSourceBundles } = await import('./build_source_runtime.mjs');
    await reclaimSourceBundles({ stacksRoot });
    assert.equal(existsSync(obsolete.entrypoint), true, 'maintenance defaults to dry-run');
    await reclaimSourceBundles({ stacksRoot, dryRun: false });
    assert.equal(existsSync(obsolete.directory), false);
    assert.equal(existsSync(selected.entrypoint), true, 'selected older products remain pinned');
    assert.equal(existsSync(newest.entrypoint), true, 'newest completed fallback remains available');
    assert.equal(existsSync(privateOutput), true, 'shared maintenance does not nominate private products');
    assert.equal(await readFile(selectionPath, 'utf8'), selection);
  });

test('a stopped Stack releases its selection pins; a running Stack keeps them',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-stopped-stack-pins-' });
    const stacksRoot = fixture.path('stacks');
    const live = await completedBundle(stacksRoot, 'live', Date.now() - 30000);
    const stopped = await completedBundle(stacksRoot, 'stopped', Date.now() - 20000);
    const newest = await completedBundle(stacksRoot, 'newest');
    const { spawnSync } = await import('node:child_process');
    const deadPid = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    for (const [name, bundle, ownerPid] of [['agent-qa-running', live, process.pid], ['agent-qa-stopped', stopped, Number(deadPid)]]) {
      const stackBaseDir = join(stacksRoot, name);
      await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
      await writeFile(join(stackBaseDir, 'stack.runtime.json'), JSON.stringify({ ownerPid, processes: {} }));
      await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint: bundle.entrypoint }));
    }
    // Process discovery is the OS boundary; retain the real pin and retirement owners.
    const readdir = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (path, ...args) =>
      String(path) === '/proc' ? [] : await readdir(path, ...args));
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const { reclaimSourceBundles } = await import('./build_source_runtime.mjs');
    await reclaimSourceBundles({ stacksRoot, dryRun: false });
    const remaining = (await fs.promises.readdir(join(stacksRoot, 'source-bundles'))).filter(name => name.startsWith('runtime-')).sort();
    assert.deepEqual(remaining, ['runtime-live', 'runtime-newest'], 'only the running Stack selection and the newest fallback stay');
    assert.equal(existsSync(newest.entrypoint), true);
    // A later start of the stopped Stack treats its released selection as absent.
    const { readSelectedSourceRuntimeRecord } = await import('../runtime/shared/source_bundle_record.mjs');
    assert.equal(await readSelectedSourceRuntimeRecord({ stackBaseDir: join(stacksRoot, 'agent-qa-stopped'),
      component: 'server', required: false }), null);
  });

test('publication releases custody before process scans and recursive retirement',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-publication-retention-' });
    const stacksRoot = fixture.path('stacks');
    const stackBaseDir = join(stacksRoot, 'consumer');
    const obsolete = await completedBundle(stacksRoot, 'obsolete', Date.now() - 10000);
    const newest = await completedBundle(stacksRoot, 'newest');
    const interrupted = await completedBundle(stacksRoot, 'interrupted', Date.now() + 10000);
    const retiredDirectory = join(stacksRoot, 'source-bundles/.retired-runtime-interrupted');
    await rename(interrupted.directory, retiredDirectory);
    const partialRetirement = join(stacksRoot, 'source-bundles/.retired-runtime-partial');
    await mkdir(partialRetirement);
    await writeFile(join(partialRetirement, 'remaining.mjs'), 'export const abandoned = true;');
    await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
    const lockPath = join(stacksRoot, 'source-bundles/publication.lock');
    const readdir = fs.promises.readdir;
    const rm = fs.promises.rm;
    const linkSync = fs.linkSync;
    const unlinkSync = fs.unlinkSync;
    const started = performance.now();
    const acquisitions = [];
    let held;
    let publishStarted;
    let publishFinished;
    let processScans = 0;
    let recursiveRetirements = 0;
    let scanHeldCustody = false;
    let retirementHeldCustody = false;
    t.mock.method(fs, 'linkSync', (from, to) => {
      const result = linkSync(from, to);
      if (String(to) === lockPath) {
        held = performance.now();
        acquisitions.push({ acquiredAtMs: held - started });
      }
      return result;
    });
    t.mock.method(fs, 'unlinkSync', path => {
      const result = unlinkSync(path);
      if (String(path) === lockPath && held !== undefined) acquisitions.at(-1).holdMs = performance.now() - held;
      return result;
    });
    // The filesystem/process census is the genuine OS boundary. Its cost
    // must never consume the publication owner's exclusive admission slot.
    t.mock.method(fs.promises, 'readdir', async (path, ...args) => {
      if (String(path) === '/proc') {
        processScans++;
        scanHeldCustody ||= existsSync(lockPath);
        return [];
      }
      return await readdir(path, ...args);
    });
    t.mock.method(fs.promises, 'rm', async (path, ...args) => {
      if (resolve(String(path)).startsWith(resolve(stacksRoot) + '/') && args[0]?.recursive) {
        recursiveRetirements++;
        retirementHeldCustody ||= existsSync(lockPath);
      }
      return await rm(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await withSourceBundlePublication({ stackBaseDir, outputDir: newest.directory }, async () => {
      publishStarted = performance.now();
      assert.equal(existsSync(lockPath), true, 'consumer selection stays inside publication custody');
      await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint: newest.entrypoint }));
      publishFinished = performance.now();
    });
    t.diagnostic(JSON.stringify({ acquisitions, recordMs: 0, reusedCompletion: true,
      publishMs: publishFinished - publishStarted, retainMs: performance.now() - publishFinished }));
    assert.equal(scanHeldCustody, false, 'process census runs after publication release');
    assert.equal(retirementHeldCustody, false, 'recursive retirement runs after publication release');
    assert.equal(processScans, 1);
    assert.equal(recursiveRetirements, 3);
    assert.equal(existsSync(obsolete.directory), false);
    assert.equal(existsSync(retiredDirectory), false, 'ordinary retention finishes an interrupted retirement without making it newest');
    assert.equal(existsSync(partialRetirement), false, 'retirement recovery does not require an already-removed completion record');
    assert.equal(existsSync(newest.entrypoint), true);
  });

test('a publication during reclamation pins a bundle before its retirement decision',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-publication-concurrent-pin-' });
    const stacksRoot = fixture.path('stacks');
    const firstStack = join(stacksRoot, 'first');
    const adoptingStack = join(stacksRoot, 'adopter');
    const candidate = await completedBundle(stacksRoot, 'candidate', Date.now() - 10000);
    const newest = await completedBundle(stacksRoot, 'newest');
    for (const stack of [firstStack, adoptingStack]) {
      await mkdir(join(stack, 'source-runtime'), { recursive: true });
      // Selections are written by a running start/reload; they pin while it runs.
      await writeFile(join(stack, 'stack.runtime.json'), JSON.stringify({ ownerPid: process.pid, processes: {} }));
    }
    const lockPath = join(stacksRoot, 'source-bundles/publication.lock');
    const readdir = fs.promises.readdir;
    let adopted = false;
    t.mock.method(fs.promises, 'readdir', async (path, ...args) => {
      if (String(path) !== '/proc') return await readdir(path, ...args);
      assert.equal(existsSync(lockPath), false, 'another publication can enter during the process census');
      if (!adopted) {
        adopted = true;
        await withSourceBundlePublication({ stackBaseDir: adoptingStack, outputDir: candidate.directory }, async () => {
          await writeFile(join(adoptingStack, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint: candidate.entrypoint }));
        });
      }
      return [];
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await withSourceBundlePublication({ stackBaseDir: firstStack, outputDir: newest.directory }, async () => {
      await writeFile(join(firstStack, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint: newest.entrypoint }));
    });
    assert.equal(adopted, true);
    const selected = JSON.parse(await readFile(join(adoptingStack, 'source-runtime/selected-server.json'), 'utf8'));
    assert.equal(selected.entrypoint, candidate.entrypoint);
    assert.equal(existsSync(candidate.entrypoint), true, 'a fresh selected pin survives the earlier retention snapshot');
  });

test('private export qualification runs outside publication custody and honors a late selected pin',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-private-publication-retention-' });
    const stacksRoot = fixture.path('stacks');
    const stackBaseDir = join(stacksRoot, 'consumer');
    const sourceRoot = join(stackBaseDir, 'source-runtime');
    await mkdir(join(stacksRoot, 'source-bundles'), { recursive: true });
    const old = new Date(Date.now() - 72 * 3600000);
    const newer = new Date(Date.now() - 48 * 3600000);
    const retiredCompletion = new Date(Date.now() - 36 * 3600000);
    for (const name of ['obsolete', 'late', 'green', 'retired']) {
      const directory = join(sourceRoot, name === 'retired' ? '.retired-web-interrupted' : `web-${name}`);
      const payload = join(directory, 'export');
      await mkdir(payload, { recursive: true });
      await writeFile(join(payload, 'index.html'), '<!doctype html>');
      const completed = name === 'green' ? newer : name === 'retired' ? retiredCompletion : old;
      for (const path of [join(payload, 'index.html'), payload, directory]) {
        await utimes(path, completed, completed);
      }
    }
    const lockPath = join(stacksRoot, 'source-bundles/publication.lock');
    const readdir = fs.promises.readdir;
    const readdirSync = fs.readdirSync;
    const linkSync = fs.linkSync;
    let qualified = false;
    let pinned = false;
    let qualificationHeldCustody = false;
    t.mock.method(fs.promises, 'readdir', async (path, ...args) =>
      String(path) === '/proc' ? [] : await readdir(path, ...args));
    t.mock.method(fs, 'readdirSync', (path, ...args) => {
      if (String(path) !== '/proc') return readdirSync(path, ...args);
      qualificationHeldCustody ||= existsSync(lockPath);
      qualified = true;
      return [];
    });
    t.mock.method(fs, 'linkSync', (from, to) => {
      // Model a selection committed just ahead of retirement custody, after
      // all age/process qualification. Fresh canonical pins must win.
      if (String(to) === lockPath && qualified && !pinned) {
        pinned = true;
        fs.writeFileSync(join(sourceRoot, 'selected-ui.json'), JSON.stringify({ exportDir: join(sourceRoot, 'web-late/export') }));
      }
      return linkSync(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = await reclaimPrivateSourceWebExports({ stacksRoot, stackNames: ['consumer'], dryRun: false });
    assert.equal(qualified, true);
    assert.equal(qualificationHeldCustody, false, 'historical process census does not hold publication admission');
    assert.equal(pinned, true);
    assert.equal(existsSync(join(sourceRoot, 'web-late/export/index.html')), true);
    assert.equal(existsSync(join(sourceRoot, 'web-green/export/index.html')), true);
    assert.equal(existsSync(join(sourceRoot, 'web-obsolete')), false);
    assert.equal(existsSync(join(sourceRoot, '.retired-web-interrupted')), false);
    assert.equal(result.stacks[0].reclaimedRoots, 2);
  });

test('reclamation rechecks fingerprint custody acquired after nomination',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-publication-late-fingerprint-' });
    const stacksRoot = fixture.path('stacks');
    const stackBaseDir = join(stacksRoot, 'consumer');
    const fingerprint = 'a'.repeat(64);
    const candidate = await completedBundle(stacksRoot, 'candidate', Date.now() - 10000);
    const recordPath = join(candidate.directory, 'source-bundle.json');
    await writeFile(recordPath, JSON.stringify({ component: 'server', entrypoint: candidate.entrypoint, reuseFingerprint: fingerprint }));
    const older = new Date(Date.now() - 10000);
    await utimes(recordPath, older, older);
    const newest = await completedBundle(stacksRoot, 'newest');
    await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
    const readdir = fs.promises.readdir;
    let release;
    let lease;
    let leased = false;
    t.mock.method(fs.promises, 'readdir', async (path, ...args) => {
      if (String(path) !== '/proc') return await readdir(path, ...args);
      if (!leased) {
        const acquired = Promise.withResolvers();
        const completion = Promise.withResolvers();
        release = completion.resolve;
        lease = withWorkspaceBundleLock(async () => {
          leased = true;
          acquired.resolve();
          await completion.promise;
        }, { lockPath: sourceBundleBuildLockPath(join(stacksRoot, 'source-bundles'), fingerprint), wait: false });
        void lease.catch(acquired.reject);
        await acquired.promise;
      }
      return [];
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    try {
      await withSourceBundlePublication({ stackBaseDir, outputDir: newest.directory }, async () => {
        await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint: newest.entrypoint }));
      });
      assert.equal(leased, true);
      assert.equal(existsSync(candidate.entrypoint), true, 'the newly acquired canonical build lock protects the unselected older graph');
    } finally {
      release?.();
      await lease;
    }
  });

for (const cleanupFails of [false, true]) {
  test(`failed publication retires outside custody and preserves ${cleanupFails ? 'both failures when cleanup fails' : 'the original failure'}`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-publication-failed-retirement-' });
    const stacksRoot = fixture.path('stacks');
    const bundleRoot = join(stacksRoot, 'source-bundles');
    const stackBaseDir = join(stacksRoot, 'consumer');
    const previous = await completedBundle(stacksRoot, 'previous');
    const failed = await completedBundle(stacksRoot, 'failed');
    await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
    const selectionPath = join(stackBaseDir, 'source-runtime/selected-server.json');
    await writeFile(selectionPath, JSON.stringify({ entrypoint: previous.entrypoint }));
    const selection = await readFile(selectionPath, 'utf8');
    const failure = new Error('publication failed');
    const cleanupFailure = Object.assign(new Error('retirement unavailable'), { code: 'EACCES' });
    const lockPath = join(bundleRoot, 'publication.lock');
    const renameSync = fs.renameSync;
    const rm = fs.promises.rm;
    let hiddenUnderCustody = false;
    let cleanupHeldCustody = false;
    let cleanupAttempted = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (String(from) === failed.directory) {
        hiddenUnderCustody = existsSync(lockPath);
        assert.equal(dirname(String(to)), bundleRoot);
        assert.equal(String(to).startsWith(join(bundleRoot, '.retired-')), true);
      }
      return renameSync(from, to);
    });
    t.mock.method(fs.promises, 'rm', async (path, ...args) => {
      if (dirname(String(path)) === bundleRoot && args[0]?.recursive) {
        cleanupAttempted = true;
        cleanupHeldCustody ||= existsSync(lockPath);
        if (cleanupFails) throw cleanupFailure;
      }
      return await rm(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(withSourceBundlePublication({ stackBaseDir, outputDir: failed.directory,
      record: { component: 'server', entrypoint: failed.entrypoint } }, async () => { throw failure; }), error => {
      if (!cleanupFails) return error === failure;
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [failure, cleanupFailure]);
      return true;
    });
    assert.equal(hiddenUnderCustody, true, 'the failed product name is hidden before another adopter can enter');
    assert.equal(cleanupAttempted, true);
    assert.equal(cleanupHeldCustody, false, 'recursive failed-product cleanup runs after publication release');
    assert.equal(existsSync(failed.directory), false);
    assert.equal(existsSync(previous.entrypoint), true);
    assert.equal(await readFile(selectionPath, 'utf8'), selection);
  });
}
