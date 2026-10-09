import {
  changeLimaPower, createLimaInstance, deleteLimaInstance, execLimaGuest, inspectLimaCapabilities, inspectLimaInstance,
  limaInstanceField, limaVersionAtLeast, parseLimaVersion, putLimaGuestFile, runLimaCommand,
  validateLimaStore,
} from '@happier-dev/cli-common/machineLima';
import type { LimaCommandResult, LimaExecutor, LimaInstance } from '@happier-dev/cli-common/machineLima';
import { LimaLaunchSchema, LimaResourceSchema } from './schemas.js';
import type { LimaLaunch, LimaResource } from './schemas.js';

export const LIMA_PLUGIN_ID = 'happier.machine.lima';
export const LIMA_PROVISIONER_ID = 'lima';
export const LIMA_DEPENDENCY_ID = 'lima-cli';
export const LIMA_QEMU_DEPENDENCY_IDS = { x86_64: 'qemu-x86-64', aarch64: 'qemu-aarch64' } as const;
const contributionRef = { pluginId: LIMA_PLUGIN_ID, localId: LIMA_PROVISIONER_ID };
const gib = 1024 ** 3;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function refusalCode(error: unknown) {
  return typeof record(error).code === 'string' ? String(record(error).code) : 'provider_unavailable';
}

function readResource(instance: LimaInstance, store: string): LimaResource {
  const config = record(instance.config);
  const arch = limaInstanceField(instance, 'arch');
  const images = Array.isArray(config.images) ? config.images.map(record).filter((image) => image.arch === arch) : [];
  if (images.length !== 1) throw Object.assign(new Error('native image is not uniquely identified'), { code: 'resource_mismatch' });
  return LimaResourceSchema.parse({
    instance: limaInstanceField(instance, 'name'), store, arch, vmType: limaInstanceField(instance, 'vmType'),
    cpus: limaInstanceField(instance, 'cpus', 'CPUs'), memoryBytes: limaInstanceField(instance, 'memory'), diskBytes: limaInstanceField(instance, 'disk'),
    image: images[0].location,
    mounts: Array.isArray(config.mounts) ? config.mounts.map((value) => {
      const mount = record(value);
      return { location: mount.location, mountPoint: mount.mountPoint, writable: mount.writable === true };
    }) : [],
  });
}

function sameCreationFacts(instance: LimaInstance, expected: LimaResource) {
  const config = record(instance.config);
  const observed = readResource(instance, expected.store);
  return JSON.stringify(observed) === JSON.stringify(expected)
    && record(config.ssh).forwardAgent === false
    && record(config.containerd).user === false && record(config.containerd).system === false;
}

function expectedResource(launch: LimaLaunch): LimaResource {
  const { memoryGiB, diskGiB, ...identity } = launch;
  return LimaResourceSchema.parse({ ...identity, memoryBytes: memoryGiB * gib, diskBytes: diskGiB * gib });
}

function buildCreateArgs(launch: LimaLaunch) {
  return [
    'create', '--name', launch.instance, '--tty=false', '--vm-type', launch.vmType, '--arch', launch.arch,
    '--cpus', String(launch.cpus), '--memory', String(launch.memoryGiB), '--disk', String(launch.diskGiB),
    '--containerd', 'none', '--mount-none',
    '--set', `.images = ${JSON.stringify([{ location: launch.image, arch: launch.arch }])}`,
    '--set', `.mounts = ${JSON.stringify(launch.mounts)}`,
    '--set', '.ssh.forwardAgent = false | .containerd.user = false | .containerd.system = false',
    'template://ubuntu-24.04',
  ];
}

