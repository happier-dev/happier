import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { provisionManagedWslDevTarget, runManagedWslOperation } from './managed_wsl.mjs';
import { renderSshConfig } from './provision.mjs';

test('WSL provisioning streams the canonical Bun version and preserves an explicit override', async () => {
  const pinnedVersion = (await readFile(new URL('../../provision/.bun-version', import.meta.url), 'utf8')).trim();
  const target = { name: 'fixture', managedRuntime: { kind: 'wsl', instance: 'fixture', user: 'happier',
    host: { ssh: 'fixture', sshConfigFile: '/fixture/config' },
    capacity: { mode: 'dedicated', shared: { cpus: 8, memoryGiB: 8 }, dedicated: { cpus: 12, memoryGiB: 12 } } } };
  for (const explicit of ['', '9.9.9']) {
    await runManagedWslOperation({ target, action: 'Provision', env: { HAPPIER_PROVISION_BUN_VERSION: explicit } }, {
      // Only the remote SSH/PowerShell process boundary is simulated.
      runCaptureResult: async (_command, _args, { input }) => {
        const command = Buffer.from(input.trim(), 'base64').toString('utf8');
        const encodedProvision = command.match(/-ProvisionBase64 '([A-Za-z0-9+/=]+)'/)?.[1];
        assert.ok(encodedProvision);
        const provision = Buffer.from(encodedProvision, 'base64').toString('utf8');
        assert.ok(provision.startsWith(`export HAPPIER_PROVISION_BUN_VERSION=${explicit || pinnedVersion}\n`));
        return { exitCode: 0, out: '__HAPPIER_WSL__=' + JSON.stringify({ exists: true, status: 'Running', ok: true, guestToolchain: { ok: true } }) };
      },
    });
  }
});

test('WSL workers on different Windows hosts cannot share an SSH multiplex connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-wsl-ssh-'));
  try {
    const keyPath = join(root, 'controller');
    await writeFile(keyPath + '.pub', 'ssh-ed25519 AAAATEST controller');
    const capacity = { mode: 'dedicated', shared: { cpus: 8, memoryGiB: 8 }, dedicated: { cpus: 12, memoryGiB: 12 } };
    const configs = [];
    for (const name of ['windows1-linux', 'windows2-linux']) {
      const outerConfig = join(root, name + '.config');
      await writeFile(outerConfig, renderSshConfig({ sshAlias: name + '-host', remoteHost: name, remoteUser: 'worker', keyPath, knownHostsPath: join(root, 'known-hosts'), strictHostKeyChecking: 'yes' }));
      const target = await provisionManagedWslDevTarget({ name, outerTarget: { platform: 'windows', ssh: name + '-host', sshConfigFile: outerConfig }, stackBaseDir: root, instance: name, capacity }, {
        // SSH is the OS/network boundary; config normalization and publication stay real.
        runCaptureResult: async (_command, args) => args.at(-1).startsWith('powershell.exe')
          ? { ok: true, exitCode: 0, out: '__HAPPIER_WSL__=' + JSON.stringify({ exists: true, status: 'Running', ok: true, guestToolchain: { ok: true }, guestHostKey: 'ssh-ed25519 AAAATEST guest' }) }
          : { ok: true, exitCode: 0, out: '' },
      });
      const resolved = spawnSync('ssh', ['-G', '-F', target.sshConfigFile, target.ssh], { encoding: 'utf8' });
      assert.equal(resolved.status, 0, resolved.stderr);
      configs.push(resolved.stdout);
    }
    const controlPaths = configs.map((config) => config.match(/^controlpath\s+(.+)$/m)?.[1]);
    assert.ok(controlPaths.every(Boolean));
    assert.notEqual(controlPaths[0], controlPaths[1], 'localhost:2222 is shared across outer hosts; multiplex identity must include the worker');
  } finally { await rm(root, { recursive: true, force: true }); }
});
