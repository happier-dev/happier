import type { MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { cuaLocalNativeImage, type CuaNativeClient } from './nativeClient.js';
import { createCuaLocalSandbox } from './localSandbox.js';
import type { CuaPowerIntent } from './nativePower.js';
import { readCuaSpaceRegistryEntry, removeCuaSpaceRegistration } from './nativeSpaces.js';
import { CuaLocalLaunchV1Schema, CuaNativeSpaceRegistrySchema, CuaNativeSpaceSchema, parseCuaLocalResource, type CuaLocalResourceV1 } from './schemas.js';

type SpaceResource = Extract<CuaLocalResourceV1, { kind: 'space' }>;
export type CuaLocalSpaceCreate =
    | Readonly<{ kind: 'bound'; resource: SpaceResource }>
    | Readonly<{ kind: 'unknown'; recovery: SpaceResource; nativeCause?: MachineProvisionerNativeCauseV1 }>
    | Readonly<{ kind: 'unavailable'; reason: 'native_size_units_unrepresentable' | 'image_disk_mismatch' }>;
export type CuaLocalSpaceCleanup = Readonly<{
    kind: 'deleted' | 'incomplete'; resource: SpaceResource;
    sandbox: 'absent' | 'unknown'; registry: 'removed' | 'present' | 'unknown';
}>;

// Immutable native basis: trycua/cua 2bce4442c107fc34c45b374b29a35d09f630fd83,
// cua-cli/src/host.rs SpacesCmd/run_spaces_sdk/run_spaces. Spaces delete also
// forgets imported addresses; this created-only leaf instead keeps exact native
// sandbox deletion and registry removal separate. C50 owns destruction authority.

function spaceResource(input: unknown): SpaceResource {
    const resource = parseCuaLocalResource(input);
    if (resource.kind !== 'space') {
        throw new Error('A created local Space requires its exact sandbox identity');
    }
    return resource;
}

export function createCuaLocalSpace(native: CuaNativeClient) {
    const sandbox = createCuaLocalSandbox(native);
    // The one Space inspection. Native `sandbox info` reports a null image for VM
    // Spaces; only the registry row names the image the Space was created from.
    async function inspectSpace(resource: SpaceResource, signal?: AbortSignal) {
        const inspected = await sandbox.inspect(resource, signal);
        const registry = await readCuaSpaceRegistryEntry(native, resource.spaceId, signal, 'local');
        if (inspected.existence === 'absent' && registry.presence !== 'absent') {
            return { ...inspected, existence: 'unknown' as const, resource, registry: registry.presence };
        }
        if (inspected.existence !== 'present') return { ...inspected, resource, registry: registry.presence };
        const imageId = inspected.imageId ?? registry.image;
        return { ...inspected, ...(imageId !== undefined ? { imageId } : {}), resource, registry: registry.presence };
    }

    return {
        async create(input: unknown, name: string, imageDiskBytes: number, signal?: AbortSignal): Promise<CuaLocalSpaceCreate> {
            const launch = CuaLocalLaunchV1Schema.parse(input);
            const resource = spaceResource({ kind: 'space', runtimeId: launch.runtimeId,
                spaceId: `local:${name}`, sandboxId: `local:${name}` });
            if (launch.runtimeId === 'gvisor' || launch.runtimeId === 'runc') {
                // SpaceCreateOptions.disk_gb is VM-only. Reuse the sandbox owner
                // for container image/disk qualification, then register only the
                // newly created exact local id. There is no public import route.
                const created = await sandbox.create(launch, name, imageDiskBytes, signal);
                if (created.kind === 'unavailable') return created;
                if (created.kind !== 'bound') return { kind: 'unknown', recovery: resource, nativeCause: created.nativeCause };
                const registered = await native.json(['--embedded', 'spaces', 'add', created.resource.sandboxId], signal);
                const parsed = registered.kind === 'success' ? CuaNativeSpaceSchema.safeParse(registered.value) : undefined;
                return parsed?.success && parsed.data.id === resource.spaceId && parsed.data.provider === 'local'
                    ? { kind: 'bound', resource }
                    : { kind: 'unknown', recovery: resource };
            }
            const memoryMiB = launch.size.memoryBytes / 1024 ** 2;
            const diskGiB = launch.size.diskBytes / 1024 ** 3;
            // These are integer MiB/GiB native flags, not guessed hardware limits.
            if (!Number.isInteger(memoryMiB) || !Number.isInteger(diskGiB)) {
                return { kind: 'unavailable', reason: 'native_size_units_unrepresentable' };
            }
            const preparedOperationId = launch.preparedOperationId;
            const prepared = preparedOperationId !== undefined;
            if (preparedOperationId !== undefined) {
                const checkpoint = await native.preparedCheckpoint(preparedOperationId, launch, signal);
                if (checkpoint.kind !== 'present' || !checkpoint.pinned) return { kind: 'unknown', recovery: resource };
            }
            const imageId = cuaLocalNativeImage(launch, 'space');
            // A prepared checkpoint already owns CPU/memory/disk; restore it.
            // --on=local alone still follows CUA_DAEMON. The native global flag
            // selects this controller's embedded runtime and canonical state dir.
            const created = await native.json(['--embedded', 'spaces', 'create', '--on=local',
                ...(prepared ? [] : [`--runtime=${launch.runtimeId}`]), `--name=${name}`,
                ...(prepared ? [] : [`--cpus=${launch.size.cpu}`, `--memory-mb=${memoryMiB}`, `--disk-gb=${diskGiB}`]),
                '--', imageId], signal);
            if (created.kind !== 'success') return { kind: 'unknown', recovery: resource, nativeCause: created.nativeCause };
            const parsed = CuaNativeSpaceRegistrySchema.safeParse(created.value);
            if (!parsed.success || parsed.data.spaces.length !== 1 || parsed.data.spaces[0].id !== resource.spaceId
                || parsed.data.spaces[0].provider !== 'local') {
                return { kind: 'unknown', recovery: resource };
            }
            // Registry presence cannot qualify selected compute: inspect the same
            // exact sandbox, never create again. `spaces create` answers a row
            // without an image, so the qualification reads the registry listing.
            const inspected = await inspectSpace(resource, signal);
            // A restored Space records the checkpoint's original base image,
            // not the checkpoint:NAME create argument (v0.27.5 native registry).
            return inspected.existence === 'present' && inspected.power === 'running' && inspected.registry === 'present' && inspected.imageId === launch.imageId
                ? { kind: 'bound', resource }
                : { kind: 'unknown', recovery: resource };
        },
        async inspect(input: unknown, signal?: AbortSignal) {
            return inspectSpace(spaceResource(input), signal);
        },
        async power(input: unknown, intent: CuaPowerIntent, signal?: AbortSignal) {
            const resource = spaceResource(input);
            // Native registry power_state is historical, not current power proof.
            return sandbox.power(resource, intent, signal);
        },
        async destroy(input: unknown, signal?: AbortSignal, expectedImageId?: string): Promise<CuaLocalSpaceCleanup> {
            const resource = spaceResource(input);
            const deleted = await sandbox.destroy(resource, signal, expectedImageId);
            const existence = deleted.kind === 'deleted' ? 'absent' : 'unknown';
            // Pending compute must qualify before any cleanup effect. Retain the
            // registry's image evidence until deletion is proven; a later exact
            // absence can finish this registration after a lost native reply.
            if (expectedImageId !== undefined && existence !== 'absent') {
                return { kind: 'incomplete', sandbox: existence, registry: 'unknown', resource };
            }
            // rm/remove forgets the entry and token, without touching compute.
            const disposition = await removeCuaSpaceRegistration(native, resource.spaceId, signal, 'local');
            return { kind: existence === 'absent' && disposition === 'removed' ? 'deleted' : 'incomplete',
                sandbox: existence, registry: disposition, resource };
        },
    };
}
