import {
  evaluateManagedLimaInstance,
  getManagedLimaStatus,
  reconcileManagedLimaInstance,
} from './lifecycle.mjs';
import { buildManagedLimaEditArgs, resolveManagedLimaProfile } from './profiles.mjs';
import {
  ensureManagedLimaGuestLoginManager,
  inspectManagedLimaGuestLoginManager,
  inspectManagedLimaGuestIdentity,
  provisionManagedLimaGuest,
} from './provisioner.mjs';

function managedLimaError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function probeLima(executor) {
  const result = await executor.capture('limactl', ['--version']);
  return result.exitCode === 0;
}

async function installLima(executor) {
  const brew = await executor.capture('brew', ['--version']);
  if (brew.exitCode !== 0) {
    throw managedLimaError(
      '[managed-lima] Homebrew is required for automatic Lima installation on the selected Mac host',
      'MANAGED_LIMA_HOMEBREW_NOT_INSTALLED',
    );
  }
  let installError = null;
  try {
    await executor.run('brew', ['install', 'lima']);
  } catch (error) {
    installError = error;
  }
  if (!await probeLima(executor)) {
    const error = managedLimaError(
      '[managed-lima] Homebrew installation did not make limactl available on the selected host PATH',
      'MANAGED_LIMA_INSTALL_FAILED',
    );
    if (installError) error.cause = installError;
    throw error;
  }
}

export async function setupManagedLimaInstance({
  executor,
  instance,
  profileName = 'balanced',
  architecture = 'aarch64',
  allowInstall = false,
}) {
  let installed = false;
  if (!await probeLima(executor)) {
    if (!allowInstall) {
      throw managedLimaError(
        '[managed-lima] Lima is not installed; run the explicit managed setup operation to install it',
        'MANAGED_LIMA_NOT_INSTALLED',
      );
    }
    await installLima(executor);
    installed = true;
  }
  const profile = resolveManagedLimaProfile(profileName, { architecture });
  let reconciliation;
  try {
    reconciliation = await reconcileManagedLimaInstance({ executor, instance, profile });
  } catch (error) {
    if (error?.code !== 'MANAGED_LIMA_RESOURCE_DRIFT' && error?.code !== 'MANAGED_LIMA_CONFIGURATION_DRIFT') {
      throw error;
    }
    const current = await getManagedLimaStatus({ executor, instance });
    if (!current.exists) throw error;
    const wantedDiskBytes = profile.diskGiB * 1024 ** 3;
    const actualDiskBytes = Number(current.instance?.disk ?? current.instance?.Disk);
    if (Number.isFinite(actualDiskBytes) && actualDiskBytes > wantedDiskBytes) {
      throw managedLimaError(
        `[managed-lima] refusing to shrink retained disk from ${actualDiskBytes} to ${wantedDiskBytes} bytes`,
        'MANAGED_LIMA_DISK_SHRINK_REFUSED',
      );
    }
    if (current.status.toLowerCase() === 'running') await executor.run('limactl', ['stop', instance]);
    await executor.run('limactl', buildManagedLimaEditArgs({ instance, profile }));
    await executor.run('limactl', ['start', instance]);
    reconciliation = { created: false, started: true, reconfigured: true, status: 'Running' };
  }
  return { installed, profile, ...reconciliation };
}

export async function setupManagedLimaRuntime({
  executor,
  instance,
  profileName = 'balanced',
  architecture = 'aarch64',
  allowInstall = false,
  guestProvisionScriptSource,
  guestProvisionProfile = 'happier',
  nodeMajor = '24',
  yarnVersion = '1.22.22',
  provisionGuest = provisionManagedLimaGuest,
  ensureGuestLoginManager = ensureManagedLimaGuestLoginManager,
  inspectGuest = inspectManagedLimaGuestIdentity,
}) {
  const lifecycle = await setupManagedLimaInstance({
    executor,
    instance,
    profileName,
    architecture,
    allowInstall,
  });
  const provision = await provisionGuest({
    executor,
    instance,
    scriptSource: guestProvisionScriptSource,
    profile: guestProvisionProfile,
    nodeMajor,
    yarnVersion,
  });
  const guestLoginManager = await ensureGuestLoginManager({ executor, instance });
  const guest = await inspectGuest({ executor, instance });
  return { ...lifecycle, provision, guestLoginManager, guest };
}

export async function doctorManagedLimaInstance({
  executor,
  instance,
  profileName = 'balanced',
  architecture = 'aarch64',
}) {
  const host = await executor.capture('uname', ['-s']);
  const lima = await executor.capture('limactl', ['--version']);
  if (host.exitCode !== 0 || lima.exitCode !== 0) {
    return {
      ok: false,
      exists: false,
      host: String(host.out ?? '').trim() || null,
      limaVersion: String(lima.out || lima.err || '').trim() || null,
      status: 'Unavailable',
      drift: { creation: [], resources: [], configuration: [] },
    };
  }
  const current = await getManagedLimaStatus({ executor, instance });
  if (!current.exists) {
    return {
      ok: false,
      exists: false,
      host: String(host.out ?? '').trim(),
      limaVersion: String(lima.out || lima.err || '').trim(),
      status: 'Absent',
      drift: { creation: [], resources: [], configuration: [] },
    };
  }
  const profile = resolveManagedLimaProfile(profileName, { architecture });
  const drift = evaluateManagedLimaInstance(current.instance, profile);
  const guestLoginManager = current.status.toLowerCase() === 'running'
    ? await inspectManagedLimaGuestLoginManager({ executor, instance })
    : null;
  const ok = Object.values(drift).every((entries) => entries.length === 0)
    && current.status.toLowerCase() !== 'broken'
    && (guestLoginManager?.ok ?? true);
  return {
    ok,
    exists: true,
    host: String(host.out ?? '').trim(),
    limaVersion: String(lima.out || lima.err || '').trim(),
    status: current.status,
    drift,
    ...(guestLoginManager ? { guestLoginManager } : {}),
  };
}
