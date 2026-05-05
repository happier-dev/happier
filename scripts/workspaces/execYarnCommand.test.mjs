import test from 'node:test';
import assert from 'node:assert/strict';

test('resolveYarnCommandInvocation wraps Windows yarn.cmd through cmd.exe and ignores npm-cli npm_execpath', async () => {
  const mod = await import('./execYarnCommand.mjs');

  assert.equal(typeof mod.resolveYarnCommandInvocation, 'function');

  const invocation = mod.resolveYarnCommandInvocation(['-s', 'workspace', '@happier-dev/cli', 'build'], {
    platform: 'win32',
    npmExecPath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args.join(' '), /yarn\.cmd/);
  assert.match(invocation.args.join(' '), /@happier-dev\/cli/);
  assert.doesNotMatch(invocation.args.join(' '), /npm-cli\.js/);
});

test('resolveYarnCommandInvocation executes Yarn npm_execpath through node with the requested args', async () => {
  const mod = await import('./execYarnCommand.mjs');

  assert.equal(typeof mod.resolveYarnCommandInvocation, 'function');

  const invocation = mod.resolveYarnCommandInvocation(['-s', 'build'], {
    platform: 'linux',
    npmExecPath: '/opt/yarn-v1.22.22/lib/cli.js',
    processExecPath: '/usr/local/bin/node',
  });

  assert.deepEqual(invocation, {
    command: '/usr/local/bin/node',
    args: ['/opt/yarn-v1.22.22/lib/cli.js', '-s', 'build'],
  });
});
