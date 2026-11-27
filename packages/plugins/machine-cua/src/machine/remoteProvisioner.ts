import { projectMachineProvisionerActionFailure, type MachineProvisionerNativeCauseV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { Buffer } from 'node:buffer';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createCuaByoc } from './byoc.js';
import { remoteNative } from './remoteConnection.js';
import { ByocProvisionerSchemas, ByocReconciliationSchemas, byocReconciliationOperation } from './remoteProvisionerSchemas.js';
import { ByocOptionsQueryV1Schema, type ByocResourceV1 } from './remoteSchemas.js';
import { CUA_UNSUPPORTED_INTENT, cuaPowerAfter } from './nativePower.js';
import { CuaLocalNameSchema } from './schemas.js';

const id = 'byoc';
export type CuaRemoteRole = 'check' | 'options' | 'acquire' | 'reconcile' | 'bootstrap' | 'inspect' | 'power' | 'destroy' | 'exec' | 'putFile';
function reference<T>(value: T) {
    return { contributionRef: { pluginId: 'happier.machine.cua', localId: id }, schemaVersion: 1, value };
}
function pending<T>(operation: T, nativeCause?: MachineProvisionerNativeCauseV1) { return { kind: 'pending' as const, nativeOperationRef: reference(operation),
    ...(nativeCause ? { nativeCause } : {}) }; }
function bytes(encoded: string) {
    return Buffer.from(encoded, 'base64');
}

// Invoked only after host admission. Account bindings, row custody, budgets and
// scheduling stay host-owned; native leaves own exact resource operations.
export async function invokeCuaRemoteRole(role: CuaRemoteRole, input: unknown, context: PluginInvocationContext): Promise<unknown> {
    const schemas = ByocProvisionerSchemas;
    const native = await remoteNative(context);
    const byoc = createCuaByoc(native);
    const signal = context.signal, now = context.invokedAtMs;
    async function runningGuestTarget(resource: ByocResourceV1): Promise<string> {
        const observed = await byoc.inspect(resource, signal);
        if (observed.existence !== 'present' || observed.power !== 'running') throw new Error('cua_guest_unavailable');
        return resource.sandboxId;
    }
    if (role === 'check') {
        // Reads the native cloud status: an account with no connected cloud is the typed "connect one" state.
        const connected = await byoc.hasConnectedCloud(signal);
        if (connected === undefined) throw new Error('cua_connection_unavailable');
        if (!connected) throw Object.assign(new Error('cua_cloud_not_connected'), { code: 'credential_unavailable' });
        return { available: true };
    }
    if (role === 'options') return byoc.options(ByocOptionsQueryV1Schema.parse(input).cloud, now, signal);
    if (role === 'acquire') {
        const request = schemas.acquireInput.parse(input);
        if (!request.managedId) return { kind: 'rejected', code: 'invalid_request' };
        const name = `happier-${request.managedId}`;
        if (!CuaLocalNameSchema.safeParse(name).success) return { kind: 'rejected', code: 'invalid_request' };
        const { launch } = request;
        const operation = { launch, sandboxId: `${launch.cloud}:${name}` };
        try {
            const result = await byoc.create(launch, name, signal);
            if (result.kind === 'bound') return { kind: 'bound', resource: { ...reference(result.resource), origin: 'created' as const } };
            if (result.kind === 'unavailable') return { kind: 'rejected', code: 'provider_unavailable' };
            return pending(operation, result.nativeCause);
        } catch (error) { projectMachineProvisionerActionFailure(error, () => {}); /* Submission may have allocated. Lookup, never repurchase. */ }
        return pending(operation);
    }
    if (role === 'reconcile') {
        const operation = byocReconciliationOperation(input);
        try {
            const result = await byoc.recover(operation.launch, operation.sandboxId, signal);
            if (result.kind === 'bound') return { kind: 'bound', resource: { ...reference(result.resource), origin: 'created' as const } };
        } catch (error) { projectMachineProvisionerActionFailure(error, () => {}); /* Reads cannot release custody or establish no-effect failure. */ }
        return pending(operation);
    }
    if (role === 'destroy') {
        const request = ByocReconciliationSchemas.destroyInput.parse(input);
        let resource: ByocResourceV1;
        if ('resource' in request) {
            resource = request.resource;
        } else {
            const recovered = await byoc.recover(request.nativeOperation.launch, request.nativeOperation.sandboxId, signal);
            if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'cua_cleanup_incomplete' };
            resource = recovered.resource;
        }
        const result = await byoc.destroy(resource, signal);
        return result.kind === 'deleted' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_cleanup_incomplete' };
    }
    if (role === 'inspect') return byoc.observe(schemas.resourceInput.parse(input).resource, now, signal);
    if (role === 'power') {
        const { resource, intent } = schemas.powerInput.parse(input);
        if (intent !== 'start' && intent !== 'stop') return { kind: 'refused', code: CUA_UNSUPPORTED_INTENT };
        const result = await byoc.power(resource, intent, signal);
        if (result.kind === 'unsupported') return { kind: 'refused', code: CUA_UNSUPPORTED_INTENT };
        return result.kind === 'observed' && result.existence === 'present' && result.power === cuaPowerAfter(intent, 'cloud')
            ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_native_power_pending' };
    }
    if (role === 'bootstrap') {
        const { resource } = schemas.bootstrapInput.parse(input);
        await runningGuestTarget(resource);
        return { kind: 'native', transport: { contributionRef: reference(resource).contributionRef, schemaVersion: 1 } };
    }
    if (role === 'putFile') {
        const request = schemas.putFileInput.parse(input);
        const target = await runningGuestTarget(request.resource);
        return native.putGuestFile(target, request.guestPath, bytes(request.bytesBase64), request.mode, signal);
    }
    const request = schemas.execInput.parse(input);
    const target = await runningGuestTarget(request.resource);
    const result = await native.execGuest(target, request.argv, request.inputBase64 === undefined ? undefined : bytes(request.inputBase64), signal, request.timeoutMs);
    return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: Buffer.from(result.stderr).toString('base64'),
        stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
}
