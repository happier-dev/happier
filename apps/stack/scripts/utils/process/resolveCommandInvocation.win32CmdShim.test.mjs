import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('resolveCommandInvocation wraps .cmd commands with cmd.exe on Windows', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hstack-win32-invocation-'));
  try {
    const npmCmd = join(temp, 'npm.CMD');
    await writeFile(npmCmd, '@echo off\r\necho ok\r\n', 'utf8');
    const moduleUrl = new URL('./resolveCommandInvocation.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      `const { resolveCommandInvocation } = await import(${JSON.stringify(moduleUrl)});`,
      'const invocation = resolveCommandInvocation({',
      "  command: 'npm', args: ['--version'],",
      `  env: { ...process.env, PATH: ${JSON.stringify(temp)}, PATHEXT: '.CMD' },`,
      '});',
      'console.log(JSON.stringify(invocation));',
    ].join('\n')], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const invocation = JSON.parse(child.stdout);
    assert.equal(invocation.command, 'cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(String(invocation.args[3]).includes('npm.CMD'));
    assert.equal(invocation.windowsVerbatimArguments, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
