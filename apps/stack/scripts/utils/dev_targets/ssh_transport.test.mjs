import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolveDevTargetSshDiagnostic } from './ssh_transport.mjs';
import { retireStackDevTarget } from './retirement.mjs';

const target = { name: 'offline', ssh: '127.0.0.1', platform: 'posix', repoDir: '/fixture/repo', cliHomeDir: '/fixture/home' };

test('a real failed SSH ProxyCommand is classified and deferred by retirement',
  { skip: process.platform === 'win32' }, async () => {
    const sshArgs = ['-F', '/dev/null', '-o', 'ProxyCommand=exit 1'];
    const runProcess = async ({ command, args }) => {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      assert.ifError(result.error);
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    const result = await runProcess({ command: 'ssh', args: [...sshArgs, target.ssh, 'true'] });
    assert.equal(result.code, 255);
    assert.equal(resolveDevTargetSshDiagnostic(result), 'ssh-connect-unreachable');
    await assert.rejects(retireStackDevTarget({ target, options: { stackName: 'fixture' }, sshArgs }, { runProcess }),
      { code: 'EDEVTARGETUNREACHABLE' });
  });

for (const diagnostic of [
  'ssh: connect to host offline port 22: Connection refused',
  'Connection timed out during banner exchange',
  'banner exchange: Connection to UNKNOWN port 65535: Broken pipe',
  'Connection closed by UNKNOWN port 65535',
  'Connection closed by 127.0.0.1 port 22',
  'kex_exchange_identification: Connection closed by remote host',
  'kex_exchange_identification: read: Connection reset by peer',
  'stdio forwarding failed',
  'ssh: Could not resolve hostname offline: Name or service not known',
]) {
  test(`transport unreachability defers retirement: ${diagnostic}`, async () => {
    await assert.rejects(retireStackDevTarget({ target, options: { stackName: 'fixture' } }, {
      runProcess: async () => ({ code: 255, err: diagnostic }),
    }), { code: 'EDEVTARGETUNREACHABLE' });
  });
}

for (const result of [
  { code: 255, err: 'Permission denied (publickey).' },
  { code: 255, err: 'Host key verification failed.' },
  { code: 255, err: 'unrecognized failure' },
  { code: 1, err: 'Connection closed by remote host' },
]) {
  test(`retirement keeps non-connectivity failure closed: ${result.err}`, async () => {
    await assert.rejects(retireStackDevTarget({ target, options: { stackName: 'fixture' } }, {
      runProcess: async () => result,
    }), error => error.code !== 'EDEVTARGETUNREACHABLE');
  });
}
