import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../testkit/core/native_admission_fixture.mjs';
import { spawnTestProcess } from '../../testkit/core/spawn_test_process.mjs';
import { withDependencyRefreshLock } from '../proc/dependency_refresh.mjs';

const refreshOwner = new URL('../proc/dependency_refresh.mjs', import.meta.url).href;
const preparationOwner = new URL('./remote_validation_preparation.mjs', import.meta.url).href;

function child(t, source, env) {
  const process = spawnTestProcess(globalThis.process.execPath, ['--input-type=module', '--eval', source], {
    env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  const waiting = Promise.withResolvers();
  process.stderr.on('data', value => {
    stderr += value;
    if (/dependency refresh lock/.test(stderr)) waiting.resolve('waiting');
  });
  const messages = [];
  const listeners = [];
  process.on('message', message => {
    if (listeners.length) listeners.shift()(message);
    else messages.push(message);
  });
  const closed = once(process, 'close').then(([code, signal]) => ({ code, signal, stderr }));
  const message = () => Promise.race([
    messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => listeners.push(resolve)),
    closed.then(result => { throw new Error(`Child exited before its IPC message (${result.code}): ${result.stderr}`); }),
  ]);
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill();
    await closed;
  });
  return { process, message, closed, waiting: waiting.promise };
}

test('preparation waits for the active dependency writer and retains no lease through its payload', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-writer-only-preparation-' });
  const env = { ...buildNativeAdmissionFixtureEnv(),
    HAPPIER_STACK_HOME_DIR: fixture.root, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
    HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0', HAPPIER_WORKSPACE_BUILD_NOTICE_EVERY_MS: '0',
    READER_INSTALL_ROOT: fixture.root };
  await mkdir(fixture.path('node_modules'));
  await mkdir(fixture.path('apps/stack'), { recursive: true });
  await writeFile(fixture.path('package.json'), '{"private":true}');
  const entryPath = fixture.path('apps/stack/scripts/utils/dev_targets/remote_validation_preparation.mjs');
  await mkdir(join(entryPath, '..'), { recursive: true });
  await copyFile(new URL(preparationOwner), entryPath);
  const fixtureEntry = pathToFileURL(entryPath).href;
  const writer = child(t, `
    import { once } from 'node:events';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { withDependencyRefresh } from ${JSON.stringify(refreshOwner)};
    const root = process.env.READER_INSTALL_ROOT;
    await withDependencyRefresh({ installDir: root, env: process.env, force: true }, async () => {
      const resume = once(process, 'message'); process.send('installing'); await resume;
      await writeFile(join(root, 'node_modules/reader.cjs'), 'module.exports = "complete";');
    });
    process.send('published'); process.disconnect();
  `, env);
  assert.equal(await writer.message(), 'installing');
  const readerSource = `
    import { once } from 'node:events';
    import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    const root = process.env.READER_INSTALL_ROOT;
    // Redirect only filesystem module resolution; execute the real preparation
    // owner and implementation against this fixture's installation authority.
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(fixtureEntry)} && specifier.startsWith('.')) {
        return next(new URL(specifier, ${JSON.stringify(preparationOwner)}).href, context);
      }
      return next(specifier, context);
    }, load(url, context, next) {
      if (url.includes('/node_modules/') && !existsSync(join(root, 'node_modules/.happier-stack-dependencies-ready'))) {
        throw new Error('DEPENDENCY_READ_BEFORE_WRITER_PUBLICATION');
      }
      return next(url, context);
    } });
    process.argv = [process.execPath, fileURLToPath(${JSON.stringify(fixtureEntry)}),
      '--repo-dir=' + root, '--component-relative-dir=apps/stack', '--validation-kind=source-test'];
    await import(${JSON.stringify(fixtureEntry)});
    const assert = (await import('node:assert/strict')).default;
    assert.equal((await import(pathToFileURL(join(root, 'node_modules/reader.cjs')).href)).default, 'complete');
    const resume = once(process, 'message'); process.send('complete'); await resume;
    process.disconnect();
  `;
  const reader = child(t, readerSource, env);
  const first = await Promise.race([reader.waiting, reader.closed]);
  writer.process.send('finish-install');
  assert.equal(await writer.message(), 'published');
  assert.equal((await writer.closed).code, 0);
  assert.equal(first, 'waiting', typeof first === 'object' ? first.stderr : undefined);
  assert.equal(await reader.message(), 'complete');
  let writerEntries = 0;
  await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, () => { writerEntries++; });
  assert.equal(writerEntries, 1, 'the live payload retains zero writer-excluding dependency leases');
  reader.process.send('finish-reader');
  assert.equal((await reader.closed).code, 0);
  const warm = child(t, readerSource, env);
  assert.equal(await warm.message(), 'complete');
  await withDependencyRefreshLock({ installDir: fixture.root, env, wait: false }, () => {});
  warm.process.send('finish-reader');
  const result = await warm.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /dependency refresh lock/);
});
