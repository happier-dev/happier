import { validateLimaInstanceName } from '@happier-dev/cli-common/machineLima';
const MANAGED_LIMA_ARCHITECTURES = new Set(['aarch64', 'x86_64']);
const MANAGED_LIMA_DISK_IMAGE_FORMATS = new Set(['raw', 'asif']);

const BASE_PROFILE = Object.freeze({
  schemaVersion: 1,
  vmType: 'vz',
  arch: 'aarch64',
  template: 'ubuntu-24.04',
  diskImageFormat: 'raw',
  containerd: 'none',
  mountNone: true,
  rosetta: false,
  // Lima retains usernet (metric 200); added networks default to metric 100.
  // Basis: Lima v2.0.3/v2.1.0/v2.2.0 pkg/{cidata/cidata,limayaml/defaults}.go.
  networks: Object.freeze([Object.freeze({ vzNAT: true })]),
  // TCP Stack services are owned by execution-host SSH transport. Keeping
  // their broad ranges in Lima hostagent creates a second, unreliable owner.
  // The final proto:any ignore rule remains below to prevent implicit Lima
  // forwarding (including UDP) from claiming arbitrary guest listeners.
  portForwards: Object.freeze([]),
});

const PROFILE_SIZES = Object.freeze({
  small: Object.freeze({ cpus: 8, memoryGiB: 16, diskGiB: 160 }),
  balanced: Object.freeze({ cpus: 10, memoryGiB: 24, diskGiB: 160 }),
  performance: Object.freeze({ cpus: 12, memoryGiB: 32, diskGiB: 240 }),
  heavy: Object.freeze({ cpus: 14, memoryGiB: 72, diskGiB: 640 }),
  'worker-balanced': Object.freeze({ cpus: 8, memoryGiB: 24, diskGiB: 160 }),
});

function requireInstanceName(value) {
  return validateLimaInstanceName(value);
}

function normalizePositiveResource(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`[managed-lima] ${label} must be a positive integer`);
  }
  return normalized;
}

export function normalizeManagedLimaArchitecture(value) {
  const normalized = String(value ?? 'aarch64').trim().toLowerCase();
  const architecture = normalized === 'arm64' ? 'aarch64' : normalized;
  if (!MANAGED_LIMA_ARCHITECTURES.has(architecture)) {
    throw new Error(`[managed-lima] unsupported managed Lima architecture: ${JSON.stringify(normalized)}`);
  }
  return architecture;
}

export function normalizeManagedLimaDiskImageFormat(value) {
  const format = String(value ?? BASE_PROFILE.diskImageFormat).trim().toLowerCase();
  if (!MANAGED_LIMA_DISK_IMAGE_FORMATS.has(format)) {
    throw new Error(`[managed-lima] unsupported managed Lima disk image format: ${JSON.stringify(format)}`);
  }
  return format;
}

export function resolveManagedLimaProfile(
  name,
  {
    architecture = 'aarch64',
    diskImageFormat = BASE_PROFILE.diskImageFormat,
    resources = null,
  } = {},
) {
  const normalizedName = String(name ?? '').trim().toLowerCase();
  const size = PROFILE_SIZES[normalizedName];
  if (!size) throw new Error(`[managed-lima] unknown managed Lima profile: ${JSON.stringify(normalizedName)}`);
  const normalizedResources = resources == null
    ? size
    : {
        cpus: normalizePositiveResource(resources.cpus, 'cpus'),
        memoryGiB: normalizePositiveResource(resources.memoryGiB, 'memoryGiB'),
      };
  return {
    schemaVersion: BASE_PROFILE.schemaVersion,
    name: normalizedName,
    vmType: BASE_PROFILE.vmType,
    arch: normalizeManagedLimaArchitecture(architecture),
    template: BASE_PROFILE.template,
    diskImageFormat: normalizeManagedLimaDiskImageFormat(diskImageFormat),
    cpus: normalizedResources.cpus,
    memoryGiB: normalizedResources.memoryGiB,
    diskGiB: size.diskGiB,
    containerd: BASE_PROFILE.containerd,
    mountNone: BASE_PROFILE.mountNone,
    rosetta: BASE_PROFILE.rosetta,
    networks: BASE_PROFILE.networks.map((entry) => ({ ...entry })),
    portForwards: BASE_PROFILE.portForwards.map((entry) => ({ ...entry })),
  };
}

