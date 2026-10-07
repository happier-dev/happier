import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
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
