import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  changeLimaPower, createLimaInstance, deleteLimaInstance, execLimaGuest, inspectLimaCapabilities, inspectLimaInstance,
  limaInstanceField, limaVersionAtLeast, openLimaGuestChannel, parseLimaVersion, putLimaGuestFile, runLimaCommand,
  validateLimaStore,
} from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import type { LimaCommandResult, LimaExecutor, LimaInstance } from '@happier-dev/plugin-sdk/machine-provisioners/lima';
import type { MachineProvisionerOptionsResultV1, MachineProvisionerSizeV1, MachineProvisionerResizeResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { observeMachineProvisionerNativeRead, MachineProvisionerSizeV1Schema, projectMachineProvisionerActionFailure, MACHINE_PROVISIONER_CLOUD_SSH_USER } from '@happier-dev/plugin-sdk/machine-provisioners';
import { LimaLaunchSchema, LimaOptionsInputSchema, LimaResourceSchema } from './schemas.js';
import type { LimaLaunch, LimaResource } from './schemas.js';
import { machinePresentationLabel } from '../ui/translations.js';
import { LimaNativeCommandError } from './nativeExecutor.js';

export const LIMA_PLUGIN_ID = 'happier.machine.lima';
export const LIMA_PROVISIONER_ID = 'lima';
export const LIMA_DEPENDENCY_ID = 'lima-cli';
export const LIMA_QEMU_DEPENDENCY_IDS = { x86_64: 'qemu-x86-64', aarch64: 'qemu-aarch64' } as const;
const contributionRef = { pluginId: LIMA_PLUGIN_ID, localId: LIMA_PROVISIONER_ID };
const gib = 1024 ** 3;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Native template quantities use Lima's binary size units (v2.1.0 limayaml). */
function templateGiB(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([kmgtpe]?)(?:i?b)?$/iu.exec(value.trim());
  if (!match) return undefined;
  const power = match[2] ? 'kmgtpe'.indexOf(match[2].toLowerCase()) + 1 : 0;
  return Number(match[1]) * 1024 ** power / gib;
}

function templateImage(images: unknown, arch: string | undefined): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const image = images.map(record).find(image => image.arch === arch
    && typeof image.location === 'string' && image.location.length > 0);
  return typeof image?.location === 'string' ? image.location : undefined;
}

/** What a person recognises an image by: the system and release its file names, else the file name; and where it is served from. */
function describeImage(location: string) {
  try {
    const url = new URL(location);
    const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return name ? { title: imageTitle(name), ...(url.host ? { description: url.host } : {}) } : { title: location };
  } catch {
    return { title: imageTitle(location.split(/[\\/]/u).filter(Boolean).pop() ?? location) };
  }
}

/** Cloud image files lead with their system and release ("ubuntu-26.04-server-cloudimg-amd64.img" is Ubuntu 26.04). */
function imageTitle(fileName: string) {
  const release = /^([a-z]+)-(\d+(?:\.\d+)*)[-_.]/iu.exec(fileName);
  return release ? `${release[1]!.charAt(0).toUpperCase()}${release[1]!.slice(1)} ${release[2]}` : fileName;
}

function refusalCode(error: unknown) {
  return typeof record(error).code === 'string' ? String(record(error).code) : 'provider_unavailable';
}

function nativeFailure(error: unknown) {
  return error instanceof LimaNativeCommandError ? { nativeCause: error.nativeCause }
    : projectMachineProvisionerActionFailure(error, () => ({}));
}

