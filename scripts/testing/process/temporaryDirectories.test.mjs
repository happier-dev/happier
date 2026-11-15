import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = new URL('./temporaryDirectories.mjs', import.meta.url).href;

test('normal creator exit preserves a temporary root inherited by a detached child', { skip: process.platform !== 'linux' }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'temporary-directories-child-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(helper)};
    import { spawn } from 'node:child_process';
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(parent)});
    const descendant = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    descendant.unref();
    console.log(JSON.stringify({ root: fixture.root, descendant: descendant.pid }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  assert.deepEqual(await once(child, 'close'), [0, null], error);
  const fixture = JSON.parse(output.trim());
  t.after(() => { try { process.kill(fixture.descendant, 'SIGTERM'); } catch {} });
  await access(fixture.root);
});

test('a later run reclaims roots its signal-terminated workers abandoned, counting none left', { skip: process.platform !== 'linux' }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'temporary-directories-abandoned-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const create = `import { createTestTempDirectory } from ${JSON.stringify(helper)}; createTestTempDirectory('happier-test-home-', ${JSON.stringify(parent)});`;
  // A pool worker inherits the run's binding, creates its own Home and is
  // terminated by signal (Tinypool's teardown), so no exit cleanup runs.
  const worker = `${create} process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);`;
  const run = async source => {
    const env = { ...process.env };
    delete env.HAPPIER_TEST_TEMP_ROOTS;
    // Each run is its own top-level producer in its own process group.
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    assert.deepEqual(await once(child, 'close'), [0, null], error);
  };
  const homes = async () => (await readdir(parent)).filter(name => name.startsWith('happier-test-home-')).length;
  await run(`${create}
    import { spawnSync } from 'node:child_process';
    const worker = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(worker)}]);
    if (worker.signal !== 'SIGTERM') throw new Error('worker was not signal-terminated');`);
  assert.equal(await homes(), 1, 'the terminated worker abandons exactly its own Home');
  await run(create);
  assert.equal(await homes(), 0);
});

test('test temporary roots disappear on normal process exit, including failure exit', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'temporary-directories-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const code of [0, 1]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createTestTempDirectory } from ${JSON.stringify(helper)}; const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(parent)}); console.log(fixture.root); process.exit(${code});`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    assert.deepEqual(await once(child, 'close'), [code, null], error);
    assert.ok(output.trim().startsWith(parent), error);
    await assert.rejects(access(output.trim()), { code: 'ENOENT' });
  }
});

test('owned read-only module trees are removable without changing external link targets', { skip: process.platform === 'win32' }, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'temporary-directories-readonly-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createTestTempDirectory } from ${JSON.stringify(helper)};
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(parent)});
    const moduleRoot = join(fixture.root, 'user', 'go', 'pkg', 'mod', 'example.test', 'module@v1');
    const external = join(${JSON.stringify(parent)}, 'outside-fixture');
    mkdirSync(moduleRoot, { recursive: true });
    mkdirSync(external);
    writeFileSync(join(moduleRoot, 'go.mod'), 'module example.test/module');
    writeFileSync(join(external, 'keep'), 'external bytes');
    linkSync(join(external, 'keep'), join(moduleRoot, 'external-file'));
    symlinkSync(external, join(fixture.root, 'external'));
    chmodSync(join(external, 'keep'), 0o444);
    chmodSync(join(moduleRoot, 'go.mod'), 0o444);
    chmodSync(moduleRoot, 0o555);
    chmodSync(external, 0o555);
    try {
      fixture.cleanup();
      assert.equal(existsSync(fixture.root), false);
      assert.equal(statSync(external).mode & 0o777, 0o555);
      assert.equal(statSync(join(external, 'keep')).mode & 0o777, 0o444);
      assert.equal(readFileSync(join(external, 'keep'), 'utf8'), 'external bytes');
    } finally {
      if (existsSync(moduleRoot)) chmodSync(moduleRoot, 0o755);
      chmodSync(external, 0o755);
    }
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  assert.deepEqual(await once(child, 'close'), [0, null], error);
});