function renderPortForwards(portForwards) {
  return [
    ...portForwards.map((entry) => ({
      guestPortRange: [entry.guestStart, entry.guestEnd],
      hostPortRange: [entry.hostStart, entry.hostEnd],
      hostIP: entry.hostIP,
    })),
    { guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true },
  ];
}

function mutableConfigurationArgs(profile) {
  return [
    ...(profile.mountNone ? ['--mount-none'] : []),
    '--set', '.ssh.forwardAgent = false',
    '--set', profile.rosetta
      ? '.vmOpts.vz.rosetta.enabled = true | .vmOpts.vz.rosetta.binfmt = true'
      : '.vmOpts.vz.rosetta.enabled = false | .vmOpts.vz.rosetta.binfmt = false',
    '--set', `.containerd.user = ${profile.containerd === 'none' ? 'false' : 'true'} | .containerd.system = false`,
    '--set', `.portForwards = ${JSON.stringify(renderPortForwards(profile.portForwards))}`,
  ];
}

export function buildManagedLimaCreateArgs({ instance: rawInstance, profile }) {
  const instance = requireInstanceName(rawInstance);
  if (!profile || profile.schemaVersion !== 1) throw new Error('[managed-lima] invalid managed Lima profile');
  const args = [
    'create',
    '--name', instance,
    '--tty=false',
    '--vm-type', profile.vmType,
    '--arch', profile.arch,
    '--cpus', String(profile.cpus),
    '--memory', String(profile.memoryGiB),
    '--disk', String(profile.diskGiB),
    '--containerd', profile.containerd,
  ];
  if (profile.mountNone) args.push('--mount-none');
  args.push('--set', `.vmOpts.vz.diskImageFormat = ${JSON.stringify(profile.diskImageFormat)}`);
  args.push('--set', '.ssh.forwardAgent = false');
  args.push(
    '--set',
    profile.rosetta
      ? '.vmOpts.vz.rosetta.enabled = true | .vmOpts.vz.rosetta.binfmt = true'
      : '.vmOpts.vz.rosetta.enabled = false | .vmOpts.vz.rosetta.binfmt = false',
  );
  args.push('--set', `.networks = ${JSON.stringify(profile.networks)}`);
  args.push('--set', `.portForwards = ${JSON.stringify(renderPortForwards(profile.portForwards))}`);
  args.push(`template:${profile.template}`);
  return args;
}

export function buildManagedLimaEditArgs({ instance: rawInstance, profile }) {
  const instance = requireInstanceName(rawInstance);
  if (!profile || profile.schemaVersion !== 1) throw new Error('[managed-lima] invalid managed Lima profile');
  return [
    'edit',
    '--tty=false',
    '--cpus', String(profile.cpus),
    '--memory', String(profile.memoryGiB),
    '--disk', String(profile.diskGiB),
    ...mutableConfigurationArgs(profile),
    instance,
  ];
}

export function resolveManagedLimaNetworks(networks = []) {
  if (!Array.isArray(networks)) throw new Error('[managed-lima] native networks configuration is unavailable');
  const native = networks.some((entry) => entry?.vzNAT === true);
  if (!native) return [...networks, ...BASE_PROFILE.networks.map((entry) => ({ ...entry }))];
  // Preserve interface/MAC identity and custom networks. Correct only a native
  // NAT route that cannot beat Lima's usernet metric (200), using its default (100).
  return networks.map((entry) => entry?.vzNAT === true && entry.metric >= 200
    ? { ...entry, metric: 100 }
    : entry);
}

export function buildManagedLimaNetworkEditArgs({ instance: rawInstance, networks }) {
  return ['edit', '--tty=false', '--set', `.networks = ${JSON.stringify(networks)}`, requireInstanceName(rawInstance)];
}

export function validateManagedLimaInstanceName(value) {
  return requireInstanceName(value);
}
