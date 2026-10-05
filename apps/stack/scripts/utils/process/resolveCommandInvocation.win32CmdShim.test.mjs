import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('workspace command resolution can bootstrap with a stale installed cli-common export', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hstack-stale-command-invocation-'));
  try {
    const packageRoot = fileURLToPath(new URL('../../../../../packages/cli-common/', import.meta.url));
    const sourcePackage = join(temp, 'packages', 'cli-common');
    const stackRoot = join(temp, 'apps', 'stack');
    const fixturePackage = join(stackRoot, 'node_modules', '@happier-dev', 'cli-common');
    const adapter = join(stackRoot, 'scripts', 'utils', 'process', 'resolveCommandInvocation.mjs');
    await mkdir(sourcePackage, { recursive: true });
    await mkdir(fixturePackage, { recursive: true });
    await mkdir(join(stackRoot, 'scripts', 'utils', 'process'), { recursive: true });
    await copyFile(join(packageRoot, 'windowsCommandInvocation.mjs'), join(sourcePackage, 'windowsCommandInvocation.mjs'));
    // The installed package predates this export. Keep module resolution real.
    await writeFile(join(fixturePackage, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common', type: 'module', exports: { '.': './index.mjs' },
    }));
    await copyFile(new URL('./resolveCommandInvocation.mjs', import.meta.url), adapter);
    await writeFile(join(temp, 'npm.CMD'), '@echo off\r\necho ok\r\n');
    for (const platform of ['linux', 'darwin', 'win32']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
        `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
        `const { resolveCommandInvocation } = await import(${JSON.stringify(pathToFileURL(adapter).href)});`,
        `console.log(JSON.stringify(resolveCommandInvocation({ command: 'npm', args: ['--version'], env: { PATH: ${JSON.stringify(temp)}, PATHEXT: '.CMD', COMSPEC: 'cmd.exe' } })));`,
      ].join('\n')], { cwd: temp, encoding: 'utf8' });
      assert.equal(child.status, 0, `${platform}: ${child.stderr}`);
      const invocation = JSON.parse(child.stdout);
      if (platform === 'win32') {
        assert.equal(invocation.command, 'cmd.exe');
        assert.ok(String(invocation.args[3]).includes('npm.CMD'));
      } else {
        assert.deepEqual(invocation, { command: 'npm', args: ['--version'] });
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('resolves a Windows command shim before cli-common has any built output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hstack-win32-invocation-'));
  try {
    // The filesystem/module-resolution boundary reproduces a fresh workspace, without touching its real dist.
    const packageRoot = fileURLToPath(new URL('../../../../../packages/cli-common/', import.meta.url));
    const fixturePackage = join(temp, 'node_modules', '@happier-dev', 'cli-common');
    await mkdir(fixturePackage, { recursive: true });
    await copyFile(join(packageRoot, 'package.json'), join(fixturePackage, 'package.json'));
    const sourceOwner = join(packageRoot, 'windowsCommandInvocation.mjs');
    if (existsSync(sourceOwner)) await copyFile(sourceOwner, join(fixturePackage, 'windowsCommandInvocation.mjs'));
    const adapter = join(temp, 'resolveCommandInvocation.mjs');
    await copyFile(new URL('./resolveCommandInvocation.mjs', import.meta.url), adapter);
    const npmCmd = join(temp, 'npm.CMD');
    await writeFile(npmCmd, '@echo off\r\necho ok\r\n', 'utf8');
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', [
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      `const { resolveCommandInvocation } = await import(${JSON.stringify(pathToFileURL(adapter).href)});`,
      `console.log(JSON.stringify(resolveCommandInvocation({ command: 'npm', args: ['--version'], env: { PATH: ${JSON.stringify(temp)}, PATHEXT: '.CMD', COMSPEC: 'cmd.exe' } })));`,
    ].join('\n')], {
      cwd: temp,
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
