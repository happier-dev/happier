import {
  buildManagedLimaCreateArgs,
  buildManagedLimaNetworkEditArgs,
  resolveManagedLimaNetworks,
  validateManagedLimaInstanceName,
} from './profiles.mjs';
import {
  changeLimaPower,
  createLimaInstance,
  getLimaStatus,
  inspectLimaInstance,
  limaInstanceField as field,
  limaVersionAtLeast as versionAtLeast,
  parseLimaVersion as parseVersion,
  runLimaCommand,
} from '@happier-dev/cli-common/machineLima';

const MINIMUM_LIMA_VERSION = Object.freeze([2, 0, 0]);

export class ManagedLimaDriftError extends Error {
  constructor(drift) {
    super(`[managed-lima] retained instance has creation-only drift: ${drift.map((entry) => entry.field).join(', ')}`);
    this.name = 'ManagedLimaDriftError';
    this.code = 'MANAGED_LIMA_CREATION_DRIFT';
    this.drift = drift;
  }
}

function compareCreationIdentity(instance, profile) {
  const expected = { vmType: profile.vmType, arch: profile.arch };
  const drift = Object.entries(expected).flatMap(([name, expectedValue]) => {
    const actualValue = field(instance, name, name[0].toUpperCase() + name.slice(1));
    return String(actualValue ?? '').toLowerCase() === String(expectedValue).toLowerCase()
      ? []
      : [{ field: name, expected: expectedValue, actual: actualValue }];
  });
  const actualDiskImageFormat = instance?.config?.vmOpts?.vz?.diskImageFormat ?? null;
  if (actualDiskImageFormat !== profile.diskImageFormat) {
    drift.push({ field: 'diskImageFormat', expected: profile.diskImageFormat, actual: actualDiskImageFormat });
  }
  return drift;
}

function compareMutableResources(instance, profile) {
  const actualCpus = Number(field(instance, 'cpus', 'CPUs'));
  const actualMemory = Number(field(instance, 'memory', 'Memory'));
  const actualDisk = Number(field(instance, 'disk', 'Disk'));
  const gib = 1024 ** 3;
  const drift = [];
  if (actualCpus !== profile.cpus) drift.push({ field: 'cpus', expected: profile.cpus, actual: actualCpus });
  if (actualMemory !== profile.memoryGiB * gib) drift.push({ field: 'memory', expected: profile.memoryGiB * gib, actual: actualMemory });
  if (actualDisk !== profile.diskGiB * gib) drift.push({ field: 'disk', expected: profile.diskGiB * gib, actual: actualDisk });
  return drift;
}

function rangesEqual(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length + 1) return false;
  const expectedRangesPresent = expected.every((wanted) => actual.some((entry) => (
    JSON.stringify(entry?.guestPortRange) === JSON.stringify([wanted.guestStart, wanted.guestEnd])
    && JSON.stringify(entry?.hostPortRange) === JSON.stringify([wanted.hostStart, wanted.hostEnd])
    && entry?.hostIP === wanted.hostIP
    && entry?.static !== true
  )));
  const unmatchedForwardingDisabled = actual.some((entry) => (
    entry?.guestIP === '0.0.0.0'
    && entry?.guestIPMustBeZero === false
    && entry?.proto === 'any'
    && entry?.ignore === true
  ));
  return expectedRangesPresent && unmatchedForwardingDisabled;
}

function compareConfiguration(instance, profile) {
  const config = instance?.config ?? {};
  const drift = [];
  if (profile.mountNone && Array.isArray(config.mounts) && config.mounts.length > 0) {
    drift.push({ field: 'mounts', expected: [], actual: config.mounts });
  }
  if (
    profile.containerd === 'none'
    && (config.containerd?.user !== false || config.containerd?.system !== false)
  ) {
    drift.push({ field: 'containerd', expected: { user: false, system: false }, actual: config.containerd ?? null });
  }
  if (config.ssh?.forwardAgent !== false) {
    drift.push({ field: 'ssh.forwardAgent', expected: false, actual: config.ssh?.forwardAgent ?? null });
  }
  const rosetta = config.vmOpts?.vz?.rosetta ?? {};
  if (Boolean(rosetta.enabled) !== profile.rosetta || Boolean(rosetta.binfmt) !== profile.rosetta) {
    drift.push({
      field: 'rosetta',
      expected: { enabled: profile.rosetta, binfmt: profile.rosetta },
      actual: rosetta,
    });
  }
  if (!rangesEqual(config.portForwards, profile.portForwards)) {
    drift.push({ field: 'portForwards', expected: profile.portForwards, actual: config.portForwards ?? null });
  }
  return drift;
}

export function evaluateManagedLimaInstance(instance, profile) {
  return {
    creation: compareCreationIdentity(instance, profile),
    resources: compareMutableResources(instance, profile),
    configuration: compareConfiguration(instance, profile),
  };
}

export async function inspectManagedLimaInstance({ executor, instance: rawInstance }) {
  return inspectLimaInstance({ executor, instance: validateManagedLimaInstanceName(rawInstance) });
}

export async function getManagedLimaStatus({ executor, instance: rawInstance }) {
  return getLimaStatus({ executor, instance: validateManagedLimaInstanceName(rawInstance) });
}

export async function startManagedLimaInstance({ executor, instance: rawInstance }) {
  return changeLimaPower({ executor, instance: validateManagedLimaInstanceName(rawInstance), intent: 'start' });
}

