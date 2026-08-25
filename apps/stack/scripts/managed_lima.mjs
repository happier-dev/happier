import './utils/env/env.mjs';

import { readFile } from 'node:fs/promises';

import { createManagedLimaHostExecutor } from './utils/managed_lima/host_executor.mjs';
import {
  getManagedLimaStatus,
  startManagedLimaInstance,
  stopManagedLimaInstance,
} from './utils/managed_lima/lifecycle.mjs';
import {
  doctorManagedLimaInstance,
  setupManagedLimaRuntime,
} from './utils/managed_lima/manager.mjs';
import { publishManagedLimaLocalSshConfig } from './utils/managed_lima/ssh_publication.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';

function flagValue(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return '';
}

function usage(json) {
  printResult({
    json,
    data: { commands: ['setup', 'status', 'doctor', 'start', 'stop', 'shell', 'ssh-config'] },
    text: [
      '[managed-lima] usage:',
      '  hstack tools managed-lima setup --instance=NAME [--profile=balanced] [--guest-profile=happier] [--lima-home=PATH] [--no-install] [--json]',
      '  hstack tools managed-lima status|doctor|start|stop --instance=NAME [--profile=balanced] [--lima-home=PATH] [--json]',
      '  hstack tools managed-lima shell --instance=NAME [--lima-home=PATH] -- COMMAND [ARG...]',
      '  hstack tools managed-lima ssh-config --instance=NAME --output=/absolute/guest.conf [--alias=happier-agent-primary]',
      '',
      'Remote outer Mac host:',
      '  add --host-ssh=ALIAS --host-ssh-config=/absolute/ssh.config',
      '',
      'This owner never deletes or recreates a retained instance.',
    ].join('\n'),
  });
}

function resolveHost(argv) {
  const ssh = flagValue(argv, '--host-ssh').trim();
  const sshConfigFile = flagValue(argv, '--host-ssh-config').trim();
  if (Boolean(ssh) !== Boolean(sshConfigFile)) {
    throw new Error('[managed-lima] --host-ssh and --host-ssh-config must be provided together');
  }
  return ssh ? { kind: 'ssh', ssh, sshConfigFile } : { kind: 'local' };
}

function renderStatus(result) {
  if ('ok' in result) {
    const driftCount = Object.values(result.drift ?? {}).reduce((sum, entries) => sum + entries.length, 0);
    return [
      `[managed-lima] doctor: ${result.ok ? 'ok' : 'attention required'}`,
      `[managed-lima] status: ${result.status}`,
      `[managed-lima] drift entries: ${driftCount}`,
    ].join('\n');
  }
  return `[managed-lima] status: ${result.status}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const json = wantsJson(argv);
  const command = argv.find((arg) => !arg.startsWith('-')) ?? '';
  if (!command || command === 'help' || wantsHelp(argv)) return usage(json);
  const instance = flagValue(argv, '--instance').trim();
  if (!instance) throw new Error('[managed-lima] --instance is required');
  const profileName = flagValue(argv, '--profile').trim() || 'balanced';
  const limaHome = flagValue(argv, '--lima-home').trim();
  const host = resolveHost(argv);
  const executor = createManagedLimaHostExecutor(
    host,
    undefined,
    process.env,
    { hostEnvironment: limaHome ? { LIMA_HOME: limaHome } : {} },
  );

  let result;
  if (command === 'setup') {
    const guestProvisionScriptSource = await readFile(
      new URL('./provision/linux-ubuntu-provision.sh', import.meta.url),
      'utf8',
    );
    result = await setupManagedLimaRuntime({
      executor,
      instance,
      profileName,
      allowInstall: !argv.includes('--no-install'),
      guestProvisionScriptSource,
      guestProvisionProfile: flagValue(argv, '--guest-profile').trim() || 'happier',
      nodeMajor: flagValue(argv, '--node-major').trim() || '24',
      yarnVersion: flagValue(argv, '--yarn-version').trim() || '1.22.22',
    });
  } else if (command === 'status') {
    result = await getManagedLimaStatus({ executor, instance });
  } else if (command === 'doctor') {
    result = await doctorManagedLimaInstance({ executor, instance, profileName });
  } else if (command === 'start') {
    result = await startManagedLimaInstance({ executor, instance });
  } else if (command === 'stop') {
    result = await stopManagedLimaInstance({ executor, instance });
  } else if (command === 'shell') {
    const separator = argv.indexOf('--');
    const guestArgs = separator >= 0 ? argv.slice(separator + 1) : [];
    await executor.run('limactl', ['shell', instance, '--', ...guestArgs]);
    return;
  } else if (command === 'ssh-config') {
    if (host.kind !== 'local') {
      throw new Error('[managed-lima] remote outer-host SSH publication is owned by managed Dev Target enrollment');
    }
    const current = await getManagedLimaStatus({ executor, instance });
    if (!current.exists) throw new Error(`[managed-lima] retained instance ${instance} does not exist`);
    result = await publishManagedLimaLocalSshConfig({
      instance: current.instance,
      destination: flagValue(argv, '--output').trim(),
      alias: flagValue(argv, '--alias').trim() || `lima-${instance}`,
    });
  } else {
    throw new Error(`[managed-lima] unknown command: ${command}`);
  }

  printResult({ json, data: result, text: renderStatus(result) });
  if (command === 'doctor' && result.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