export function createLimaProvider<TResult extends LimaCommandResult>(executor: LimaExecutor<TResult>, observedAt = Date.now(),
  qemuAvailable?: (dependencyId: string) => Promise<boolean>) {
  async function nativeInfo() {
    const info = await inspectLimaCapabilities({ executor });
    if ((info.hostOS !== 'darwin' && info.hostOS !== 'linux')
      || (info.hostArch !== 'aarch64' && info.hostArch !== 'x86_64')) {
      throw Object.assign(new Error('native Lima capabilities unavailable'), { code: 'lima_unavailable' });
    }
    return info;
  }
  async function requireQemu(arch: 'aarch64' | 'x86_64') {
    const dependencyIds = [LIMA_QEMU_DEPENDENCY_IDS[arch], 'qemu-img'];
    const readiness = await Promise.all(dependencyIds.map(async (dependencyId) => await qemuAvailable?.(dependencyId) === true));
    const available = readiness.every(Boolean);
    return { available, prerequisites: dependencyIds.map((dependencyId, index) => ({ requirement: { kind: 'managedDependency' as const,
      id: { pluginId: LIMA_PLUGIN_ID, localId: dependencyId } }, status: readiness[index] ? 'available' as const : 'unavailable' as const })),
      ...(available ? {} : { code: 'qemu_unavailable' }) };
  }
  async function inspectExact(rawResource: LimaResource) {
    const resource = LimaResourceSchema.parse(rawResource);
    validateLimaStore(resource.store);
    const native = await inspectLimaInstance({ executor, ...resource });
    if (native && !sameCreationFacts(native, resource)) {
      throw Object.assign(new Error('retained Lima creation facts changed'), { code: 'resource_mismatch' });
    }
    return { resource, native };
  }
  return {
    async check() {
      try {
        const version = await runLimaCommand({ executor, args: ['--version'] });
        if (version.exitCode !== 0 || !limaVersionAtLeast(parseLimaVersion(version.out || version.err))) {
          return { available: false, code: 'lima_2_required' };
        }
        const info = await nativeInfo();
        if (info.hostOS === 'linux') {
          if (!info.vmTypes.includes('qemu')) return { available: false, code: 'qemu_driver_unavailable' };
          return requireQemu(info.hostArch === 'aarch64' ? 'aarch64' : 'x86_64');
        }
        return info.vmTypes.includes('vz') ? { available: true } : { available: false, code: 'vz_driver_unavailable' };
      } catch { return { available: false, code: 'lima_unavailable' }; }
    },
    async acquire(rawLaunch: LimaLaunch) {
      const launch = LimaLaunchSchema.parse(rawLaunch);
      validateLimaStore(launch.store);
      const expected = expectedResource(launch);
      try {
        const info = await nativeInfo();
        if (!info.vmTypes.includes(launch.vmType) || (info.hostOS === 'linux' && launch.vmType !== 'qemu')) {
          throw Object.assign(new Error('reviewed native VM driver unavailable'), { code: 'lima_driver_unavailable' });
        }
        if (launch.vmType === 'qemu' && !(await requireQemu(launch.arch)).available) {
          throw Object.assign(new Error('reviewed architecture QEMU executable unavailable'), { code: 'qemu_unavailable' });
        }
        const created = await createLimaInstance({ executor, ...launch, createArgs: buildCreateArgs(launch) });
        if (!sameCreationFacts(created.instance, expected)) {
          // This may follow allocation. Rejection would falsely confirm absence
          // upstream and discard the exact native scope needed for recovery.
          throw Object.assign(new Error('allocated Lima creation facts differ'), { code: 'resource_mismatch' });
        }
        if (String(limaInstanceField(created.instance, 'status')).toLowerCase() !== 'running') {
          await changeLimaPower({ executor, ...expected, intent: 'start' });
        }
        return { kind: 'bound' as const, resource: { contributionRef, schemaVersion: 1, value: expected } };
      } catch (error) {
        return { kind: 'unknown' as const, recovery: { reference: `${launch.store}/${launch.instance}`, reason: refusalCode(error) } };
      }
    },
    async bootstrap(resource: LimaResource) {
      const { native } = await inspectExact(resource);
      if (!native || String(limaInstanceField(native, 'status')).toLowerCase() !== 'running') {
        throw Object.assign(new Error('bootstrap requires the retained running guest'), { code: 'LIMA_GUEST_UNAVAILABLE' });
      }
      // Only native IO is selected here. Binary installation, private payload
      // selection, credentials and Home enrollment remain host-owned.
      return { kind: 'native' as const, transport: { contributionRef, schemaVersion: 1 } };
    },
    async inspect(resource: LimaResource) {
      try {
        const { native } = await inspectExact(resource);
        const status = native ? String(limaInstanceField(native, 'status')).toLowerCase() : 'absent';
        return {
          observedAt, availability: native ? 'present' as const : 'absent' as const,
          ...(native ? { power: status === 'running' ? 'running' as const : status === 'stopped' ? 'stopped' as const : 'unknown' as const } : {}),
          billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
        };
      } catch (error) { return { observedAt, availability: 'unavailable' as const, reason: refusalCode(error) }; }
    },
    async power(rawResource: LimaResource, intent: 'start' | 'stop') {
      try {
        const { resource } = await inspectExact(rawResource);
        const power = await changeLimaPower({ executor, ...resource, intent });
        return { kind: power.status.toLowerCase() === (intent === 'start' ? 'running' : 'stopped') ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        const code = refusalCode(error);
        return { kind: code === 'MANAGED_LIMA_INSTANCE_ABSENT' || code === 'resource_mismatch' || code === 'LIMA_IDENTITY_MISMATCH' ? 'refused' as const : 'unknown' as const, code };
      }
    },
    async destroy(rawResource: LimaResource) {
      try {
        const { resource } = await inspectExact(rawResource);
        const result = await deleteLimaInstance({ executor, ...resource });
        return { kind: result.kind === 'absent' ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        return { kind: refusalCode(error) === 'resource_mismatch' || refusalCode(error) === 'LIMA_IDENTITY_MISMATCH' ? 'refused' as const : 'unknown' as const, code: refusalCode(error) };
      }
    },
    async exec(rawResource: LimaResource, argv: readonly string[], input?: Uint8Array) {
      const { resource } = await inspectExact(rawResource);
      return execLimaGuest({ executor, ...resource, argv, input });
    },
    async putFile(rawResource: LimaResource, guestPath: string, bytes: Uint8Array, mode?: string) {
      const { resource } = await inspectExact(rawResource);
      return putLimaGuestFile({ executor, ...resource, guestPath, bytes, mode });
    },
  };
}
