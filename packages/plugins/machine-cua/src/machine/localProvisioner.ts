import type { MachineProvisionerAcquireResultV1, MachineProvisionerObservationV1, MachineProvisionerOptionsResultV1,
    MachineProvisionerPowerResultV1, MachineProvisionerNativeIntentV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createCuaLocalSandbox } from './localSandbox.js';
import { createCuaLocalSpace } from './localSpace.js';
import { createCuaNativeFacts } from './nativeFacts.js';
import { CuaLocalNativeOperationV1Schema, localAcquireOperation, prepareCuaLocalStoredSchemas } from './localProvisionerSchemas.js';
import { CuaLocalLaunchV1Schema, CuaLocalOptionsQueryV1Schema, CuaLocalNameSchema, parseCuaLocalResource,
    type CuaLocalResourceV1 } from './schemas.js';
import type { CuaNativeClient } from './nativeClient.js';

export const CUA_PLUGIN_ID = 'happier.machine.cua';
export const CUA_DEPENDENCY_ID = 'cua-cli';
export type CuaLocalProvisionerId = 'local-sandbox' | 'local-space';
const billing = { location: 'local', stoppedBilling: 'not-billed' } as const;

export function createCuaLocalProvisioner(native: CuaNativeClient, localId: CuaLocalProvisionerId, observedAt: number, signal?: AbortSignal) {
    const contributionRef = { pluginId: CUA_PLUGIN_ID, localId };
    const sandbox = createCuaLocalSandbox(native);
    const space = createCuaLocalSpace(native);
    const leaf = localId === 'local-space' ? space : sandbox;
    const facts = createCuaNativeFacts(native);
    function reference<T>(value: T) { return { contributionRef, schemaVersion: 1, value }; }
    function pending(value: ReturnType<typeof CuaLocalNativeOperationV1Schema.parse>) {
        return { kind: 'pending' as const, nativeOperationRef: reference(value) };
    }
    function resource(input: unknown) {
        const value = parseCuaLocalResource(input);
        if (value.kind !== (localId === 'local-space' ? 'space' : 'sandbox')) throw new Error('cua_resource_mismatch');
        return value;
    }
    async function running(input: unknown) {
        const value = resource(input);
        const observation = await leaf.inspect(value, signal);
        if (observation.existence !== 'present' || observation.power !== 'running') throw new Error('cua_guest_unavailable');
        return value;
    }
    async function inspect(input: unknown): Promise<MachineProvisionerObservationV1> {
        const value = resource(input);
        const observed = await leaf.inspect(value, signal);
        return { observedAt, availability: observed.existence === 'unknown' ? 'unavailable' : observed.existence,
            ...(observed.existence === 'present' ? { power: observed.power } : {}), billing,
            ...(observed.existence === 'unknown' ? { reason: 'cua_native_resource_unknown' } : {}) };
    }
    return {
        check: () => facts.check(signal),
        async options(input: unknown): Promise<MachineProvisionerOptionsResultV1> {
            const selectors = CuaLocalOptionsQueryV1Schema.parse(input);
            return facts.options(signal, selectors, localId);
        },
        async reconcile(input: unknown) {
            const operation = CuaLocalNativeOperationV1Schema.parse(input);
            const value = resource(operation.resource);
            try {
                const observed = await leaf.inspect(value, signal);
                if (observed.existence === 'present' && observed.imageId === operation.imageId
                    && (!('registry' in observed) || observed.registry === 'present')) {
                    return { kind: 'bound' as const, resource: reference(value) };
                }
            } catch { /* A canceled or unavailable read cannot prove absence. */ }
            return pending(operation);
        },
        async acquire(input: unknown, managedId?: string): Promise<MachineProvisionerAcquireResultV1<CuaLocalResourceV1, ReturnType<typeof CuaLocalNativeOperationV1Schema.parse>>> {
            if (!managedId) return { kind: 'rejected', code: 'invalid_request' };
            const name = `happier-${managedId}`;
            if (!CuaLocalNameSchema.safeParse(name).success) return { kind: 'rejected', code: 'invalid_request' };
            const parsed = CuaLocalLaunchV1Schema.safeParse(input);
            if (!parsed.success) return { kind: 'rejected', code: 'invalid_request' };
            const launch = parsed.data;
            const choices = await this.options({ runtimeId: launch.runtimeId, imageId: launch.imageId, size: launch.size });
            if (!choices.choices.some((choice) => choice.available && choice.launch)) return { kind: 'rejected', code: 'invalid_request' };
            const recovery = localAcquireOperation(localId, launch, managedId);
            try {
                const created = await leaf.create(launch, name, launch.size.diskBytes, signal);
                if (created.kind === 'bound') return { kind: 'bound', resource: reference(created.resource) };
                if (created.kind === 'unavailable') return { kind: 'rejected', code: 'invalid_request' };
            } catch { /* Native creation may already exist; retain exact lookup custody. */ }
            return pending(recovery);
        },
        async bootstrap(input: unknown) {
            await running(input);
            return { kind: 'native' as const, transport: { contributionRef, schemaVersion: 1 } };
        },
        inspect,
        async inspectStored(input: unknown) {
            const stored = await prepareCuaLocalStoredSchemas();
            return inspect(stored.resourceStored.parse(input));
        },
        async power(input: unknown, intent: MachineProvisionerNativeIntentV1): Promise<MachineProvisionerPowerResultV1> {
            const value = resource(input);
            if (intent === 'stop') return { kind: 'refused', code: 'cua_stop_unsupported' };
            if (intent !== 'start' && intent !== 'suspend' && intent !== 'resume') return { kind: 'refused', code: 'cua_unsupported_intent' };
            const result = await leaf.power(value, intent, signal);
            return result.kind === 'observed' && result.existence === 'present'
                && result.power === (intent === 'suspend' ? 'suspended' : 'running') ? { kind: 'confirmed' } : { kind: 'unknown' };
        },
        async destroy(input: unknown): Promise<MachineProvisionerPowerResultV1> {
            const result = await leaf.destroy(resource(input), signal);
            return result.kind === 'deleted' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_cleanup_incomplete' };
        },
        async exec(input: unknown, argv: readonly string[], inputBytes?: Uint8Array, timeoutMs?: number | null) {
            const value = await running(input);
            return native.execGuest(value.sandboxId, argv, inputBytes, signal, timeoutMs);
        },
        async putFile(input: unknown, guestPath: string, bytes: Uint8Array, mode?: number) {
            const value = await running(input);
            return native.putGuestFile(value.sandboxId, guestPath, bytes, mode, signal);
        },
    };
}
