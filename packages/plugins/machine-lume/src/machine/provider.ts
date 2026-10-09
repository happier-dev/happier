import type {
  MachineProvisionerAcquireResultV1, MachineProvisionerCheckResultV1,
  MachineProvisionerObservationV1, MachineProvisionerOptionsResultV1,
  MachineProvisionerPowerResultV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import type { LumeNativeClient } from './nativeClient.js';
import { LumeLaunchV1Schema, LumeResourceV1Schema, LumeNativeOperationV1Schema, LumeOptionsInputV1Schema, type LumeResourceV1, type LumeLaunchV1, type LumeNativeOperationV1 } from './schemas.js';
import { LUME_PLUGIN_ID, LUME_PROVISIONER_ID, LUME_BILLING } from './definition.js';
import { lumeConfigurationLabel } from '../ui/translations.js';
const contributionRef = { pluginId: LUME_PLUGIN_ID, localId: LUME_PROVISIONER_ID };
// Pinned libs/images/macos/build.sh builds these ghcr.io/trycua/macos tiers
// through the native default SSH account. The driver VM guide separately
// qualifies the exact published macos-tahoe-cua:26.5.2 reference. Native custom
// image selection remains available as ingress, but cannot allocate until its
// initial private carrier is qualified. Never infer login from an OS name.
function qualifiedSshImage(reference: string) {
  return ['ghcr.io/trycua/macos:26', 'ghcr.io/trycua/macos:26-slim', 'ghcr.io/trycua/macos:26-xcode',
    'ghcr.io/trycua/macos-tahoe-cua:26.5.2'].includes(reference);
}
function qualifiedImage(image: LumeLaunchV1['image']) {
  const reference = image.kind === 'catalog' ? image.id : image.reference;
  if (qualifiedSshImage(reference)) return image.kind === 'catalog' || !image.privateCarrier
    || (image.privateCarrier.guestOs === 'macos' && image.privateCarrier.user === 'lume');
  return image.kind === 'native-image' && image.privateCarrier !== undefined;
}
function nativeIdentity(resource: LumeResourceV1) {
  return { storage: resource.storage, vmName: resource.vmName };
}
export function lumeOperationForLaunch(launch: LumeLaunchV1, managedId: string | undefined) {
  return LumeNativeOperationV1Schema.safeParse({ storage: launch.storage, vmName: `happier-${managedId}`,
    ...(launch.image.kind === 'native-image' && launch.image.privateCarrier ? { privateCarrier: launch.image.privateCarrier } : {}) });
}

/** Native facts and IO only; managed custody, retry and policy stay at C50/C52. */
export function createLumeProvider({ native, observedAt, signal }: Readonly<{
  native: LumeNativeClient; observedAt: number; signal?: AbortSignal;
}>) {
  function pending(resource: LumeNativeOperationV1): MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1> {
    return { kind: 'pending', nativeOperationRef: { contributionRef, schemaVersion: 1, value: resource } };
  }

  return {
    async check(): Promise<MachineProvisionerCheckResultV1> {
      const runtime = await native.check(signal);
      return runtime.kind === 'runtime' ? { available: true } : { available: false, code: `lume_${runtime.reason}` };
    },
    async options(rawQuery: unknown = {}): Promise<MachineProvisionerOptionsResultV1> {
      const query = LumeOptionsInputV1Schema.parse(rawQuery);
      const customImage = query.image?.kind === 'native-image' ? query.image : undefined;
      const [catalogs, locations] = await Promise.all([
        customImage ? Promise.resolve([]) : Promise.all([native.catalog('macos', signal), native.catalog('macos-tahoe-cua', signal)]),
        native.locations(signal),
      ]);
      if (catalogs.some(catalog => catalog.kind !== 'catalog') || locations.kind !== 'locations') {
        throw Object.assign(new Error('Native Lume choices unavailable'), { code: 'provider_unavailable' });
      }
      // Cache IDs lose the tag and truncate the manifest digest. Only native
      // registry-returned references form launch choices; the qualification
      // owner filters private-carrier support. No guessed sizes/headroom.
      const size = query.cpu !== undefined && query.memoryBytes !== undefined && query.diskBytes !== undefined
        ? { cpu: query.cpu, memoryBytes: query.memoryBytes, diskBytes: query.diskBytes } : undefined;
      const storage = locations.locations.find(location => location.name === query.storage)?.name;
      const images = customImage ? [{ reference: customImage.reference, image: customImage }]
        : catalogs.flatMap(catalog => catalog.kind === 'catalog' ? catalog.references : []).filter(qualifiedSshImage)
          .map(reference => ({ reference, image: { kind: 'catalog' as const, id: reference } }));
      return { choices: [
        ...images.map(({ reference, image }) => ({ id: reference, title: reference, available: qualifiedImage(image),
            ...(size && storage && qualifiedImage(image) ? { launch: { image, storage, ...size } } : {}),
            nativeFacts: { image: { id: reference, title: reference },
              ...(storage ? { location: { id: storage, title: storage } } : {}),
              ...(size ? { size: { id: `${size.cpu}/${size.memoryBytes}/${size.diskBytes}`, title: lumeConfigurationLabel('customSize'),
                cpuCores: size.cpu, memoryBytes: size.memoryBytes, diskBytes: size.diskBytes } } : {}) } })),
        ...locations.locations.map(location => ({ id: `storage:${location.name}`, title: location.name, available: true,
          nativeFacts: { location: { id: location.name, title: location.name } } })),
      ] };
    },
    async acquire(rawLaunch: unknown, managedId: string | undefined): Promise<MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1>> {
      const parsed = LumeLaunchV1Schema.safeParse(rawLaunch);
      // UUID is the canonical current managed-row producer. Do not generate a
      // second leaf identity or admit a caller-provided native VM name.
      if (!parsed.success) {
        return { kind: 'rejected', code: 'invalid_request' };
      }
      const launch = parsed.data;
      const identity = lumeOperationForLaunch(launch, managedId);
      if (!identity.success) return { kind: 'rejected', code: 'invalid_request' };
      const reference = launch.image.kind === 'catalog' ? launch.image.id : launch.image.reference;
      if (!qualifiedImage(launch.image)) return { kind: 'rejected', code: 'provider_unavailable' };
      const resource = identity.data;
      const runtime = await native.check(signal);
      const locations = await native.locations(signal);
      if (runtime.kind !== 'runtime' || locations.kind !== 'locations') return { kind: 'rejected', code: 'provider_unavailable' };
      if (!locations.locations.some(location => location.name === launch.storage)) return { kind: 'rejected', code: 'invalid_request' };
      if (launch.image.kind === 'catalog') {
        const images = await native.catalog(reference.startsWith('ghcr.io/trycua/macos-tahoe-cua:') ? 'macos-tahoe-cua' : 'macos', signal);
        if (images.kind !== 'catalog') return { kind: 'rejected', code: 'provider_unavailable' };
        if (!images.references.includes(reference)) return { kind: 'rejected', code: 'invalid_request' };
      }
      const [registry, organization, ...imagePath] = reference.split('/');
      const pulled = await native.pull({ ...nativeIdentity(resource), registry, organization, image: imagePath.join('/') }, signal);
      if (pulled.kind === 'unknown') return pending(resource);
      const configured = await native.configure(nativeIdentity(resource), {
        cpu: launch.cpu, memory: `${launch.memoryBytes}B`, diskSize: `${launch.diskBytes}B`,
      }, signal);
      if (configured.kind === 'unknown') return pending(resource);
      const started = await native.run(nativeIdentity(resource), signal);
      if (started.kind === 'unknown') return pending(resource);
      return { kind: 'bound', resource: { contributionRef, schemaVersion: 1, value: resource } };
    },
    async reconcile(rawOperation: unknown): Promise<MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1>> {
      const parsed = LumeNativeOperationV1Schema.safeParse(rawOperation);
      if (!parsed.success) return { kind: 'rejected', code: 'invalid_request' };
      const observed = await native.inspect(nativeIdentity(parsed.data), signal);
      // A provisioning marker need not have a usable disk. Unknown HTTP codes,
      // partial native provisioning and lost observations retain the same ref.
      return observed.kind === 'present' && ['running', 'stopped'].includes(observed.vendorStatus)
        ? { kind: 'bound', resource: { contributionRef, schemaVersion: 1, value: parsed.data } }
        : pending(parsed.data);
    },
    async inspect(rawResource: unknown): Promise<MachineProvisionerObservationV1> {
      const resource = LumeResourceV1Schema.parse(rawResource);
      const observed = await native.inspect(nativeIdentity(resource), signal);
      if (observed.kind !== 'present') return { observedAt, availability: 'unavailable', reason: observed.reason, billing: LUME_BILLING };
      // CD1 makes name-keyed native status exact for Happier-owned resources.
      // Native initialized() permits an incomplete provisioning marker without
      // a disk. Only settled running/stopped details prove the retained files.
      return { observedAt, availability: 'present', storage: observed.vendorStatus === 'running' || observed.vendorStatus === 'stopped' ? 'retained' : 'unknown',
        daemon: 'unknown', power: observed.vendorStatus === 'running' ? 'running'
        : observed.vendorStatus === 'stopped' ? 'stopped' : 'unknown', billing: LUME_BILLING };
    },
    async power(rawResource: unknown, intent: string): Promise<MachineProvisionerPowerResultV1> {
      const resource = LumeResourceV1Schema.parse(rawResource);
      if (intent !== 'start' && intent !== 'stop') return { kind: 'refused', code: 'unsupported_intent' };
      const result = intent === 'start' ? await native.run(nativeIdentity(resource), signal) : await native.stop(nativeIdentity(resource), signal);
      if (result.kind === 'unknown') return { kind: 'unknown', code: result.reason };
      const observed = await native.inspect(nativeIdentity(resource), signal);
      return observed.kind === 'present' && observed.vendorStatus === (intent === 'start' ? 'running' : 'stopped')
        ? { kind: 'confirmed' } : { kind: 'unknown', code: observed.kind === 'unknown' ? observed.reason : 'native_pending' };
    },
    async destroy(rawResource: unknown): Promise<MachineProvisionerPowerResultV1> {
      const result = await native.destroy(nativeIdentity(LumeResourceV1Schema.parse(rawResource)), signal);
      // Pinned handleDeleteVM awaits LumeController.delete, which awaits Stop
      // and removes the exact VM directory before returning HTTP200. HTTP400,
      // lost response and uncertain pre-inspection never establish absence.
      return result.kind === 'delete-accepted' ? { kind: 'confirmed' }
        : { kind: 'unknown', code: result.kind === 'unknown' ? result.reason : 'native_pending' };
    },
  };
}
