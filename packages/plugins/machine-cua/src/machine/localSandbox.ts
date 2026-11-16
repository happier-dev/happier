import { cuaPreparedNames, type CuaNativeClient } from './nativeClient.js';
import { cuaNativePowerVerb, type CuaPowerIntent } from './nativePower.js';
import { readCuaSpaceRegistryEntry } from './nativeSpaces.js';
import { CuaLocalLaunchV1Schema, CuaLocalNameSchema, parseCuaLocalResource, CuaNativeSandboxSchema, CuaNativeDeleteSchema,
    type CuaLocalResourceV1 } from './schemas.js';

/** QEMU info/ls/connect omit image in v0.27.5. The admitted exact id/runtime
 * owns a plain sandbox; a Space additionally has authoritative registry image.
 * Reject a reported mismatch, without inventing missing sandbox image evidence. */
export function cuaLocalImageMatches(kind: CuaLocalResourceV1['kind'], imageId: string | undefined, expected: string) {
    return imageId === expected || (kind === 'sandbox' && imageId === undefined);
}

export function createCuaLocalSandbox(native: CuaNativeClient) {
    async function inspect(input: unknown, signal?: AbortSignal) {
        const resource = parseCuaLocalResource(input);
        const unknown = { resource, existence: 'unknown' as const, power: 'unknown' as const };
        const response = await native.json(['--embedded', 'sandbox', 'info', resource.sandboxId], signal);
        // After a finished delete the native registry no longer has the record
        // and `info` answers with typed NotFound instead of a `missing` row.
        if (response.kind === 'unknown' && response.reason === 'not_found') {
            return { resource, existence: 'absent' as const, power: 'unknown' as const };
        }
        if (response.kind !== 'success') return unknown;
        const parsed = CuaNativeSandboxSchema.safeParse(response.value);
        if (!parsed.success || parsed.data.id !== resource.sandboxId || parsed.data.runtime !== resource.runtimeId
            || `local:${parsed.data.name}` !== resource.sandboxId || parsed.data.ephemeral) return unknown;
        const facts = parsed.data;
        if (facts.status === 'missing' && facts.state === 'missing') {
            return { resource, existence: 'absent' as const, power: 'unknown' as const };
        }
        // Runtime status, not the registry's provisioning phase, owns power.
        const power = facts.state === 'running' || facts.state === 'stopped' || facts.state === 'suspended'
            ? facts.state : 'unknown';
        if (power === 'unknown') return unknown;
        return { resource, existence: 'present' as const, power,
            ...(facts.image !== null ? { imageId: facts.image } : {}) } satisfies {
                resource: CuaLocalResourceV1; existence: 'present'; power: 'running' | 'stopped' | 'suspended'; imageId?: string;
            };
    }
    return {
        async create(input: unknown, nameInput: string, imageDiskBytes: number, signal?: AbortSignal) {
            const launch = CuaLocalLaunchV1Schema.parse(input);
            const name = CuaLocalNameSchema.parse(nameInput);
            // Portable number grammar retains exact byte precision but has no
            // multipleOf. The native --memory MB flag accepts integral MiB.
            if (launch.size.memoryBytes % 1024 ** 2 !== 0) {
                throw new Error('Native sandbox memory requires integral MiB');
            }
            // The native sandbox CLI ignores --disk. Selection must match the
            // qualified image's actual disk, rather than promise invented sizing.
            if (launch.size.diskBytes !== imageDiskBytes) return { kind: 'unavailable' as const, reason: 'image_disk_mismatch' as const };
            const recovery = { namespace: 'local' as const, runtimeId: launch.runtimeId, sandboxId: `local:${name}` };
            const resource: CuaLocalResourceV1 = { kind: 'sandbox', ...recovery };
            if (launch.preparedOperationId !== undefined) {
                // Fork restores the artifact's retained sizing. S1 supplies its
                // complete launch after revision matching; this is not a resize.
                const checkpoint = await native.preparedCheckpoint(launch.preparedOperationId, launch, signal);
                if (checkpoint.kind !== 'present' || !checkpoint.pinned) return { kind: 'unknown' as const, recovery };
                const forked = await native.effect(['--embedded', 'sandbox', 'fork',
                    cuaPreparedNames(launch.preparedOperationId).checkpoint, name], signal);
                if (forked.kind !== 'success') return { kind: 'unknown' as const, recovery };
                const observed = await inspect(resource, signal);
                return observed.existence === 'present' && observed.power === 'running' && cuaLocalImageMatches('sandbox', observed.imageId, launch.imageId)
                    ? { kind: 'bound' as const, resource } : { kind: 'unknown' as const, recovery };
            }
            // Native open() otherwise follows CUA_DAEMON or daemon discovery.
            // Embedded uses the same native state store on this controller.
            const response = await native.json(['--embedded', 'sandbox', 'create', '--on=local', `--runtime=${launch.runtimeId}`,
                `--name=${name}`, `--cpu=${launch.size.cpu}`, `--memory=${launch.size.memoryBytes / 1024 ** 2}MB`,
                '--keep-on-failure', launch.imageId], signal);
            if (response.kind !== 'success') return { kind: 'unknown' as const, recovery, nativeCause: response.nativeCause };
            const parsed = CuaNativeSandboxSchema.safeParse(response.value);
            if (!parsed.success || parsed.data.id !== resource.sandboxId || parsed.data.runtime !== resource.runtimeId
                || parsed.data.name !== name || parsed.data.image !== launch.imageId || parsed.data.ephemeral || parsed.data.state !== 'running') {
                return { kind: 'unknown' as const, recovery };
            }
            return { kind: 'bound' as const, resource };
        },
        inspect,
        async power(input: unknown, intent: CuaPowerIntent, signal?: AbortSignal) {
            const resource = parseCuaLocalResource(input);
            // Sandbox CLI has suspend/resume but no disk-preserving Stop.
            if (intent === 'stop') return { kind: 'unsupported' as const, intent, resource };
            const before = await inspect(resource, signal);
            if (before.existence !== 'present') return { kind: 'unavailable' as const,
                reason: before.existence === 'absent' ? 'native_resource_absent' as const : 'native_resource_unknown' as const, resource };
            const response = await native.effect(['--embedded', 'sandbox', cuaNativePowerVerb(intent), resource.sandboxId], signal);
            if (response.kind !== 'success') return { kind: 'unknown' as const, resource };
            return { kind: 'observed' as const, ...await inspect(resource, signal) };
        },
        async destroy(input: unknown, signal?: AbortSignal, expectedImageId?: string) {
            const resource = parseCuaLocalResource(input);
            const before = await inspect(resource, signal);
            if (before.existence === 'unknown') return { kind: 'unknown' as const, existence: 'unknown' as const, resource };
            if (before.existence === 'absent') return { kind: 'deleted' as const, existence: 'absent' as const, resource };
            if (expectedImageId !== undefined) {
                // VM Spaces report a null native image; their exact local
                // registration is the image evidence while compute is present.
                const imageId = before.imageId ?? (resource.kind === 'space'
                    ? (await readCuaSpaceRegistryEntry(native, resource.spaceId, signal, 'local')).image : undefined);
                if (!cuaLocalImageMatches(resource.kind, imageId, expectedImageId)) return { kind: 'unknown' as const, existence: 'unknown' as const, resource };
            }
            // Immutable native basis 2bce4442: sandbox-core/sandbox.rs
            // 2349–2382,3373–3379 awaits local runtime deletion (or typed native
            // NotFound) before deleting its record. CLI rm serializes this only
            // after awaiting delete. A later typed NotFound can therefore settle
            // cleanup after the completed rm reply was lost.
            const response = await native.json(['--embedded', 'sandbox', 'rm', resource.sandboxId, '--force'], signal);
            const parsed = response.kind === 'success' ? CuaNativeDeleteSchema.safeParse(response.value) : undefined;
            return parsed?.success && parsed.data.deleted === resource.sandboxId
                ? { kind: 'deleted' as const, existence: 'absent' as const, resource }
                : { kind: 'unknown' as const, existence: 'unknown' as const, resource };
        },
    };
}
