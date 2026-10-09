import { Buffer } from 'node:buffer';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createCuaByoc } from './byoc.js';
import { createCuaFleet } from './fleet.js';
import { remoteNative } from './remoteConnection.js';
import { ByocProvisionerSchemas, ByocReconciliationSchemas, FleetProvisionerSchemas, FleetReconciliationSchemas,
    byocReconciliationOperation, fleetReconciliationOperation } from './remoteProvisionerSchemas.js';
import { ByocOptionsQueryV1Schema, FleetOptionsQueryV1Schema } from './remoteSchemas.js';
import { CuaLocalNameSchema } from './schemas.js';

type RemoteId = 'byoc' | 'fleet';
export type CuaRemoteRole = 'check' | 'options' | 'acquire' | 'reconcile' | 'bootstrap' | 'inspect' | 'power' | 'destroy' | 'exec' | 'putFile';
function reference<T>(id: RemoteId, value: T) {
    return { contributionRef: { pluginId: 'happier.machine.cua', localId: id }, schemaVersion: 1, value };
}
function pending<T>(id: RemoteId, operation: T) { return { kind: 'pending' as const, nativeOperationRef: reference(id, operation) }; }
function bytes(encoded: string) {
    const value = Buffer.from(encoded, 'base64');
    if (value.toString('base64') !== encoded) throw new Error('cua_invalid_private_input');
    return value;
}
async function withToken<T>(context: PluginInvocationContext, effect: (token: string) => Promise<T>) {
    const lease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' });
    try {
        if (lease.kind !== 'bytes') throw new Error('cua_private_token_unavailable');
        const token = new TextDecoder('utf-8', { fatal: true }).decode(lease.bytes);
        if (!token || /\s/u.test(token)) throw new Error('cua_private_token_unavailable');
        return await effect(token);
    } finally { await lease.dispose(); }
}

