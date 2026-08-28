import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';
import { startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';

const HOST_ONLY_COMMANDS = new Set([
  'dev-vm',
  'init',
  'setup',
  'setup-from-source',
  'uninstall',
  'mobile',
  'mobile-dev-client',
  'eas',
  'tailscale',
  'service',
  'menubar',
]);

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function commandToken(argv) {
  return (Array.isArray(argv) ? argv : []).find((arg) => !String(arg).startsWith('-')) ?? '';
}

export function shouldDelegateToActiveExecutionHost({
  profile,
  argv,
  platform = process.platform,
  env = process.env,
}) {
  if (!profile || profile.activation !== 'active' || profile.mode !== 'managed-lima') return false;
  if (platform !== 'darwin') return false;
  if (truthy(env.CI) || String(env.HAPPIER_STACK_SANDBOX_DIR ?? '').trim()) return false;
  if (truthy(env.HAPPIER_STACK_EXECUTION_HOST_REENTRY)) return false;
  const command = commandToken(argv);
  if (!command || HOST_ONLY_COMMANDS.has(command)) return false;
  if (command === 'tools') {
    const positionals = argv.filter((arg) => !String(arg).startsWith('-'));
    if (positionals[1] === 'managed-lima') return false;
  }
  return true;
}

export async function inspectExecutionHost({ profile, doctor = doctorManagedLimaInstance, executor }) {
  if (!profile) {
    return { configured: false, authoritative: false, activation: null, doctor: null };
  }
  const diagnosis = await doctor({
    executor,
    instance: profile.instance,
    profileName: profile.profile,
  });
  return {
    configured: true,
    authoritative: profile.activation === 'active',
    activation: profile.activation,
    profile,
    doctor: diagnosis,
  };
}

export async function executeCandidateHostCommand({
  profile,
  executor,
  guestCwd,
  command,
  args = [],
  doctor = doctorManagedLimaInstance,
}) {
  if (!profile || profile.mode !== 'managed-lima') throw new Error('[execution-host] managed Lima profile is required');
  const cwd = String(guestCwd ?? '').trim();
  if (!cwd.startsWith('/') || /[\0\r\n]/.test(cwd)) throw new Error('[execution-host] guest cwd must be an absolute path');
  const executable = String(command ?? '').trim();
  if (!executable || /[\0\r\n]/.test(executable)) throw new Error('[execution-host] command is required');
  await startManagedLimaInstance({ executor, instance: profile.instance });
  const diagnosis = await doctor({
    executor,
    instance: profile.instance,
    profileName: profile.profile,
  });
  if (diagnosis.ok !== true) {
    throw new Error('[execution-host] managed Lima doctor reported drift; run `hstack dev-vm doctor` before execution');
  }
  const result = await executor.run('limactl', [
    'shell', '--workdir', cwd, profile.instance, '--', executable, ...args,
  ]);
  return result ?? { exitCode: 0 };
}
