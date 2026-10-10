import type { CuaNativeClient } from './nativeClient.js';
import { MachineProvisionerObservationV1Schema, MachineProvisionerOptionsResultV1Schema,
    type MachineProvisionerObservationV1, type MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as z from 'zod/mini';
import { CuaLocalNameSchema } from './schemas.js';
import { ByocLaunchV1Schema, ByocResourceV1Schema, NativeCloudProviderSchema, NativeCloudResourceSchema, type ByocResourceV1 } from './remoteSchemas.js';

export function qualifyByocLaunch(input: unknown, provider: unknown) {
    const launch = ByocLaunchV1Schema.parse(input);
    const parsed = NativeCloudProviderSchema.safeParse(provider);
    if (!parsed.success) return { kind: 'unavailable' as const, reason: 'native_route_unqualified' };
    const native = parsed.data;
    const ttlSeconds = launch.nativeLifetime.kind === 'finite' ? launch.nativeLifetime.durationSeconds : 0;
    // The public native create has no BYOC TTL override. Qualification is read
    // only: a mismatched connection must be configured through native setup.
    const size = native.kinds.find((kind) => kind.supported && kind.image === launch.nativeImageId
        && kind.machine_type === launch.nativeSizeId);
    if (!native.connected || native.name !== launch.cloud || native.region !== launch.region
        || native.ttl_hours * 3600 !== ttlSeconds || !size) {
        return { kind: 'unavailable' as const, reason: 'native_route_unqualified' };
    }
    return { kind: 'qualified' as const, on: launch.cloud, ttlSeconds,
        price: { amount: String(size.usd_per_hour), currency: 'USD' as const, unit: 'hour' as const } };
}

export function decodeCreatedByocResource(input: unknown, sandboxId: string, resources: unknown) {
    const launch = ByocLaunchV1Schema.parse(input);
    if (!sandboxId.startsWith(`${launch.cloud}:`) || !sandboxId.slice(launch.cloud.length + 1)
        || !Array.isArray(resources)) return { kind: 'unknown' as const };
    const parsed = resources.map((row: unknown) => NativeCloudResourceSchema.safeParse(row));
    if (parsed.some((row) => !row.success)) return { kind: 'unknown' as const };
    const rows = parsed.flatMap((row) => row.success ? [row.data] : []);
    const owned = rows.filter((row) => row.provider === launch.cloud && row.sandbox === sandboxId
        && row.region === launch.region);
    const primaryType = launch.cloud === 'modal' ? 'sandbox' : 'instance';
    const primary = owned.filter((row) => row.type === primaryType && row.state !== 'pending');
    const [main] = primary;
    if (primary.length !== 1 || !main) return { kind: 'unknown' as const };
    // Cloud status substitutes a provisional name for the missing native id
    // while pending. Shared resources have an empty sandbox and are excluded.
    const resource = ByocResourceV1Schema.parse({ cloud: launch.cloud, nativeResourceId: main.id, sandboxId,
        ...(main.machine && { spaceId: `relay:${main.machine}` }),
        ownedAttachmentIds: [...new Set(owned.filter((row) => row.type !== primaryType
            && row.state !== 'pending').map((row) => row.id))] });
    return { kind: 'bound' as const, resource };
}

export function inspectByocLedger(resource: unknown, rows: unknown) {
    const ref = ByocResourceV1Schema.parse(resource);
    if (Array.isArray(rows)) {
        const exact = rows.flatMap((row: unknown) => {
            const parsed = NativeCloudResourceSchema.safeParse(row);
            return parsed.success && parsed.data.provider === ref.cloud && parsed.data.id === ref.nativeResourceId
                && parsed.data.sandbox === ref.sandboxId ? [parsed.data] : [];
        });
        const [main] = exact;
        if (exact.length === 1 && main) return { existence: 'unknown' as const, power: 'unknown' as const,
            recordedPower: main.state };
    }
    // This is the controller's local ledger, not an authenticated cloud lookup.
    return { existence: 'unknown' as const, power: 'unknown' as const };
}

export function byocCleanupTarget(resource: unknown) {
    return ByocResourceV1Schema.parse(resource).sandboxId;
}

const cloudStatusSchema = z.object({ providers: z.array(NativeCloudProviderSchema), resources: z.array(NativeCloudResourceSchema) });
const sandboxInfoSchema = z.object({ id: z.string(), name: z.string(), location: z.string(),
    state: z.string(), status: z.string(), image: z.nullable(z.string()), ephemeral: z.boolean(),
    expires_at: z.nullable(z.iso.datetime({ offset: true })),
    provider_details: z.object({ provider: z.enum(['aws', 'gcp', 'modal']), id: z.string().check(z.minLength(1)) }) });
const deleteSchema = z.object({ deleted: z.string(), missing: z.boolean() });
const imageCatalogEntrySchema = z.object({ ref: z.string().check(z.minLength(1)), published: z.boolean() });
const registrySchema = z.object({ spaces: z.array(z.object({ id: z.string(), provider: z.string() })) });

/** Remote operations on C53's single native boundary. No enrollment or policy. */
export function createCuaByoc(native: CuaNativeClient) {
    async function status(cloud: ByocResourceV1['cloud'], signal?: AbortSignal) {
        const result = await native.json(['--embedded', 'cloud', 'status', cloud], signal);
        return result.kind === 'success' ? cloudStatusSchema.safeParse(result.value) : undefined;
    }
    async function exactLedger(resource: ByocResourceV1, signal?: AbortSignal) {
        const result = await status(resource.cloud, signal);
        if (!result?.success) return undefined;
        const rows = result.data.resources.filter(row => row.provider === resource.cloud && row.sandbox === resource.sandboxId);
        const primaryType = resource.cloud === 'modal' ? 'sandbox' : 'instance';
        const primary = rows.filter(row => row.type === primaryType);
        if (primary.length !== 1 || primary[0].id !== resource.nativeResourceId || primary[0].state === 'pending'
            || (resource.spaceId !== undefined && `relay:${primary[0].machine}` !== resource.spaceId)) return undefined;
        const attachments = rows.filter(row => row.type !== primaryType).map(row => row.id);
        if (attachments.length !== resource.ownedAttachmentIds.length
            || resource.ownedAttachmentIds.some(id => !attachments.includes(id))) return undefined;
        return primary[0];
    }
    async function exactSandbox(resource: ByocResourceV1, signal?: AbortSignal) {
        const result = await native.json(['--embedded', 'sandbox', 'info', resource.sandboxId], signal);
        const parsed = result.kind === 'success' ? sandboxInfoSchema.safeParse(result.value) : undefined;
        if (!parsed?.success || parsed.data.id !== resource.sandboxId || parsed.data.location !== resource.cloud
            || `${resource.cloud}:${parsed.data.name}` !== resource.sandboxId || parsed.data.ephemeral
            || parsed.data.provider_details.provider !== resource.cloud
            || parsed.data.provider_details.id !== resource.nativeResourceId) return undefined;
        return parsed.data;
    }
    async function inspect(input: unknown, signal?: AbortSignal) {
        const resource = ByocResourceV1Schema.parse(input);
        const unknown = { resource, existence: 'unknown' as const, power: 'unknown' as const };
        if (!await exactLedger(resource, signal)) return unknown;
        const facts = await exactSandbox(resource, signal);
        if (!facts) return unknown;
        // Native get performs vendor describe. Its `gone` result is materially
        // different from missing controller state or a failed authorization.
        if (facts.state === 'gone' || facts.state === 'terminated') {
            return { resource, existence: 'absent' as const, power: 'unknown' as const };
        }
        // BYOC VM stop is exposed by the native sandbox layer as Suspended;
        // this route retains disk, not a local sandbox's RAM suspension promise.
        const power = facts.state === 'suspended' && resource.cloud !== 'modal' ? 'stopped'
            : facts.state === 'running' || facts.state === 'stopped' ? facts.state : 'unknown';
        return { resource, existence: 'present' as const, power,
            ...(facts.expires_at !== null && { nativeExpiryAt: Date.parse(facts.expires_at) }) };
    }
    return {
        async options(cloud: ByocResourceV1['cloud'], observedAt: number, signal?: AbortSignal): Promise<MachineProvisionerOptionsResultV1> {
            MachineProvisionerObservationV1Schema.parse({ observedAt, availability: 'unavailable' });
            const current = await status(cloud, signal);
            if (!current?.success) throw Object.assign(new Error('Native options are unavailable'), { code: 'native_options_unavailable' });
            const providers = current.data.providers.filter(provider => provider.name === cloud && provider.connected);
            if (providers.length !== 1) return { choices: [] };
            const provider = providers[0];
            const choices = provider.kinds.flatMap(kind => {
                const launch = ByocLaunchV1Schema.safeParse({ cloud, region: provider.region,
                    nativeImageId: kind.image, nativeSizeId: kind.machine_type,
                    nativeLifetime: provider.ttl_hours === 0 ? { kind: 'no-native-ttl' }
                        : { kind: 'finite', durationSeconds: provider.ttl_hours * 3600 } });
                if (!launch.success || qualifyByocLaunch(launch.data, provider).kind !== 'qualified') return [];
                const lifetime = launch.data.nativeLifetime;
                const retention: NonNullable<MachineProvisionerOptionsResultV1['choices'][number]['retention']> = {
                    supportedIntents: cloud === 'modal' ? ['delete'] : ['start', 'stop', 'delete'],
                    finiteOnly: lifetime.kind === 'finite',
                };
                const choice = { id: `${kind.image}:${kind.machine_type}`,
                    title: { key: 'machineCua.byoc.nativeChoice', fallback: `${kind.image} · ${kind.machine_type}` },
                    launch: launch.data, available: true, retention, nativeFacts: {
                        size: { id: kind.machine_type, title: kind.machine_type }, image: { id: kind.image, title: kind.image },
                        location: { id: provider.region, title: provider.region },
                        ...(lifetime.kind === 'finite' ? { duration: { id: String(lifetime.durationSeconds),
                            title: `${lifetime.durationSeconds} s`, afterMs: lifetime.durationSeconds * 1000 } } : {}),
                    } };
                const priced = MachineProvisionerOptionsResultV1Schema.safeParse({ choices: [{ ...choice, prices: [{
                    amount: String(kind.usd_per_hour), currency: 'USD', unit: 'hour',
                    source: 'cua-native-cloud-status', observedAt,
                }] }] });
                // An unrepresentable native price remains unknown. It does not
                // invalidate an otherwise qualified native choice or become zero.
                return priced.success ? priced.data.choices : [choice];
            });
            return MachineProvisionerOptionsResultV1Schema.parse({ choices });
        },
        async observe(input: unknown, observedAt: number, signal?: AbortSignal): Promise<MachineProvisionerObservationV1> {
            MachineProvisionerObservationV1Schema.parse({ observedAt, availability: 'unavailable' });
            const current = await inspect(input, signal);
            if (current.existence === 'unknown') return { observedAt, availability: 'unavailable',
                power: 'unknown', reason: 'native_resource_unknown' };
            if (current.existence === 'absent') return { observedAt, availability: 'absent', power: 'unknown' };
            return MachineProvisionerObservationV1Schema.parse({ observedAt, availability: 'present', power: current.power,
                billing: { location: 'cloud', stoppedBilling: current.resource.cloud === 'modal' ? 'unknown' : 'not-billed' },
                ...(current.nativeExpiryAt !== undefined && { nativeExpiry: current.nativeExpiryAt }),
            });
        },
        async recover(input: unknown, sandboxId: string, signal?: AbortSignal) {
            const launch = ByocLaunchV1Schema.parse(input);
            const name = sandboxId.slice(launch.cloud.length + 1);
            if (sandboxId !== `${launch.cloud}:${CuaLocalNameSchema.parse(name)}`) throw new Error('cua_resource_mismatch');
            const current = await status(launch.cloud, signal);
            const decoded = current?.success ? decodeCreatedByocResource(launch, sandboxId, current.data.resources) : undefined;
            if (decoded?.kind === 'bound') {
                const observed = await exactSandbox(decoded.resource, signal);
                if (observed && observed.image === launch.nativeImageId) return decoded;
                if (observed?.image) {
                    // Native CLI aliases are resolved before contrib persistence.
                    // Catalog info owns that mapping; no local alias table or
                    // guessed family/prefix matching may qualify a different image.
                    const result = await native.json(['images', 'info', launch.nativeImageId], signal);
                    const image = result.kind === 'success' ? imageCatalogEntrySchema.safeParse(result.value) : undefined;
                    if (image?.success && image.data.published && image.data.ref === observed.image) return decoded;
                }
            }
            return { kind: 'unknown' as const };
        },
        async create(input: unknown, nameInput: string, signal?: AbortSignal) {
            const launch = ByocLaunchV1Schema.parse(input);
            const name = CuaLocalNameSchema.parse(nameInput);
            const recovery = { cloud: launch.cloud, sandboxId: `${launch.cloud}:${name}` };
            const current = await status(launch.cloud, signal);
            if (!current?.success) return { kind: 'unavailable' as const, reason: 'native_route_unqualified' as const };
            const provider = current.data.providers.filter(provider => provider.name === launch.cloud);
            const qualification = qualifyByocLaunch(launch, provider.length === 1 ? provider[0] : undefined);
            if (qualification.kind !== 'qualified') return qualification;
            if (current.data.resources.some(row => row.provider === launch.cloud && row.sandbox === recovery.sandboxId)) {
                return { kind: 'unavailable' as const, reason: 'native_name_exists' as const };
            }
            // Region, instance size and native lifetime are checked above, not
            // invented command flags or rewrites of global cloud connection.
            await native.json(['--embedded', 'sandbox', 'create', launch.nativeImageId, `--on=${launch.cloud}`,
                `--name=${name}`, '--keep-on-failure'], signal);
            const recorded = await status(launch.cloud, signal);
            const bound = recorded?.success ? decodeCreatedByocResource(launch, recovery.sandboxId, recorded.data.resources) : undefined;
            return bound?.kind === 'bound' ? bound : { kind: 'unknown' as const, recovery };
        },
        inspect,
        async power(input: unknown, intent: 'start' | 'stop', signal?: AbortSignal) {
            const resource = ByocResourceV1Schema.parse(input);
            if (resource.cloud === 'modal') return { kind: 'unsupported' as const, intent, resource };
            const before = await inspect(resource, signal);
            if (before.existence !== 'present') return { kind: 'unavailable' as const, resource,
                reason: before.existence === 'absent' ? 'native_resource_absent' as const : 'native_resource_unknown' as const };
            // The BYOC VM provider maps native suspend/resume to disk-retaining
            // stop/start. Modal never receives these VM-only operations.
            const response = await native.effect(['--embedded', 'sandbox', intent === 'stop' ? 'suspend' : 'resume', resource.sandboxId], signal);
            return response.kind === 'success' ? { kind: 'observed' as const, ...await inspect(resource, signal) }
                : { kind: 'unknown' as const, resource };
        },
        async destroy(input: unknown, signal?: AbortSignal) {
            const resource = ByocResourceV1Schema.parse(input);
            // CD9: sandbox rm cannot reach provider.delete(vendorId) once
            // sandbox state is gone. Retain unconfirmed custody for the existing
            // cloud-console/manual-retire path; missing local records are not
            // native absence, and a global sweep would touch unrelated resources.
            if (!await exactLedger(resource, signal) || !await exactSandbox(resource, signal)) return { kind: 'incomplete' as const, resource,
                native: 'unknown' as const, registry: 'unknown' as const, attachments: 'unknown' as const };
            const response = await native.json(['--embedded', 'sandbox', 'rm', resource.sandboxId, '--force'], signal);
            const deleted = response.kind === 'success' ? deleteSchema.safeParse(response.value) : undefined;
            // Awaited exact native delete proves the primary. Ledger disappearance
            // alone proves neither deletion nor cleanup of separate attachments.
            const primary = deleted?.success && deleted.data.deleted === resource.sandboxId ? 'absent' as const : 'unknown' as const;
            let registry: 'removed' | 'present' | 'unknown' = resource.spaceId ? 'unknown' : 'removed';
            if (resource.spaceId) {
                async function readRegistry() {
                    const response = await native.json(['--embedded', 'spaces', 'ls'], signal);
                    const parsed = response.kind === 'success' ? registrySchema.safeParse(response.value) : undefined;
                    if (!parsed?.success) return 'unknown' as const;
                    return parsed.data.spaces.some(row => row.id === resource.spaceId) ? 'present' as const : 'removed' as const;
                }
                registry = await readRegistry();
                if (registry === 'present') {
                    await native.json(['--embedded', 'spaces', 'rm', resource.spaceId], signal);
                    registry = await readRegistry();
                }
            }
            const attachments = resource.ownedAttachmentIds.length === 0 ? 'absent' as const : 'unknown' as const;
            return { kind: primary === 'absent' && registry === 'removed' && attachments === 'absent' ? 'deleted' as const : 'incomplete' as const,
                resource, native: primary, registry, attachments };
        },
    };
}
