import test from 'node:test';
import assert from 'node:assert/strict';

test('resolveYarnCommandInvocation wraps Windows Corepack through cmd.exe and ignores npm-cli npm_execpath', async () => {
  const mod = await import('./execYarnCommand.mjs');

  assert.equal(typeof mod.resolveYarnCommandInvocation, 'function');

  const invocation = mod.resolveYarnCommandInvocation(['-s', 'workspace', '@happier-dev/cli', 'build'], {
    platform: 'win32',
    npmExecPath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args.join(' '), /corepack\.cmd/);
  assert.match(invocation.args.join(' '), /yarn/);
  assert.match(invocation.args.join(' '), /@happier-dev\/cli/);
  assert.doesNotMatch(invocation.args.join(' '), /npm-cli\.js/);
});

test('resolveYarnCommandInvocation uses Corepack when no parent package manager is available', async () => {
  const mod = await import('./execYarnCommand.mjs');
  assert.deepEqual(mod.resolveYarnCommandInvocation(['-s', 'build'], {
    platform: 'darwin',
    npmExecPath: '',
  }), {
    command: 'corepack',
    args: ['yarn', '-s', 'build'],
  });
});

test('resolveYarnCommandInvocation executes a Windows Yarn npm_execpath with spaces through node', async () => {
  const mod = await import('./execYarnCommand.mjs');

  assert.equal(typeof mod.resolveYarnCommandInvocation, 'function');

  const invocation = mod.resolveYarnCommandInvocation(['-s', 'build'], {
    platform: 'win32',
    npmExecPath: 'C:\\Program Files\\Corepack\\yarn\\lib\\cli.js',
    processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
  });

  assert.deepEqual(invocation, {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Program Files\\Corepack\\yarn\\lib\\cli.js', '-s', 'build'],
  });
});

test('resolveYarnCommandInvocation can require the repository package manager through Corepack', async () => {
  const mod = await import('./execYarnCommand.mjs');

  assert.deepEqual(
    mod.resolveYarnCommandInvocation(['install', '--ignore-scripts'], {
      platform: 'darwin',
      preferCorepack: true,
    }),
    {
      command: 'corepack',
      args: ['yarn', 'install', '--ignore-scripts'],
    },
  );
  const windows = mod.resolveYarnCommandInvocation(['install'], {
    platform: 'win32',
    preferCorepack: true,
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(windows.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(windows.args.join(' '), /corepack\.cmd.*yarn.*install/);
});
