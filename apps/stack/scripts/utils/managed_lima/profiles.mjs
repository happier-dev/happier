const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const MANAGED_LIMA_ARCHITECTURES = new Set(['aarch64', 'x86_64']);

const BASE_PROFILE = Object.freeze({
  schemaVersion: 1,
  vmType: 'vz',
  arch: 'aarch64',
  template: 'ubuntu-24.04',
  diskImageFormat: 'raw',
  containerd: 'none',
  mountNone: true,
  rosetta: false,
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
  const instance = String(value ?? '').trim();
  if (!INSTANCE_NAME_RE.test(instance)) {
    throw new Error(`[managed-lima] invalid managed Lima instance name: ${JSON.stringify(instance)}`);
  }
  return instance;
}

export function normalizeManagedLimaArchitecture(value) {
  const normalized = String(value ?? 'aarch64').trim().toLowerCase();
  const architecture = normalized === 'arm64' ? 'aarch64' : normalized;
  if (!MANAGED_LIMA_ARCHITECTURES.has(architecture)) {
    throw new Error(`[managed-lima] unsupported managed Lima architecture: ${JSON.stringify(normalized)}`);
  }
  return architecture;
}

export function resolveManagedLimaProfile(name, { architecture = 'aarch64' } = {}) {
  const normalizedName = String(name ?? '').trim().toLowerCase();
  const size = PROFILE_SIZES[normalizedName];
  if (!size) throw new Error(`[managed-lima] unknown managed Lima profile: ${JSON.stringify(normalizedName)}`);
  return {
    schemaVersion: BASE_PROFILE.schemaVersion,
    name: normalizedName,
    vmType: BASE_PROFILE.vmType,
    arch: normalizeManagedLimaArchitecture(architecture),
    template: BASE_PROFILE.template,
    diskImageFormat: BASE_PROFILE.diskImageFormat,
    cpus: size.cpus,
    memoryGiB: size.memoryGiB,
    diskGiB: size.diskGiB,
    containerd: BASE_PROFILE.containerd,
    mountNone: BASE_PROFILE.mountNone,
    rosetta: BASE_PROFILE.rosetta,
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

export function validateManagedLimaInstanceName(value) {
  return requireInstanceName(value);
}
