import {
  buildManagedLimaCreateArgs,
  validateManagedLimaInstanceName,
} from './profiles.mjs';

const MINIMUM_LIMA_VERSION = Object.freeze([2, 0, 0]);

export class ManagedLimaDriftError extends Error {
  constructor(drift) {
    super(`[managed-lima] retained instance has creation-only drift: ${drift.map((entry) => entry.field).join(', ')}`);
    this.name = 'ManagedLimaDriftError';
    this.code = 'MANAGED_LIMA_CREATION_DRIFT';
    this.drift = drift;
  }
}

function parseVersion(output) {
  const match = String(output ?? '').match(/(?:version\s+)?(\d+)\.(\d+)\.(\d+)/i);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function parseInstanceOutput(output) {
  const text = String(output ?? '').trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed[0] ?? null;
  return parsed;
}

function field(instance, lower, upper) {
  return instance?.[lower] ?? instance?.[upper] ?? null;
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
  const instance = validateManagedLimaInstanceName(rawInstance);
  const result = await executor.capture('limactl', ['list', '--all-fields', '--format=json', instance]);
  if (result.exitCode !== 0) {
    const detail = String(result.err ?? '');
    if (/No instance matching .* found\./i.test(detail) && /unmatched instances/i.test(detail)) {
      return null;
    }
    throw new Error(`[managed-lima] failed to inspect ${instance}: ${String(result.err ?? '').trim() || 'limactl list failed'}`);
  }
  return parseInstanceOutput(result.out);
}

export async function getManagedLimaStatus({ executor, instance: rawInstance }) {
  const instance = await inspectManagedLimaInstance({ executor, instance: rawInstance });
  if (!instance) return { exists: false, status: 'Absent', instance: null };
  return {
    exists: true,
    status: String(field(instance, 'status', 'Status') ?? 'Unknown'),
    instance,
  };
}

function absentInstanceError(instance) {
  const error = new Error(`[managed-lima] retained instance ${instance} does not exist; run the explicit managed setup operation`);
  error.code = 'MANAGED_LIMA_INSTANCE_ABSENT';
  return error;
}

export async function startManagedLimaInstance({ executor, instance: rawInstance }) {
  const instance = validateManagedLimaInstanceName(rawInstance);
  const current = await getManagedLimaStatus({ executor, instance });
  if (!current.exists) throw absentInstanceError(instance);
  if (current.status.toLowerCase() === 'running') return { changed: false, status: current.status };
  if (current.status.toLowerCase() === 'broken') {
    const error = new Error(`[managed-lima] retained instance ${instance} is broken; run managed Lima doctor before repair`);
    error.code = 'MANAGED_LIMA_INSTANCE_BROKEN';
    throw error;
  }
  await executor.run('limactl', ['start', instance]);
  return { changed: true, status: 'Running' };
}

export async function stopManagedLimaInstance({ executor, instance: rawInstance }) {
  const instance = validateManagedLimaInstanceName(rawInstance);
  const current = await getManagedLimaStatus({ executor, instance });
  if (!current.exists) throw absentInstanceError(instance);
  if (current.status.toLowerCase() !== 'running') return { changed: false, status: current.status };
  await executor.run('limactl', ['stop', instance]);
  return { changed: true, status: 'Stopped' };
}

export async function reconcileManagedLimaInstance({ executor, instance: rawInstance, profile }) {
  if (!executor || typeof executor.capture !== 'function' || typeof executor.run !== 'function') {
    throw new Error('[managed-lima] executor is required');
  }
  const instance = validateManagedLimaInstanceName(rawInstance);
  const host = await executor.capture('uname', ['-s']);
  if (host.exitCode !== 0 || String(host.out ?? '').trim() !== 'Darwin') {
    throw new Error('[managed-lima] managed VZ instances require a macOS host');
  }
  const versionResult = await executor.capture('limactl', ['--version']);
  if (versionResult.exitCode !== 0) {
    throw new Error('[managed-lima] Lima is not installed; run the explicit managed setup operation');
  }
  const version = parseVersion(versionResult.out || versionResult.err);
  if (!versionAtLeast(version, MINIMUM_LIMA_VERSION)) {
    throw new Error('[managed-lima] Lima 2.0.0 or newer is required');
  }

  const existing = await inspectManagedLimaInstance({ executor, instance });
  if (!existing) {
    await executor.run('limactl', buildManagedLimaCreateArgs({ instance, profile }));
    await executor.run('limactl', ['start', instance]);
    return { created: true, started: true, status: 'Running' };
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
    await executor.run('limactl', ['start', instance]);
    return { created: false, started: true, status: 'Running' };
  }
  return { created: false, started: false, status };
}
