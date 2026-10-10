import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCaptureResult as capture } from '../proc/proc.mjs';
import { parseDevTargetsConfig, resolveManagedRuntimeCapacityResources } from './config.mjs';
import { buildRemoteEnsureDirectoriesCommand, buildRemotePowerShellCommand, powershellQuote } from './remote_commands.mjs';
import { readSshConfigDirective, renderGuestSshConfig } from './managed_worker.mjs';

export async function runManagedWslOperation(
  { target, action, publicKey = '', env = process.env },
  { runCaptureResult = capture } = {},
) {
  const runtime = target.managedRuntime;
  const resources = resolveManagedRuntimeCapacityResources(runtime);
  if (runtime?.kind !== 'wsl' || !resources) throw new Error('[dev-targets] configured WSL runtime and capacity required');
  const script = await readFile(new URL('../../provision/windows-wsl-worker.ps1', import.meta.url), 'utf8');
  let provision = '';
  if (action === 'Provision') {
    const bunVersion = String(env.HAPPIER_PROVISION_BUN_VERSION ?? '').trim()
      || (await readFile(new URL('../../provision/.bun-version', import.meta.url), 'utf8')).trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(bunVersion)) throw new Error('[dev-targets] invalid Bun provision version');
    // The guest receives a streamed script, not this package's adjacent files.
    provision = `export HAPPIER_PROVISION_BUN_VERSION=${bunVersion}\n`
      + await readFile(new URL('../../provision/linux-ubuntu-provision.sh', import.meta.url), 'utf8');
  }
  const invocation = [
    '-Action ' + powershellQuote(action),
    '-Instance ' + powershellQuote(runtime.instance),
    '-User ' + powershellQuote(runtime.user),
    '-Cpus ' + resources.cpus,
    '-MemoryGiB ' + resources.memoryGiB,
    '-PublicKey ' + powershellQuote(publicKey),
    '-ProvisionBase64 ' + powershellQuote(Buffer.from(provision).toString('base64')),
  ].join(' ');
  const input = Buffer.from('& {\n' + script + '\n} ' + invocation).toString('base64') + '\n';
  // Stream the script rather than exceeding Windows command-line limits.
  const remoteCommand = buildRemotePowerShellCommand('& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))');
  const result = await runCaptureResult('ssh', [
    '-T', '-F', runtime.host.sshConfigFile, '-o', 'BatchMode=yes',
    runtime.host.ssh, remoteCommand,
  ], { env, input, ...(action === 'Doctor' ? {} : { streamLabel: 'wsl:' + target.name }) });
  if (result.exitCode !== 0) {
    throw new Error('[dev-targets] WSL ' + action + ' failed: ' + String(result.err ?? result.out ?? '').trim());
  }
  const marker = String(result.out ?? '').match(/^__HAPPIER_WSL__=(.+)$/m);
  if (!marker) throw new Error('[dev-targets] WSL ' + action + ' returned no runtime status');
  const status = JSON.parse(marker[1]);
  if (typeof status.exists !== 'boolean' || !['Running', 'Stopped'].includes(status.status)) {
    throw new Error('[dev-targets] invalid WSL runtime status');
  }
  if (action !== 'Doctor' && (!status.ok || status.guestToolchain?.ok !== true)) {
    throw new Error('[dev-targets] WSL ' + action + ' did not establish a healthy guest');
  }
  return status;
}

export async function provisionManagedWslDevTarget({
  name, outerTarget, stackBaseDir, instance, user = 'happier',
  capacity, repoDir = null, cliHomeDir = null, env = process.env,
}, { runCaptureResult = capture } = {}) {
  if (outerTarget?.platform !== 'windows' || !outerTarget.sshConfigFile || outerTarget.managedRuntime) {
    throw new Error('[dev-targets] managed WSL provisioning requires an existing Windows SSH outer target');
  }
  const target = parseDevTargetsConfig({ version: 3, targets: [{
    name, platform: 'posix', ssh: 'happier-dev-target-' + name,
    sshConfigFile: join(stackBaseDir, 'dev-target-ssh', name, 'guest.ssh.config'),
    repoDir: repoDir ?? '/home/' + user + '/happier-dev',
    cliHomeDir: cliHomeDir ?? '/home/' + user + '/.happier/dev-targets/' + name,
    remotePath: ['/usr/local/bin', '/usr/bin', '/bin'], remoteServerPort: null,
    managedRuntime: {
      kind: 'wsl', instance, user,
      host: { kind: 'ssh', ssh: outerTarget.ssh, sshConfigFile: outerTarget.sshConfigFile },
      capacity,
    },
  }] }).targets[0];
  const outerConfig = await readFile(outerTarget.sshConfigFile, 'utf8');
  const privateKeyPath = readSshConfigDirective(outerConfig, 'IdentityFile');
  const publicKey = (await readFile(privateKeyPath + '.pub', 'utf8')).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(publicKey)) {
    throw new Error('[dev-targets] managed WSL requires the configured controller Ed25519 key');
  }
  const status = await runManagedWslOperation({ target, action: 'Provision', publicKey, env }, { runCaptureResult });
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(status.guestHostKey ?? '')) {
    throw new Error('[dev-targets] WSL guest did not return its authenticated host key');
  }
  await mkdir(dirname(target.sshConfigFile), { recursive: true, mode: 0o700 });
  const knownHostsPath = join(dirname(target.sshConfigFile), 'guest-known-hosts');
  await writeFile(knownHostsPath, target.ssh + ' ' + status.guestHostKey + '\n', { mode: 0o600 });
  const config = renderGuestSshConfig({
    alias: target.ssh, user, port: 2222, privateKeyPath, knownHostsPath,
    controlPath: '~/.ssh/happier-managed-%C',
    outerSsh: outerTarget.ssh, outerSshConfigFile: outerTarget.sshConfigFile,
    strictHostKeyChecking: 'yes',
  });
  const temporary = target.sshConfigFile + '.' + process.pid + '.tmp';
  await writeFile(temporary, config, { mode: 0o600 });
  await rename(temporary, target.sshConfigFile);
  await chmod(target.sshConfigFile, 0o600);
  const probe = await runCaptureResult('ssh', ['-T', '-F', target.sshConfigFile, target.ssh, buildRemoteEnsureDirectoriesCommand(target)], { env });
  if (!probe.ok) throw new Error('[dev-targets] WSL guest SSH verification failed: ' + probe.err);
  return target;
}
