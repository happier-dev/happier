import type { CuaNativeClient } from './nativeClient.js';
import { CuaLocalLaunchV1Schema, CuaLocalNameSchema, parseCuaLocalResource, CuaNativeSandboxSchema, CuaNativeDeleteSchema,
    type CuaLocalResourceV1 } from './schemas.js';

export function createCuaLocalSandbox(native: CuaNativeClient) {
    async function inspect(input: unknown, signal?: AbortSignal) {
        const resource = parseCuaLocalResource(input);
        const unknown = { resource, existence: 'unknown' as const, power: 'unknown' as const };
        const response = await native.json(['--embedded', 'sandbox', 'info', resource.sandboxId], signal);
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
            // Native open() otherwise follows CUA_DAEMON or daemon discovery.
            // Embedded uses the same native state store on this controller.
            const response = await native.json(['--embedded', 'sandbox', 'create', '--on=local', `--runtime=${launch.runtimeId}`,
                `--name=${name}`, `--cpu=${launch.size.cpu}`, `--memory=${launch.size.memoryBytes / 1024 ** 2}MB`,
                '--keep-on-failure', launch.imageId], signal);
            if (response.kind !== 'success') return { kind: 'unknown' as const, recovery };
            const parsed = CuaNativeSandboxSchema.safeParse(response.value);
            if (!parsed.success || parsed.data.id !== resource.sandboxId || parsed.data.runtime !== resource.runtimeId
                || parsed.data.name !== name || parsed.data.image !== launch.imageId || parsed.data.ephemeral) {
                return { kind: 'unknown' as const, recovery };
            }
            return { kind: 'bound' as const, resource };
        },
        inspect,
        async power(input: unknown, intent: 'start' | 'stop' | 'suspend' | 'resume', signal?: AbortSignal) {
            const resource = parseCuaLocalResource(input);
            // Sandbox CLI has suspend/resume but no disk-preserving Stop.
            if (intent === 'stop') return { kind: 'unsupported' as const, intent, resource };
            const before = await inspect(resource, signal);
            if (before.existence !== 'present') return { kind: 'unavailable' as const,
                reason: before.existence === 'absent' ? 'native_resource_absent' as const : 'native_resource_unknown' as const, resource };
            const response = await native.effect(['--embedded', 'sandbox', intent === 'start' ? 'resume' : intent, resource.sandboxId], signal);
            if (response.kind !== 'success') return { kind: 'unknown' as const, resource };
            return { kind: 'observed' as const, ...await inspect(resource, signal) };
        },
        async destroy(input: unknown, signal?: AbortSignal) {
            const resource = parseCuaLocalResource(input);
            const before = await inspect(resource, signal);
            if (before.existence === 'unknown') return { kind: 'unknown' as const, existence: 'unknown' as const, resource };
            if (before.existence === 'absent') return { kind: 'deleted' as const, existence: 'absent' as const, resource };
            // Immutable native basis 2bce4442: sandbox-core/sandbox.rs
            // 2349–2382,3373–3379 awaits local runtime deletion (or typed native
            // NotFound) before deleting its record. CLI rm serializes this only
            // after awaiting delete. Subsequent record NotFound is not proof.
            const response = await native.json(['--embedded', 'sandbox', 'rm', resource.sandboxId, '--force'], signal);
            const parsed = response.kind === 'success' ? CuaNativeDeleteSchema.safeParse(response.value) : undefined;
            return parsed?.success && parsed.data.deleted === resource.sandboxId
                ? { kind: 'deleted' as const, existence: 'absent' as const, resource }
                : { kind: 'unknown' as const, existence: 'unknown' as const, resource };
        },
    };
}