function nativeSize(instance: LimaInstance) {
  return MachineProvisionerSizeV1Schema.parse({ cpuCores: limaInstanceField(instance, 'cpus', 'CPUs'),
    memoryBytes: limaInstanceField(instance, 'memory'), diskBytes: limaInstanceField(instance, 'disk') });
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

export function limaAcquisitionResource(launch: LimaLaunch, managedId: string): LimaResource {
  const { memoryGiB, diskGiB, ...identity } = launch;
  // Lima v2.1.0 pkg/identifiers/validate.go permits only single internal
  // separators. Base36 keeps the full opaque-id digest alphanumeric and the
  // prefixed name below our existing 63-character native identity boundary.
  const nativeId = BigInt(`0x${createHash('sha256').update(managedId).digest('hex')}`).toString(36);
  return LimaResourceSchema.parse({ ...identity, instance: `happier-${nativeId}`,
    memoryBytes: memoryGiB * gib, diskBytes: diskGiB * gib });
}

export function buildCreateArgs(launch: LimaLaunch & Readonly<{ instance: string }>) {
  return [
    'create', '--name', launch.instance, '--tty=false', '--vm-type', launch.vmType, '--arch', launch.arch,
    '--cpus', String(launch.cpus), '--memory', String(launch.memoryGiB), '--disk', String(launch.diskGiB),
    '--containerd', 'none', '--mount-none',
    // Lima grants its native login passwordless sudo. Never inherit the host's
    // username: enrollment's distinct daemon principal owns its admin policy.
    '--set', `.user.name = ${JSON.stringify(MACHINE_PROVISIONER_CLOUD_SSH_USER)}`,
    '--set', `.images = ${JSON.stringify([{ location: launch.image, arch: launch.arch }])}`,
    '--set', `.mounts = ${JSON.stringify(launch.mounts)}`,
    // Guest services must not claim the controller's loopback ports. Lima's
    // separate ssh.localPort still provides native shell/bootstrap access.
    '--set', `.portForwards = ${JSON.stringify([
      { guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', guestPortRange: [1, 65535], ignore: true },
    ])}`,
    '--set', '.ssh.forwardAgent = false | .containerd.user = false | .containerd.system = false',
    'template://ubuntu-24.04',
  ];
}

export function createLimaProvider<TResult extends LimaCommandResult, TChannel = never>(executor: LimaExecutor<TResult> & Readonly<{
  channel?(command: string, args: readonly string[], options?: { cwd?: string; env?: Readonly<Record<string, string>> }): Promise<TChannel>;
}>, observedAt = Date.now(),
  qemuAvailable?: (dependencyId: string) => Promise<boolean>) {
  async function nativeVersionAvailable() {
    const version = await runLimaCommand({ executor, args: ['--version'] });
    return version.exitCode === 0 && limaVersionAtLeast(parseLimaVersion(version.out || version.err));
  }
  async function nativeInfo() {
    const info = await inspectLimaCapabilities({ executor });
    if ((info.hostOS !== 'darwin' && info.hostOS !== 'linux')
      || (info.hostArch !== 'aarch64' && info.hostArch !== 'x86_64')) {
      throw Object.assign(new Error('native Lima capabilities unavailable'), { code: 'lima_unavailable' });
    }
    return info;
  }
  async function resolveTemplateImage(selector: string, arch: string | undefined) {
    const expanded = await runLimaCommand({ executor,
      args: ['template', 'yq', selector, '.images | to_json'] });
    return expanded.exitCode === 0 ? templateImage(JSON.parse(expanded.out ?? ''), arch) : undefined;
  }
  async function requireQemu(arch: 'aarch64' | 'x86_64') {
    const dependencyIds = [LIMA_QEMU_DEPENDENCY_IDS[arch], 'qemu-img'];
    const readiness = await Promise.all(dependencyIds.map(async (dependencyId) => await qemuAvailable?.(dependencyId) === true));
    const available = readiness.every(Boolean);
    return { available, prerequisites: dependencyIds.map((dependencyId, index) => ({ requirement: { kind: 'managedDependency' as const,
      id: { pluginId: LIMA_PLUGIN_ID, localId: dependencyId } }, status: readiness[index] ? 'available' as const : 'unavailable' as const })),
      ...(available ? {} : { code: 'qemu_unavailable' }) };
  }
  async function launchAvailability(launch: Pick<LimaLaunch, 'arch' | 'vmType'>, observedInfo?: Awaited<ReturnType<typeof nativeInfo>>) {
    const info = observedInfo ?? await nativeInfo();
    // Native VZ cannot emulate the other architecture. QEMU qualification is
    // per selected guest architecture, not inferred from the controller's CPU.
    if (!info.vmTypes.includes(launch.vmType)
      || (launch.vmType === 'vz' && (info.hostOS !== 'darwin' || launch.arch !== info.hostArch))) {
      return { available: false, code: 'lima_driver_unavailable' };
    }
    return launch.vmType === 'qemu' ? requireQemu(launch.arch) : { available: true };
  }
  async function inspectExact(rawResource: LimaResource) {
    const resource = LimaResourceSchema.parse(rawResource);
    validateLimaStore(resource.store);
    const native = await inspectLimaInstance({ executor, ...resource });
    return { resource, native };
  }
  return {
    async check() {
      try {
        if (!await nativeVersionAvailable()) {
          return { available: false, code: 'lima_2_required' };
        }
        const info = await nativeInfo();
        if (info.hostOS === 'linux') {
          if (!info.vmTypes.includes('qemu')) return { available: false, code: 'qemu_driver_unavailable' };
          return requireQemu(info.hostArch === 'aarch64' ? 'aarch64' : 'x86_64');
        }
        return info.vmTypes.includes('vz') ? { available: true } : { available: false, code: 'vz_driver_unavailable' };
      } catch (error) { return projectMachineProvisionerActionFailure(error, () => ({ available: false, code: 'lima_unavailable' })); }
    },
    async options(rawQuery: unknown): Promise<MachineProvisionerOptionsResultV1> {
      let query = LimaOptionsInputSchema.parse(rawQuery);
      let templateInfo: Awaited<ReturnType<typeof nativeInfo>> | undefined;
      // A template selector is not a disk-image location. Resolve it at review
      // using Lima's existing inherited-image projection, before saving/spending.
      if (query.image?.startsWith('template:')) {
        if (query.arch === undefined) templateInfo = await nativeInfo();
        let image: string | undefined;
        try { image = await resolveTemplateImage(query.image, query.arch ?? templateInfo?.hostArch); }
        catch (error) { return projectMachineProvisionerActionFailure(error, () => { throw new PluginError({ code: 'lima_image_unavailable' }); }); }
        if (!image) throw new PluginError({ code: 'lima_image_unavailable' });
        query = { ...query, image };
      }
      // The existing product create recipe uses --mount-none. Preserve every
      // explicitly reviewed mount; omitted mounts keep that no-mount default.
      const explicit = LimaLaunchSchema.safeParse({ ...query, mounts: query.mounts ?? [] });
      // The controller's native info owns the store and template defaults. Never infer them from
      // the viewing device, or replace a complete retained recipe on a refresh.
      const info = templateInfo ?? (explicit.success ? undefined : await nativeInfo());
      const template = info?.defaultTemplate;
      const arch = query.arch ?? info?.hostArch;
      let defaultImage = query.image ?? templateImage(template?.images, arch);
      // Lima 2.2.1 info leaves base templates unresolved: an inherited image
      // can be absent while the other native defaults are already known.
      if (defaultImage === undefined && info) {
        try {
          // Lima 2.1+ template yq embeds base templates before querying. Its
          // built-in JSON projection avoids a second process or YAML parser.
          defaultImage = await resolveTemplateImage('template:default', arch);
        } catch { /* Unavailable template facts leave the image for the person to supply. */ }
      }
      const parsed = explicit.success ? explicit : LimaOptionsInputSchema.safeParse(projectNativeJsonValueForTransport({
        store: info?.limaHome, image: defaultImage, arch,
        vmType: template?.vmType ?? (info?.hostOS === 'darwin' ? 'vz' : 'qemu'), cpus: template?.cpus,
        memoryGiB: templateGiB(template?.memory), diskGiB: templateGiB(template?.disk),
        ...query, mounts: query.mounts ?? [],
      }));
      const emptyDimensions = { size: [], image: [], location: [], network: [], duration: [] };
      if (!parsed.success) return { dimensions: emptyDimensions };
      const launch = parsed.data;
      if (launch.store !== undefined) validateLimaStore(launch.store);
      const availability = launch.arch !== undefined && launch.vmType !== undefined
        ? await launchAvailability({ arch: launch.arch, vmType: launch.vmType }, info) : { available: false };
      const size = launch.cpus !== undefined && launch.memoryGiB !== undefined && launch.diskGiB !== undefined
        ? { id: `${launch.cpus}/${launch.memoryGiB}/${launch.diskGiB}`,
        title: machinePresentationLabel('customSize'),
        cpuCores: launch.cpus, memoryBytes: launch.memoryGiB * gib, diskBytes: launch.diskGiB * gib } : undefined;
      const image = launch.image === undefined ? undefined : { id: launch.image, ...describeImage(launch.image) };
      // buildCreateArgs always configures the Ubuntu guest template, independently of the controller OS.
      const nativeRefusalCode = 'code' in availability ? availability.code : undefined;
      const unavailableReason = !availability.available && nativeRefusalCode ? {
        code: nativeRefusalCode,
        status: machinePresentationLabel(nativeRefusalCode === 'lima_driver_unavailable'
          ? launch.vmType === 'vz' ? 'vz_driver_unavailable' : 'qemu_driver_unavailable' : 'qemu_unavailable'),
        ...(nativeRefusalCode === 'lima_driver_unavailable' ? { fieldPath: 'vmType' } : {}),
      } : undefined;
      return { base: { launch, guestPlatform: 'linux', available: availability.available,
        ...(image ? { nativeFacts: { image } } : {}),
        ...(unavailableReason ? { unavailableReason } : {}) }, dimensions: { ...emptyDimensions,
        size: size ? [{ id: size.id, title: size.title, nativeFacts: { size }, assignments: [{ path: 'cpus', value: size.cpuCores },
          { path: 'memoryGiB', value: size.memoryBytes / gib }, { path: 'diskGiB', value: size.diskBytes / gib }] }] : [],
      } };
    },
    async acquire(input: Readonly<{ managedId?: string; launch: LimaLaunch }>) {
      if (input.managedId === undefined || input.managedId.length === 0) return { kind: 'rejected' as const, code: 'invalid_request' as const };
      const launch = LimaLaunchSchema.parse(input.launch);
      validateLimaStore(launch.store);
      if (launch.image.startsWith('template:')) return { kind: 'rejected' as const, code: 'provider_unavailable' as const,
        nativeCause: { localCause: 'native_options_changed' as const } };
      const expected = limaAcquisitionResource(launch, input.managedId);
      try {
        const availability = await launchAvailability(launch);
        if (!availability.available) {
          throw Object.assign(new Error('reviewed native launch unavailable'), { code: 'code' in availability ? availability.code : 'lima_driver_unavailable' });
        }
        const nativeLaunch = { ...launch, instance: expected.instance };
        const created = await createLimaInstance({ executor, ...nativeLaunch, createArgs: buildCreateArgs(nativeLaunch) });
        // Matching native configuration is not this acquisition's creation
        // custody. Existing row-owned guests are recovered through reconcile.
        if (!created.created) return { kind: 'rejected' as const, code: 'resource_mismatch' as const };
        if (!sameCreationFacts(created.instance, expected)) {
          // This may follow allocation. Rejection would falsely confirm absence
          // upstream and discard the exact native scope needed for recovery.
          throw Object.assign(new Error('allocated Lima creation facts differ'), { code: 'resource_mismatch' });
        }
        if (String(limaInstanceField(created.instance, 'status')).toLowerCase() !== 'running') {
          const started = await changeLimaPower({ executor, ...expected, intent: 'start' });
          if (started.status.toLowerCase() !== 'running') throw Object.assign(new Error('Lima startup is unconfirmed'), { code: 'lima_start_unconfirmed' });
        }
        return { kind: 'bound' as const, resource: { contributionRef, schemaVersion: 1, value: expected } };
      } catch (error) {
        return { kind: 'unknown' as const, recovery: { reference: `${expected.store}/${expected.instance}`, reason: refusalCode(error) },
          ...nativeFailure(error) };
      }
    },
    async bootstrap(resource: LimaResource) {
      const { native } = await inspectExact(resource);
      if (!native || String(limaInstanceField(native, 'status')).toLowerCase() !== 'running') {
        // Lima's start command is awaited by acquire/power. A later Stopped
        // observation alone cannot establish an outstanding start.
        throw new PluginError({ code: 'native_resource_unavailable' });
      }
      // Only native IO is selected here. Binary installation, private payload
      // selection, credentials and Home enrollment remain host-owned.
      return { kind: 'native' as const, transport: { contributionRef, schemaVersion: 1 } };
    },
    async reconcile(target: Readonly<{ managedId: string; launch: LimaLaunch }> | Readonly<{ resource: LimaResource }>) {
      const expected = 'launch' in target ? limaAcquisitionResource(LimaLaunchSchema.parse(target.launch), target.managedId) : target.resource;
      try {
        const { resource, native } = await inspectExact(expected);
        if (!native) return { kind: 'rejected' as const, code: 'managed_not_found' as const };
        return { kind: 'bound' as const, resource: { contributionRef, schemaVersion: 1, value: resource } };
      } catch (error) {
        return projectMachineProvisionerActionFailure(error, () => ({ kind: 'unknown' as const,
          recovery: { reference: `${expected.store}/${expected.instance}`, reason: refusalCode(error) } }));
      }
    },
    async inspect(resource: LimaResource) {
      try {
        const { native } = await inspectExact(resource);
        const status = native ? String(limaInstanceField(native, 'status')).toLowerCase() : 'absent';
        return observeMachineProvisionerNativeRead(observedAt, {
          kind: native ? 'present' : 'absent',
          ...(native ? { power: status === 'running' ? 'running' as const : status === 'stopped' ? 'stopped' as const : 'unknown' as const,
            storage: 'retained' as const, size: nativeSize(native) } : {}),
          billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
        });
      } catch (error) { return projectMachineProvisionerActionFailure(error,
        () => observeMachineProvisionerNativeRead(observedAt, { kind: 'unknown', reason: refusalCode(error) })); }
    },
    async resize(rawResource: LimaResource, size: MachineProvisionerSizeV1): Promise<MachineProvisionerResizeResultV1> {
      let issued = false;
      try {
        const { resource, native } = await inspectExact(rawResource);
        if (!native) return { kind: 'refused', code: 'native_resource_unavailable' };
        if (size.diskBytes !== undefined && size.diskBytes < nativeSize(native).diskBytes!) {
          return { kind: 'unsupported', dimension: 'diskBytes', code: 'lima_disk_shrink_unsupported' };
        }
        // Lima 2.1 edit.go edits only stopped guests. instance/start.go grows
        // the disk on the subsequent start. A stopped guest stays stopped.
        issued = true;
        const result = await runLimaCommand({ executor, store: resource.store, interactive: true,
          args: ['edit', '--tty=false', ...(size.cpuCores === undefined ? [] : ['--cpus', String(size.cpuCores)]),
            ...(size.memoryBytes === undefined ? [] : ['--memory', String(size.memoryBytes / gib)]),
            ...(size.diskBytes === undefined ? [] : ['--disk', String(size.diskBytes / gib)]), resource.instance] });
        return result.exitCode === 0 ? { kind: 'confirmed' } : { kind: 'unknown', code: 'lima_resize_failed' };
      } catch (error) { return { kind: issued ? 'unknown' : 'refused', code: refusalCode(error), ...nativeFailure(error) }; }
    },
    async power(rawResource: LimaResource, intent: 'start' | 'stop') {
      try {
        const resource = LimaResourceSchema.parse(rawResource);
        validateLimaStore(resource.store);
        const power = await changeLimaPower({ executor, ...resource, intent });
        return { kind: power.status.toLowerCase() === (intent === 'start' ? 'running' : 'stopped') ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        const code = refusalCode(error);
        return { kind: code === 'MANAGED_LIMA_INSTANCE_ABSENT' || code === 'resource_mismatch' || code === 'LIMA_IDENTITY_MISMATCH' ? 'refused' as const : 'unknown' as const, code,
          ...nativeFailure(error) };
      }
    },
    async destroy(rawResource: LimaResource) {
      try {
        const resource = LimaResourceSchema.parse(rawResource);
        validateLimaStore(resource.store);
        const result = await deleteLimaInstance({ executor, ...resource });
        return { kind: result.kind === 'absent' ? 'confirmed' as const : 'unknown' as const };
      } catch (error) {
        return projectMachineProvisionerActionFailure(error, () => ({
          kind: refusalCode(error) === 'resource_mismatch' || refusalCode(error) === 'LIMA_IDENTITY_MISMATCH' ? 'refused' as const : 'unknown' as const,
          code: refusalCode(error) }));
      }
    },
    async exec(rawResource: LimaResource, argv: readonly string[], input?: Uint8Array) {
      const resource = LimaResourceSchema.parse(rawResource);
      validateLimaStore(resource.store);
      return execLimaGuest({ executor, ...resource, argv, input });
    },
    /** The optional `stream` role: one long-lived guest shell process carrying the invocation channel. */
    async stream(rawResource: LimaResource, argv: readonly string[]): Promise<TChannel> {
      const resource = LimaResourceSchema.parse(rawResource);
      validateLimaStore(resource.store);
      const { channel } = executor;
      if (!channel) throw Object.assign(new Error('native Lima channel is unavailable'), { code: 'LIMA_CHANNEL_UNSUPPORTED' });
      return openLimaGuestChannel({ executor: { ...executor, channel }, ...resource, argv });
    },
    async putFile(rawResource: LimaResource, guestPath: string, bytes: Uint8Array, mode?: string) {
      const resource = LimaResourceSchema.parse(rawResource);
      validateLimaStore(resource.store);
      return putLimaGuestFile({ executor, ...resource, guestPath, bytes, mode });
    },
  };
}
