import assert from 'node:assert/strict';
import test from 'node:test';

import { runDevTargetsDoctor } from './doctor.mjs';

const targets = [
  {
    name: 'linux',
    platform: 'posix',
    ssh: 'happier-stack-linux',
    sshConfigFile: '/tmp/linux-ssh.config',
    repoDir: '/home/dev/happier',
    cliHomeDir: '/home/dev/.happier/linux',
    remoteServerPort: null,
  },
  {
    name: 'windows',
    platform: 'windows',
    ssh: 'happier-stack-windows',
    repoDir: 'C:/Users/test_qa/happier',
    cliHomeDir: 'C:/Users/test_qa/.happier/windows',
    remoteServerPort: null,
  },
];

test('dev-target doctor checks Mutagen and each target through passwordless SSH', async () => {
  const calls = [];
  const result = await runDevTargetsDoctor(
    { targets, env: { PATH: '/test/bin' } },
    {
      async runProcess(input) {
        calls.push(input);
        return { code: input.args.includes('happier-stack-windows') ? 1 : 0 };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.mutagen, { ok: true, code: 0 });
  assert.deepEqual(
    result.targets.map((target) => ({ name: target.name, ok: target.ok, code: target.code })),
    [
      { name: 'linux', ok: true, code: 0 },
      { name: 'windows', ok: false, code: 1 },
    ],
  );
  assert.deepEqual(calls[0], {
    label: 'mutagen',
    command: 'mutagen',
    args: ['version'],
    env: { PATH: '/test/bin' },
  });
  assert.deepEqual(calls[1].args.slice(0, 7), [
    '-F',
    '/tmp/linux-ssh.config',
    '-o',
    'ControlMaster=no',
    '-o',
    'BatchMode=yes',
    '-o',
  ]);
  assert.match(calls[1].args.at(-1), /command -v node/);
  const encodedPowerShell = calls[2].args.at(-1).split(' ').at(-1);
  const decodedPowerShell = Buffer.from(encodedPowerShell, 'base64').toString('utf16le');
  assert.match(decodedPowerShell, /Get-Command node/);
  assert.match(decodedPowerShell, /Get-Command corepack/);
});