export async function stopManagedLimaInstance({ executor, instance: rawInstance, force = false }) {
  return changeLimaPower({ executor, instance: validateManagedLimaInstanceName(rawInstance), intent: 'stop', force });
}

async function requireManagedLimaHost(executor) {
  if (!executor || typeof executor.capture !== 'function' || typeof executor.run !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const host = await executor.capture('uname', ['-s']);
  if (host.exitCode !== 0 || String(host.out ?? '').trim() !== 'Darwin') {
    throw new Error('[managed-lima] managed VZ instances require a macOS host');
  }
  const versionResult = await runLimaCommand({ executor, args: ['--version'] });
  if (versionResult.exitCode !== 0) {
    throw new Error('[managed-lima] Lima is not installed; run the explicit managed setup operation');
  }
  const version = parseVersion(versionResult.out || versionResult.err);
  if (!versionAtLeast(version, MINIMUM_LIMA_VERSION)) {
    throw new Error('[managed-lima] Lima 2.0.0 or newer is required');
  }
}

// Only explicit operator commands call this owner. Ordinary start, doctor,
// recovery and resource reconciliation preserve retained network configuration.
export async function applyManagedLimaNetworking({
  executor,
  instance: rawInstance,
  force = false,
  stopInstance = stopManagedLimaInstance,
  startInstance = startManagedLimaInstance,
}) {
  const instance = validateManagedLimaInstanceName(rawInstance);
  await requireManagedLimaHost(executor);
  const current = await getManagedLimaStatus({ executor, instance });
  if (!current.exists) throw new Error(`[managed-lima] retained instance ${instance} does not exist`);
  if (field(current.instance, 'vmType') !== 'vz') throw new Error('[managed-lima] native NAT requires a VZ instance');
  if (!['running', 'stopped'].includes(current.status.toLowerCase())) {
    throw new Error(`[managed-lima] cannot apply networking to an instance in ${current.status} state`);
  }
  if (!current.instance.config) throw new Error('[managed-lima] native instance configuration is unavailable');
  const existing = current.instance.config.networks ?? [];
  const networks = resolveManagedLimaNetworks(existing);
  if (JSON.stringify(existing) === JSON.stringify(networks)) {
    return { changed: false, status: current.status, networks };
  }
  if (!force) {
    const error = new Error('[managed-lima] network apply requires --force; it stops and starts the retained VM and interrupts all guest processes');
    error.code = 'MANAGED_LIMA_NETWORK_FORCE_REQUIRED';
    throw error;
  }
  if (current.status.toLowerCase() === 'running') await stopInstance({ executor, instance });
  const stopped = await getManagedLimaStatus({ executor, instance });
  if (!stopped.exists || stopped.status.toLowerCase() !== 'stopped') {
    throw new Error('[managed-lima] network apply could not confirm the retained VM is stopped; configuration was not edited');
  }
  const edit = await runLimaCommand({ executor, args: buildManagedLimaNetworkEditArgs({ instance, networks }), interactive: true });
  if (edit.exitCode !== 0) throw new Error('[managed-lima] network edit failed; the VM remains stopped; correct the error and rerun network apply --force');
  const edited = await getManagedLimaStatus({ executor, instance });
  const configured = edited.instance?.config?.networks;
  if (!Array.isArray(configured)
      || JSON.stringify(resolveManagedLimaNetworks(configured)) !== JSON.stringify(configured)) {
    throw new Error('[managed-lima] native NAT configuration was not confirmed; the VM remains stopped');
  }
  await startInstance({ executor, instance });
  const started = await getManagedLimaStatus({ executor, instance });
  if (!started.exists || started.status.toLowerCase() !== 'running') {
    throw new Error('[managed-lima] retained VM did not return to Running after network apply');
  }
  return { changed: true, status: started.status, networks: started.instance.config.networks };
}

export async function reconcileManagedLimaInstance({ executor, instance: rawInstance, profile }) {
  const instance = validateManagedLimaInstanceName(rawInstance);
  await requireManagedLimaHost(executor);

  const existing = await inspectManagedLimaInstance({ executor, instance });
  if (!existing) {
    await createLimaInstance({ executor, instance, createArgs: buildManagedLimaCreateArgs({ instance, profile }) });
    const power = await startManagedLimaInstance({ executor, instance });
    return { created: true, started: power.changed, status: power.status };
  }

  const drift = evaluateManagedLimaInstance(existing, profile);
  const creationDrift = drift.creation;
  if (creationDrift.length > 0) throw new ManagedLimaDriftError(creationDrift);
  const resourceDrift = drift.resources;
  if (resourceDrift.length > 0) {
    const error = new Error(`[managed-lima] retained instance resource drift requires explicit reconcile: ${resourceDrift.map((entry) => entry.field).join(', ')}`);
    error.code = 'MANAGED_LIMA_RESOURCE_DRIFT';
    error.drift = resourceDrift;
    throw error;
  }
  const configurationDrift = drift.configuration;
  if (configurationDrift.length > 0) {
    const error = new Error(`[managed-lima] retained instance configuration drift requires explicit reconcile: ${configurationDrift.map((entry) => entry.field).join(', ')}`);
    error.code = 'MANAGED_LIMA_CONFIGURATION_DRIFT';
    error.drift = configurationDrift;
    throw error;
  }
  const status = String(field(existing, 'status', 'Status') ?? 'Unknown');
  if (status.toLowerCase() !== 'running') {
    const power = await startManagedLimaInstance({ executor, instance });
    return { created: false, started: power.changed, status: power.status };
  }
  return { created: false, started: false, status };
}