// Invoked only after host admission. Account bindings, row custody, budgets and
// scheduling stay host-owned; native leaves own exact resource operations.
export async function invokeCuaRemoteRole(id: RemoteId, role: CuaRemoteRole, input: unknown, context: PluginInvocationContext): Promise<unknown> {
    if (id === 'fleet' && ['acquire', 'bootstrap', 'exec', 'putFile'].includes(role)) {
        return withToken(context, token => invoke(id, role, input, context, token));
    }
    return invoke(id, role, input, context);
}
async function invoke(id: RemoteId, role: CuaRemoteRole, input: unknown, context: PluginInvocationContext, token?: string): Promise<unknown> {
    const schemas = id === 'byoc' ? ByocProvisionerSchemas : FleetProvisionerSchemas;
    const reconciliation = id === 'byoc' ? ByocReconciliationSchemas : FleetReconciliationSchemas;
    const native = await remoteNative(context, id, token);
    const byoc = createCuaByoc(native), fleet = createCuaFleet(native);
    const signal = context.signal, now = context.invokedAtMs;
    if (role === 'check') return { available: true };
    if (role === 'options') return id === 'byoc'
        ? byoc.options(ByocOptionsQueryV1Schema.parse(input).cloud, now, signal)
        : fleet.options(FleetOptionsQueryV1Schema.parse(input), signal);
    if (role === 'acquire') {
        const request = schemas.acquireInput.parse(input);
        if (!request.managedId) return { kind: 'rejected', code: 'invalid_request' };
        const name = `happier-${request.managedId}`;
        if (!CuaLocalNameSchema.safeParse(name).success) return { kind: 'rejected', code: 'invalid_request' };
        if (id === 'byoc') {
            const launch = ByocProvisionerSchemas.acquireInput.parse(input).launch;
            const operation = { launch, sandboxId: `${launch.cloud}:${name}` };
            try {
                const result = await byoc.create(launch, name, signal);
                if (result.kind === 'bound') return { kind: 'bound', resource: reference(id, result.resource) };
                if (result.kind === 'unavailable') return { kind: 'rejected', code: 'provider_unavailable' };
            } catch { /* Submission may have allocated. Lookup, never repurchase. */ }
            return pending(id, operation);
        }
        const launch = FleetProvisionerSchemas.acquireInput.parse(input).launch;
        const operation = { namespace: launch.namespace, claimId: name };
        try {
            const result = await fleet.create(launch, name, now, signal, token);
            if (result.kind === 'bound') return { kind: 'bound', resource: reference(id, result.resource) };
            if (result.kind === 'unavailable') return { kind: 'rejected', code: 'invalid_request' };
        } catch { /* Retain custody of the exact claim and private native Secret. */ }
        return pending(id, operation);
    }
    if (role === 'reconcile') {
        const operation = id === 'byoc' ? byocReconciliationOperation(input) : fleetReconciliationOperation(input);
        try {
            const result = id === 'byoc' ? await (async () => {
                const operation = byocReconciliationOperation(input);
                return byoc.recover(operation.launch, operation.sandboxId, signal);
            })() : await fleet.attach(fleetReconciliationOperation(input), now, signal);
            if (result.kind === 'bound') return { kind: 'bound', resource: reference(id, result.resource) };
        } catch { /* Reads cannot release custody or establish no-effect failure. */ }
        return pending(id, operation);
    }
    if (role === 'destroy') {
        const request = reconciliation.destroyInput.parse(input);
        if (!('resource' in request)) {
            if (id === 'fleet') {
                const operation = FleetReconciliationSchemas.destroyInput.parse(input);
                if ('resource' in operation) throw new Error('cua_resource_mismatch');
                const result = await fleet.release(operation.nativeOperation, now, signal, true);
                return result.kind === 'released' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_cleanup_incomplete' };
            }
            const operation = ByocReconciliationSchemas.destroyInput.parse(input);
            if ('resource' in operation) throw new Error('cua_resource_mismatch');
            const recovered = await byoc.recover(operation.nativeOperation.launch, operation.nativeOperation.sandboxId, signal);
            if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'cua_cleanup_incomplete' };
            const result = await byoc.destroy(recovered.resource, signal);
            return result.kind === 'deleted' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_cleanup_incomplete' };
        }
    }
    const resource = (role === 'exec' ? schemas.execInput.parse(input) : role === 'putFile' ? schemas.putFileInput.parse(input)
        : role === 'bootstrap' ? schemas.bootstrapInput.parse(input) : role === 'power' ? schemas.powerInput.parse(input)
        : schemas.resourceInput.parse(input)).resource;
    if (role === 'inspect') return id === 'byoc' ? byoc.observe(resource, now, signal) : fleet.observe(resource, now, signal);
    if (role === 'destroy') {
        const result = id === 'byoc' ? await byoc.destroy(resource, signal) : await fleet.release(resource, now, signal, true);
        return result.kind === 'deleted' || result.kind === 'released' ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_cleanup_incomplete' };
    }
    if (role === 'power') {
        const request = schemas.powerInput.parse(input);
        if (id !== 'byoc' || (request.intent !== 'start' && request.intent !== 'stop')) return { kind: 'refused', code: 'cua_unsupported_intent' };
        const result = await byoc.power(resource, request.intent, signal);
        if (result.kind === 'unsupported') return { kind: 'refused', code: 'cua_unsupported_intent' };
        return result.kind === 'observed' && result.existence === 'present' && result.power === (request.intent === 'start' ? 'running' : 'stopped')
            ? { kind: 'confirmed' } : { kind: 'unknown', code: 'cua_native_power_pending' };
    }
    const observed = id === 'byoc' ? await byoc.inspect(resource, signal) : await fleet.attach(resource, now, signal);
    if (id === 'byoc' ? observed.existence !== 'present' || observed.power !== 'running' : !('kind' in observed) || observed.kind !== 'bound') {
        throw new Error('cua_guest_unavailable');
    }
    if (role === 'bootstrap') return { kind: 'native', transport: { contributionRef: reference(id, resource).contributionRef, schemaVersion: 1 } };
    const target = id === 'byoc' ? ByocProvisionerSchemas.resourceInput.parse({ resource }).resource.sandboxId
        : (() => { const ref = FleetProvisionerSchemas.resourceInput.parse({ resource }).resource; return `fleet:${ref.namespace}:${ref.claimId}`; })();
    if (role === 'exec') {
        const request = schemas.execInput.parse(input);
        const result = await native.execGuest(target, request.argv, request.inputBase64 === undefined ? undefined : bytes(request.inputBase64), signal, request.timeoutMs);
        return { termination: result.termination, stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: Buffer.from(result.stderr).toString('base64'),
            stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated };
    }
    const request = schemas.putFileInput.parse(input);
    return native.putGuestFile(target, request.guestPath, bytes(request.bytesBase64), request.mode, signal);
}
