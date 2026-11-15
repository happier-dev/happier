import type {
  MachineProvisionerAcquireResultV1, MachineProvisionerCheckResultV1,
  MachineProvisionerObservationV1, MachineProvisionerOptionsResultV1,
  MachineProvisionerPowerResultV1, MachineProvisionerNativeCauseV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { observeMachineProvisionerNativeRead } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { LumeCacheState, LumeNativeClient, LumeNativeInspection } from './nativeClient.js';
import { LumeLaunchV1Schema, LumeResourceV1Schema, LumeNativeOperationV1Schema, LumeOptionsInputV1Schema, resolveLumeOptionsImageCandidate, type LumeResourceV1, type LumeLaunchV1, type LumeNativeOperationV1 } from './schemas.js';
import { LUME_PLUGIN_ID, LUME_PROVISIONER_ID, LUME_BILLING } from './definition.js';
import { lumeConfigurationLabel } from '../ui/translations.js';
import { LUME_MACOS_VM_LIMIT } from './capacity.js';
const contributionRef = { pluginId: LUME_PLUGIN_ID, localId: LUME_PROVISIONER_ID };
const nativeCauseOf = (value: Readonly<{ kind: string; nativeCause?: MachineProvisionerNativeCauseV1 }>) => value.nativeCause;
const failureCause = (value: Readonly<{ kind: string; nativeCause?: MachineProvisionerNativeCauseV1 }>) => value.nativeCause ? { nativeCause: value.nativeCause } : {};
const nativeRouteRefusal = (value: Readonly<{ kind: string; nativeCause?: MachineProvisionerNativeCauseV1 }>) =>
  value.nativeCause && 'localCause' in value.nativeCause && value.nativeCause.localCause === 'native_route_not_found'
    ? { kind: 'refused' as const, code: 'native_route_not_found', nativeCause: value.nativeCause } : undefined;
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
function imageGuestPlatform(image: LumeLaunchV1['image']): 'linux' | 'darwin' | undefined {
  const reference = image.kind === 'catalog' ? image.id : image.reference;
  if (qualifiedSshImage(reference)) return 'darwin';
  if (image.kind === 'native-image' && image.privateCarrier) {
    return image.privateCarrier.guestOs === 'macos' ? 'darwin' : 'linux';
  }
  return undefined;
}
function nativeIdentity(resource: LumeResourceV1) {
  return { storage: resource.storage, vmName: resource.vmName };
}
export function lumeOperationForLaunch(launch: LumeLaunchV1, managedId: string | undefined) {
  return LumeNativeOperationV1Schema.safeParse({ storage: launch.storage,
    ...(launch.keepPasswordLogin === undefined ? {} : { keepPasswordLogin: launch.keepPasswordLogin }),
    vmName: managedId === undefined ? undefined : `happier-${managedId}`,
    ...(launch.image.kind === 'native-image' && launch.image.privateCarrier ? { privateCarrier: launch.image.privateCarrier } : {}) });
}

/** Native facts and IO only; managed custody, retry and policy stay at C50/C52. */
export function createLumeProvider({ native, observedAt, signal, warn }: Readonly<{
  native: LumeNativeClient; observedAt: number; signal?: AbortSignal;
  warn?: (warning: Readonly<{ code: 'lume_cache_enable_failed'; cacheState: LumeCacheState }>) => void;
}>) {
  function pending(resource: LumeNativeOperationV1, nativeCause?: MachineProvisionerNativeCauseV1): MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1> {
    return { kind: 'pending', nativeOperationRef: { contributionRef, schemaVersion: 1, value: resource },
      ...(nativeCause ? { nativeCause } : {}) };
  }

  async function configureAndStart(launch: LumeLaunchV1, resource: LumeNativeOperationV1, initial: LumeNativeInspection): Promise<MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1>> {
    // Native resize only grows. Keep custody of an image whose real disk
    // cannot satisfy the reviewed size; never boot it with different hardware.
    if (initial.kind !== 'present' || initial.diskBytes > launch.diskBytes) return pending(resource, nativeCauseOf(initial));
    // Lume's macOS disk transaction rejects equal sizes as well as shrinking.
    // Produce only actual hardware changes; a fully matching VM needs no PATCH.
    const configuration = {
      ...(initial.cpu !== launch.cpu ? { cpu: launch.cpu } : {}),
      ...(initial.memoryBytes !== launch.memoryBytes ? { memory: `${launch.memoryBytes}B` } : {}),
      ...(initial.diskBytes < launch.diskBytes ? { diskSize: `${launch.diskBytes}B` } : {}),
    };
    if (Object.keys(configuration).length) {
      const configured = await native.configure(nativeIdentity(resource), configuration, signal);
      if (configured.kind !== 'configure-accepted') return pending(resource,
        configured.kind === 'unknown' ? configured.nativeCause : undefined);
    }
    const applied = await native.inspect(nativeIdentity(resource), signal);
    if (applied.kind !== 'present' || applied.cpu !== launch.cpu || applied.memoryBytes !== launch.memoryBytes
      || applied.diskBytes !== launch.diskBytes) return pending(resource, nativeCauseOf(applied));
    const started = await native.run(nativeIdentity(resource), signal);
    // Pull/configure may already have effects: retain exact custody even when
    // capacity refuses Start. Rejected is reserved for pre-effect refusals.
    if (started.kind === 'refused') return pending(resource, started.nativeCause);
    return started.kind !== 'start-accepted' ? pending(resource, nativeCauseOf(started))
      : { kind: 'bound', resource: { origin: 'created' as const, contributionRef, schemaVersion: 1, value: resource }, startPending: true };
  }

  return {
    async check(): Promise<MachineProvisionerCheckResultV1> {
      const runtime = await native.check(signal);
      if (runtime.kind !== 'runtime') return { available: false, code: `lume_${runtime.reason}`, ...failureCause(runtime) };
      const facts = await native.hostFacts(observedAt, signal);
      return { available: true, code: `lume_cache_${facts.cacheState}`, localResources: facts.localResources };
    },
    async options(rawQuery: unknown = {}): Promise<MachineProvisionerOptionsResultV1> {
      const query = LumeOptionsInputV1Schema.parse(rawQuery);
      const selectedImage = resolveLumeOptionsImageCandidate(query);
      const nativeImageSelected = query.image?.kind === 'native-image';
      const customImage = selectedImage.success && selectedImage.data.kind === 'native-image' ? selectedImage.data : undefined;
      const [catalogs, locations, inventory] = await Promise.all([
        nativeImageSelected ? Promise.resolve([]) : Promise.all([native.catalog('macos', signal), native.catalog('macos-tahoe-cua', signal)]),
        native.locations(signal),
        native.inventory(signal),
      ]);
      if (catalogs.some(catalog => catalog.kind !== 'catalog') || locations.kind !== 'locations') {
        const nativeCause = [locations, ...catalogs].map(nativeCauseOf).find(cause => cause !== undefined);
        throw new PluginError({ code: 'provider_unavailable', ...(nativeCause ? { details: { nativeCause } } : {}) });
      }
      // Cache IDs lose the tag and truncate the manifest digest. Only native
      // registry-returned references form launch choices; the qualification
      // owner filters private-carrier support. No guessed sizes/headroom.
      let diskBytes = query.diskBytes;
      if (diskBytes === undefined && query.cpu !== undefined && query.memoryBytes !== undefined
        && selectedImage.success && selectedImage.data.kind === 'catalog' && qualifiedSshImage(selectedImage.data.id)) {
        const imageDisk = await native.imageDiskBytes(selectedImage.data.id, signal);
        if (imageDisk.kind === 'image') diskBytes = imageDisk.diskBytes;
      }
      const size = query.cpu !== undefined && query.memoryBytes !== undefined && diskBytes !== undefined
        ? { cpu: query.cpu, memoryBytes: query.memoryBytes, diskBytes } : undefined;
      const storage = locations.locations.find(location => location.name === query.storage)?.name;
      const images = customImage ? [{ reference: customImage.reference, image: customImage }]
        : catalogs.flatMap(catalog => catalog.kind === 'catalog' ? catalog.references : []).filter(qualifiedSshImage)
          .map(reference => ({ reference, image: { kind: 'catalog' as const, id: reference } }));
      const qualified = await Promise.all(images.map(async ({ reference, image }) => {
        const disk = size && qualifiedSshImage(reference) ? await native.imageDiskBytes(reference, signal) : undefined;
        return { reference, image, available: qualifiedImage(image)
          && (!disk || disk.kind === 'image' && size !== undefined && size.diskBytes >= disk.diskBytes) };
      }));
      const sizeFact = size ? { id: `${size.cpu}/${size.memoryBytes}/${size.diskBytes}`, title: lumeConfigurationLabel('customSize'),
        cpuCores: size.cpu, memoryBytes: size.memoryBytes, diskBytes: size.diskBytes } : undefined;
      const macosVmStatus = inventory.kind === 'inventory'
        ? { ...lumeConfigurationLabel('macosVmCount'), params: { count: inventory.runningMacosCount, limit: LUME_MACOS_VM_LIMIT } }
        : lumeConfigurationLabel('macosVmCountUnavailable');
      return { ...(size ? { base: { launch: { ...size, keepPasswordLogin: query.keepPasswordLogin === true,
        ...(storage ? { storage } : {}) } } } : {}), dimensions: {
        size: sizeFact ? [{ id: sizeFact.id, title: sizeFact.title, assignments: [], nativeFacts: { size: sizeFact } }] : [],
        image: qualified.map(({ reference, image, available }) => {
          const guestPlatform = imageGuestPlatform(image);
          const refusal = guestPlatform === 'darwin' && inventory.kind === 'inventory' ? inventory.macosStartRefusal : undefined;
          return { id: reference, title: reference, available: available && !refusal,
            ...(refusal && inventory.kind === 'inventory' ? { unavailableReason: { code: refusal.code,
              status: { ...lumeConfigurationLabel('macosVmLimitReached'), params: { count: inventory.runningMacosCount, limit: LUME_MACOS_VM_LIMIT } } } } : {}),
            ...(guestPlatform ? { guestPlatform } : {}),
            assignments: [{ path: 'image', value: image }], nativeFacts: { image: { id: reference, title: reference,
              description: macosVmStatus } } };
        }),
        location: locations.locations.map(location => ({ id: location.name, title: location.name,
          assignments: [{ path: 'storage', value: location.name }], nativeFacts: { location: { id: location.name, title: location.name } } })),
        network: [], duration: [],
      } };
    },
    async acquire(rawLaunch: unknown, managedId: string | undefined, rawResource?: unknown): Promise<MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1>> {
      const parsed = LumeLaunchV1Schema.safeParse(rawLaunch);
      // Keep the host's admitted identity; only native name constraints belong here.
      if (!parsed.success) {
        return { kind: 'rejected', code: 'invalid_request' };
      }
      const launch = parsed.data;
      const identity = lumeOperationForLaunch(launch, managedId);
      if (!identity.success) return { kind: 'rejected', code: 'invalid_request' };
      const reference = launch.image.kind === 'catalog' ? launch.image.id : launch.image.reference;
      if (!qualifiedImage(launch.image)) return { kind: 'rejected', code: 'provider_unavailable', nativeCause: { localCause: 'native_route_unavailable' } };
      const resource = identity.data;
      if (rawResource !== undefined) {
        const retained = LumeResourceV1Schema.safeParse(rawResource);
        if (!retained.success) return { kind: 'rejected', code: 'invalid_request' };
        if (retained.data.storage !== resource.storage || retained.data.vmName !== resource.vmName
          || (retained.data.keepPasswordLogin === true) !== (resource.keepPasswordLogin === true)
          || retained.data.privateCarrier?.kind !== resource.privateCarrier?.kind
          || retained.data.privateCarrier?.guestOs !== resource.privateCarrier?.guestOs
          || retained.data.privateCarrier?.user !== resource.privateCarrier?.user) {
          return { kind: 'rejected', code: 'resource_mismatch' };
        }
        const observed = await native.inspect(nativeIdentity(resource), signal);
        if (observed.kind !== 'present') return pending(resource, nativeCauseOf(observed));
        // A lost run response can leave the exact VM running. Configuration
        // must be verified from native facts; do not stop it to change sizing.
        if (observed.vendorStatus === 'running') {
          return observed.cpu === launch.cpu && observed.memoryBytes === launch.memoryBytes && observed.diskBytes === launch.diskBytes
            ? { kind: 'bound', resource: { origin: 'created' as const, contributionRef, schemaVersion: 1, value: resource } } : pending(resource);
        }
        return observed.vendorStatus === 'stopped' ? configureAndStart(launch, resource, observed) : pending(resource);
      }
      const runtime = await native.check(signal);
      const locations = await native.locations(signal);
      if (runtime.kind !== 'runtime' || locations.kind !== 'locations') {
        const nativeCause = nativeCauseOf(runtime) ?? nativeCauseOf(locations);
        return { kind: 'rejected', code: 'provider_unavailable', ...(nativeCause ? { nativeCause } : {}) };
      }
      if (!locations.locations.some(location => location.name === launch.storage)) return { kind: 'rejected', code: 'invalid_request' };
      if (launch.image.kind === 'catalog') {
        const images = await native.catalog(reference.startsWith('ghcr.io/trycua/macos-tahoe-cua:') ? 'macos-tahoe-cua' : 'macos', signal);
        if (images.kind !== 'catalog') return { kind: 'rejected', code: 'provider_unavailable', ...failureCause(images) };
        if (!images.references.includes(reference)) return { kind: 'rejected', code: 'invalid_request' };
      }
      if (qualifiedSshImage(reference)) {
        const disk = await native.imageDiskBytes(reference, signal);
        if (disk.kind !== 'image') return { kind: 'rejected', code: 'provider_unavailable', ...failureCause(disk) };
        if (launch.diskBytes < disk.diskBytes) return { kind: 'rejected', code: 'invalid_request' };
      }
      const [registry, organization, ...imagePath] = reference.split('/');
      // CD36: host preparation belongs to effectful acquire, after admission.
      // Cache availability never changes guest custody or blocks the native pull.
      let cacheState = await native.cacheState(signal);
      if (cacheState === 'disabled') cacheState = await native.enableCaching(signal);
      if (cacheState !== 'enabled') warn?.({ code: 'lume_cache_enable_failed', cacheState });
      const pulled = await native.pull({ ...nativeIdentity(resource), registry, organization, image: imagePath.join('/') }, signal);
      if (pulled.kind !== 'pull-accepted') return pending(resource, nativeCauseOf(pulled));
      return configureAndStart(launch, resource, await native.inspect(nativeIdentity(resource), signal));
    },
    async reconcile(rawOperation: unknown): Promise<MachineProvisionerAcquireResultV1<LumeResourceV1, LumeNativeOperationV1>> {
      const parsed = LumeNativeOperationV1Schema.safeParse(rawOperation);
      if (!parsed.success) return { kind: 'rejected', code: 'invalid_request' };
      const observed = await native.inspect(nativeIdentity(parsed.data), signal);
      if (observed.kind === 'absent') return { kind: 'rejected', code: 'managed_not_found' };
      // Existence establishes custody even before provisioning finishes; power and disk readiness remain observations.
      return observed.kind === 'present'
        ? { kind: 'bound', resource: { origin: 'created' as const, contributionRef, schemaVersion: 1, value: parsed.data } }
        : pending(parsed.data, nativeCauseOf(observed));
    },
    async inspect(rawResource: unknown): Promise<MachineProvisionerObservationV1> {
      const resource = LumeResourceV1Schema.parse(rawResource);
      const observed = await native.inspect(nativeIdentity(resource), signal);
      if (observed.kind === 'absent') return observeMachineProvisionerNativeRead(observedAt,
        { kind: 'absent', storage: 'lost', billing: LUME_BILLING });
      if (observed.kind === 'unknown') return observeMachineProvisionerNativeRead(observedAt,
        { kind: 'unknown', reason: observed.reason, billing: LUME_BILLING, ...failureCause(observed) });
      // CD1 makes name-keyed native status exact for Happier-owned resources.
      // Native initialized() permits an incomplete provisioning marker without
      // a disk. Only settled running/stopped details prove the retained files.
      return observeMachineProvisionerNativeRead(observedAt, { kind: 'present', storage: observed.vendorStatus === 'running' || observed.vendorStatus === 'stopped' ? 'retained' : 'unknown',
        power: observed.vendorStatus === 'running' ? 'running'
        : observed.vendorStatus === 'stopped' ? 'stopped' : 'unknown', billing: LUME_BILLING });
    },
    async power(rawResource: unknown, intent: string): Promise<MachineProvisionerPowerResultV1> {
      const resource = LumeResourceV1Schema.parse(rawResource);
      if (intent !== 'start' && intent !== 'stop') return { kind: 'refused', code: 'unsupported_intent' };
      const result = intent === 'start' ? await native.run(nativeIdentity(resource), signal) : await native.stop(nativeIdentity(resource), signal);
      if (result.kind === 'refused') return { kind: 'refused', code: result.code, nativeCause: result.nativeCause };
      const routeRefusal = nativeRouteRefusal(result);
      if (routeRefusal) return routeRefusal;
      if (result.kind === 'unknown') return { kind: 'unknown', code: result.reason, ...failureCause(result) };
      if (result.kind === 'absent') return { kind: 'refused', code: 'native_absent' };
      const observed = await native.inspect(nativeIdentity(resource), signal);
      return observed.kind === 'present' && observed.vendorStatus === (intent === 'start' ? 'running' : 'stopped')
        ? { kind: 'confirmed' } : { kind: 'unknown', code: observed.kind === 'unknown' ? observed.reason : 'native_pending', ...failureCause(observed) };
    },
    async destroy(rawResource: unknown): Promise<MachineProvisionerPowerResultV1> {
      const result = await native.destroy(nativeIdentity(LumeResourceV1Schema.parse(rawResource)), signal);
      const routeRefusal = nativeRouteRefusal(result);
      if (routeRefusal) return routeRefusal;
      // Native Stop/readback/Delete is one leaf-owned sequence. HTTP200 awaits
      // exact directory deletion; the typed HTTP400 refusal retains the row.
      if (result.kind === 'unknown' && result.nativeCause && 'localCause' in result.nativeCause
        && result.nativeCause.localCause === 'native_delete_refused') {
        return { kind: 'refused', code: 'native_delete_refused', ...failureCause(result) };
      }
      return result.kind === 'delete-accepted' || result.kind === 'absent' ? { kind: 'confirmed' }
        : { kind: 'unknown', code: result.kind === 'unknown' ? result.reason : 'native_pending', ...failureCause(result) };
    },
  };
}
