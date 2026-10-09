import type { CuaNativeClient } from './nativeClient.js';
import * as z from 'zod/mini';
import { createCuaLocalSandbox } from './localSandbox.js';
import { CuaLocalLaunchV1Schema, parseCuaLocalResource, type CuaLocalResourceV1 } from './schemas.js';

type SpaceResource = Extract<CuaLocalResourceV1, { kind: 'space' }>;
type RegistryPresence = 'present' | 'absent' | 'unknown';
export type CuaLocalSpaceCreate =
    | Readonly<{ kind: 'bound'; resource: SpaceResource }>
    | Readonly<{ kind: 'unknown'; recovery: SpaceResource }>
    | Readonly<{ kind: 'unavailable'; reason: 'native_size_units_unrepresentable' | 'image_disk_mismatch' }>;
export type CuaLocalSpaceCleanup = Readonly<{
    kind: 'deleted' | 'incomplete'; resource: SpaceResource;
    sandbox: 'absent' | 'unknown'; registry: 'removed' | 'present' | 'unknown';
}>;

// Immutable native basis: trycua/cua 2bce4442c107fc34c45b374b29a35d09f630fd83,
// cua-cli/src/host.rs SpacesCmd/run_spaces_sdk/run_spaces. Spaces delete also
// forgets imported addresses; this created-only leaf instead keeps exact native
// sandbox deletion and registry removal separate. C50 owns destruction authority.
const row = z.object({ id: z.string(), provider: z.string() });
const registrySchema = z.object({ spaces: z.array(row) });

function spaceResource(input: unknown): SpaceResource {
    const resource = parseCuaLocalResource(input);
    if (resource.kind !== 'space') {
        throw new Error('A created local Space requires its exact sandbox identity');
    }
    return resource;
}

export function createCuaLocalSpace(native: CuaNativeClient) {
    const sandbox = createCuaLocalSandbox(native);

    async function registryPresence(resource: SpaceResource, signal?: AbortSignal): Promise<RegistryPresence> {
        const result = await native.json(['--embedded', 'spaces', 'ls'], signal);
        if (result.kind !== 'success') return 'unknown';
        const parsed = registrySchema.safeParse(result.value);
        if (!parsed.success) return 'unknown';
        const selected = parsed.data.spaces.find((entry) => entry.id === resource.spaceId);
        if (!selected) return 'absent';
        return selected.provider === 'local' ? 'present' : 'unknown';
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
                if (created.kind !== 'bound') return { kind: 'unknown', recovery: resource };
                const registered = await native.json(['--embedded', 'spaces', 'add', created.resource.sandboxId], signal);
                const parsed = registered.kind === 'success' ? row.safeParse(registered.value) : undefined;
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
            // --on=local alone still follows CUA_DAEMON. The native global flag
            // selects this controller's embedded runtime and canonical state dir.
            const created = await native.json(['--embedded', 'spaces', 'create', '--on=local',
                `--runtime=${launch.runtimeId}`, `--name=${name}`, `--cpus=${launch.size.cpu}`,
                `--memory-mb=${memoryMiB}`, `--disk-gb=${diskGiB}`, '--', launch.imageId], signal);
            if (created.kind !== 'success') return { kind: 'unknown', recovery: resource };
            const parsed = registrySchema.safeParse(created.value);
            if (!parsed.success || parsed.data.spaces.length !== 1 || parsed.data.spaces[0].id !== resource.spaceId
                || parsed.data.spaces[0].provider !== 'local') {
                return { kind: 'unknown', recovery: resource };
            }
            // SpaceInfo omits runtime and image; registry presence cannot qualify
            // selected compute. Inspect the same exact sandbox, never create again.
            const inspected = await sandbox.inspect(resource, signal);
            return inspected.existence === 'present' && inspected.imageId === launch.imageId
                ? { kind: 'bound', resource }
                : { kind: 'unknown', recovery: resource };
        },
        async inspect(input: unknown, signal?: AbortSignal) {
            const resource = spaceResource(input);
            const inspected = await sandbox.inspect(resource, signal);
            const registry = await registryPresence(resource, signal);
            return { ...inspected, resource, registry };
        },
        async power(input: unknown, intent: 'start' | 'stop' | 'suspend' | 'resume', signal?: AbortSignal) {
            const resource = spaceResource(input);
            // Native registry power_state is historical, not current power proof.
            return sandbox.power(resource, intent, signal);
        },
        async destroy(input: unknown, signal?: AbortSignal): Promise<CuaLocalSpaceCleanup> {
            const resource = spaceResource(input);
            const deleted = await sandbox.destroy(resource, signal);
            const existence = deleted.kind === 'deleted' ? 'absent' : 'unknown';
            let registry = await registryPresence(resource, signal);
            if (registry === 'present') {
                // rm/remove forgets the entry and token, without touching compute.
                // Even a successful acknowledgement is not registry absence proof.
                await native.json(['--embedded', 'spaces', 'rm', resource.spaceId], signal);
                registry = await registryPresence(resource, signal);
            }
            const disposition = registry === 'absent' ? 'removed' : registry;
            return { kind: existence === 'absent' && disposition === 'removed' ? 'deleted' : 'incomplete',
                sandbox: existence, registry: disposition, resource };
        },
    };
}
