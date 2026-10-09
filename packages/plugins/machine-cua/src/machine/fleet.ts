import type { CuaNativeClient } from './nativeClient.js';
import { MachineProvisionerOptionsResultV1Schema, type MachineProvisionerObservationV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { FleetLaunchV1Schema, FleetOptionsQueryV1Schema, FleetNativeIdSchema, FleetResourceV1Schema, NativeFleetClaimRecordSchema,
    NativeFleetClaimSchema, NativeFleetSandboxSchema, NativeFleetPoolSchema, NativeFleetTemplateSchema,
    type FleetResourceV1 } from './remoteSchemas.js';

type FleetClaimObservation =
    | { kind: 'unknown'; resource: FleetResourceV1 }
    | { kind: 'ended' | 'bound' | 'pending'; resource: FleetResourceV1;
        nativeExpiryAt?: number; expirySource?: 'native-creation-ttl' | 'native-shutdown'; resume: 'unsupported' };

export function decodeFleetClaim(record: unknown, expected: unknown, observedAt: number): FleetClaimObservation {
    const ref = FleetResourceV1Schema.parse(expected);
    const unknown = { kind: 'unknown' as const, resource: ref };
    const parsed = NativeFleetClaimRecordSchema.safeParse(record);
    if (!parsed.success || parsed.data.name !== ref.claimId || parsed.data.namespace !== ref.namespace
        || !Number.isFinite(observedAt)) return unknown;
    let raw: unknown;
    try { raw = JSON.parse(parsed.data.json); } catch { return unknown; }
    const result = NativeFleetClaimSchema.safeParse(raw);
    if (!result.success) return unknown;
    const claim = result.data;
    if (claim.metadata.name !== ref.claimId || claim.metadata.namespace !== ref.namespace) return unknown;
    const sandboxId = claim.status?.sandbox?.name;
    if (ref.sandboxId && sandboxId && ref.sandboxId !== sandboxId) return unknown;
    const boundResource = FleetResourceV1Schema.safeParse(sandboxId ? { ...ref, sandboxId } : ref);
    if (!boundResource.success) return unknown;
    const resource = boundResource.data;
    const phase = claim.status?.phase ?? 'Pending';
    if (!['Pending', 'Bound', 'Failed', 'Error', 'Expired'].includes(phase)) return unknown;
    if (phase === 'Bound' && !sandboxId) return unknown;
    const creationExpiry = claim.metadata.creationTimestamp && claim.spec.ttlSecondsAfterCreated !== undefined
        ? Date.parse(claim.metadata.creationTimestamp) + claim.spec.ttlSecondsAfterCreated * 1000 : undefined;
    const shutdownExpiry = !claim.spec.lifecycle?.autoRenew && claim.spec.lifecycle?.shutdownTime
        ? Date.parse(claim.spec.lifecycle.shutdownTime) : undefined;
    const expiry = creationExpiry !== undefined && (shutdownExpiry === undefined || creationExpiry <= shutdownExpiry)
        ? { nativeExpiryAt: creationExpiry, expirySource: 'native-creation-ttl' as const }
        : shutdownExpiry !== undefined ? { nativeExpiryAt: shutdownExpiry, expirySource: 'native-shutdown' as const } : undefined;
    // Expected expiry/deletion is not evidence of native absence. Never renew,
    // replace a claim, or promise same-resource resume from these observations.
    const ended = ['Failed', 'Error', 'Expired'].includes(phase) || claim.metadata.deletionTimestamp !== undefined
        || (expiry !== undefined && observedAt >= expiry.nativeExpiryAt);
    return { kind: ended ? 'ended' as const : phase === 'Bound' ? 'bound' as const : 'pending' as const,
        resource, ...expiry, resume: 'unsupported' as const };
}

export function bindFleetSandbox(expected: unknown, sandbox: unknown) {
    const ref = FleetResourceV1Schema.parse(expected);
    const parsed = NativeFleetSandboxSchema.safeParse(sandbox);
    if (!parsed.success || parsed.data.namespace !== ref.namespace || parsed.data.claim !== ref.claimId
        || (ref.sandboxId !== undefined && ref.sandboxId !== parsed.data.name)) {
        return { kind: 'unknown' as const, resource: ref };
    }
    const resource = FleetResourceV1Schema.safeParse({ ...ref, sandboxId: parsed.data.name });
    return resource.success ? { kind: 'bound' as const, resource: resource.data }
        : { kind: 'unknown' as const, resource: ref };
}

export function fleetClaimTarget(resource: unknown) {
    const ref = FleetResourceV1Schema.parse(resource);
    return { namespace: ref.namespace, name: ref.claimId };
}

// Cua native source 2bce4442, libs/fleet/sdk/{routes,claims}.rs. The
// sandbox CLI owns automatic heartbeats; use the single client's authenticated
// Fleet transport to leave this finite claim's lease unchanged.
function namespacePath(namespace: string) {
    return `api/k8s/apis/osgym.cua.ai/v1alpha1/namespaces/${namespace}`;
}
function claimPath(resource: FleetResourceV1) {
    return `${namespacePath(resource.namespace)}/osgymsandboxclaims/${resource.claimId}`;
}
function claimObservation(value: unknown, resource: FleetResourceV1, observedAt: number) {
    const observation = decodeFleetClaim({ name: resource.claimId, namespace: resource.namespace,
        json: JSON.stringify(value) }, resource, observedAt);
    return { ...observation, existence: observation.kind === 'unknown' ? 'unknown' as const : 'present' as const,
        power: 'unknown' as const };
}

export function createCuaFleet(native: CuaNativeClient) {
    async function selection(namespace: string, signal?: AbortSignal) {
        const base = namespacePath(namespace);
        const poolResponse = await native.fleetJson({ method: 'GET', path: `${base}/osgymsandboxwarmpools/${namespace}` }, signal);
        if (poolResponse.kind !== 'success' || poolResponse.value.status !== 200) return undefined;
        const pool = NativeFleetPoolSchema.safeParse(poolResponse.value.value);
        if (!pool.success || pool.data.metadata.name !== namespace || pool.data.metadata.namespace !== namespace) return undefined;
        const parsedTemplateId = FleetNativeIdSchema.safeParse(pool.data.spec.sandboxTemplateRef.name);
        if (!parsedTemplateId.success) return undefined;
        const templateResponse = await native.fleetJson({ method: 'GET', path: `${base}/osgymsandboxtemplates/${parsedTemplateId.data}` }, signal);
        if (templateResponse.kind !== 'success' || templateResponse.value.status !== 200) return undefined;
        const template = NativeFleetTemplateSchema.safeParse(templateResponse.value.value);
        if (!template.success || template.data.metadata.name !== parsedTemplateId.data
            || template.data.metadata.namespace !== namespace) return undefined;
        return { pool: pool.data, template: template.data };
    }
    async function inspect(input: unknown, observedAt: number, signal?: AbortSignal) {
        const resource = FleetResourceV1Schema.parse(input);
        const unknown = { kind: 'unknown' as const, resource, existence: 'unknown' as const, power: 'unknown' as const };
        if (!Number.isFinite(observedAt)) return unknown;
        const response = await native.fleetJson({ method: 'GET', path: claimPath(resource) }, signal);
        if (response.kind !== 'success') return unknown;
        if (response.value.status === 404) return { kind: 'absent' as const, resource,
            existence: 'absent' as const, power: 'unknown' as const, resume: 'unsupported' as const };
        if (response.value.status !== 200) return unknown;
        return claimObservation(response.value.value, resource, observedAt);
    }
    return {
        async options(input: unknown, signal?: AbortSignal) {
            const query = FleetOptionsQueryV1Schema.parse(input);
            const current = await selection(query.namespace, signal);
            if (!current) throw Object.assign(new Error('Native options are unavailable'), { code: 'native_options_unavailable' });
            const spec = current.template.spec.vmTemplate;
            const launch = FleetLaunchV1Schema.safeParse({ namespace: query.namespace, sizeId: current.pool.metadata.name,
                imageId: spec.containerDiskImage, runtimeId: spec.runtime ?? 'kubevirt', nativeLease: query.nativeLease });
            if (!launch.success) return { choices: [] };
            // Pool ownership, capacity and price remain native. Only the
            // observed configured shape and explicit lease become a choice.
            const title = [current.pool.metadata.name, launch.data.runtimeId,
                ...(spec.cpuCores === undefined ? [] : [`${spec.cpuCores} CPU`]), ...(spec.memory === undefined ? [] : [spec.memory])].join(' · ');
            return MachineProvisionerOptionsResultV1Schema.parse({ choices: [{ id: current.pool.metadata.name,
                title: { key: 'machineCua.fleet.nativeChoice', fallback: title }, launch: launch.data, available: true,
                nativeFacts: { size: { id: current.pool.metadata.name, title,
                    ...(spec.cpuCores === undefined ? {} : { cpuCores: spec.cpuCores }) },
                    image: { id: spec.containerDiskImage, title: spec.containerDiskImage },
                    location: { id: query.namespace, title: query.namespace },
                    duration: { id: String(query.nativeLease.durationSeconds), title: `${query.nativeLease.durationSeconds} s`,
                        afterMs: query.nativeLease.durationSeconds * 1000 } } }] });
        },
        async create(input: unknown, nameInput: string, observedAt: number, signal?: AbortSignal, guestToken?: string) {
            const launch = FleetLaunchV1Schema.parse(input);
            const name = FleetNativeIdSchema.parse(nameInput);
            const resource: FleetResourceV1 = { namespace: launch.namespace, claimId: name };
            const unknown = { kind: 'unknown' as const, recovery: resource };
            if (!Number.isFinite(observedAt)) return unknown;
            const base = namespacePath(launch.namespace);
            const current = await selection(launch.namespace, signal);
            if (!current) return unknown;
            const templateId = current.template.metadata.name;
            // The native pool is the reviewed size/shape; this route never
            // changes its template or provisions replacement pool capacity.
            const spec = current.template.spec.vmTemplate;
            if (launch.sizeId !== current.pool.metadata.name || launch.imageId !== spec.containerDiskImage
                || launch.runtimeId !== (spec.runtime ?? 'kubevirt')) {
                return { kind: 'unavailable' as const, reason: 'native_selection_mismatch' as const };
            }
            function acceptedClaim(value: unknown) {
                const claim = NativeFleetClaimSchema.safeParse(value);
                if (!claim.success || claim.data.spec.sandboxTemplateRef.name !== templateId
                    || claim.data.spec.ttlSecondsAfterCreated !== launch.nativeLease.durationSeconds
                    || (guestToken !== undefined && claim.data.spec.secretRef?.name !== `cua-claim-${name}`)
                    || claim.data.spec.lifecycle?.autoRenew === true) return unknown;
                const observation = claimObservation(value, resource, observedAt);
                return observation.kind === 'unknown' ? unknown : observation;
            }
            const existing = await native.fleetJson({ method: 'GET', path: claimPath(resource) }, signal);
            if (existing.kind !== 'success') return unknown;
            if (existing.value.status === 200) return acceptedClaim(existing.value.value);
            if (existing.value.status !== 404) return unknown;
            const secretName = `cua-claim-${name}`;
            if (guestToken !== undefined) {
                // Native CreateClaimRequest.secret_files owns per-claim delivery
                // to /run/cua/env-token. No pool/template/default is mutated.
                const secret = await native.fleetJson({ method: 'POST', path: `api/k8s/api/v1/namespaces/${launch.namespace}/secrets`, body: {
                    apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace: launch.namespace,
                        labels: { 'osgym.cua.ai/claim': name } }, type: 'Opaque', stringData: { 'env-token': guestToken },
                } }, signal);
                if (secret.kind !== 'success' || ![200, 201, 202].includes(secret.value.status)) return unknown;
            }
            const response = await native.fleetJson({ method: 'POST', path: `${base}/osgymsandboxclaims`, body: {
                apiVersion: 'osgym.cua.ai/v1alpha1', kind: 'OSGymSandboxClaim',
                metadata: { name, namespace: launch.namespace },
                spec: { sandboxTemplateRef: { name: templateId },
                    // Canonical vendor CreateClaimRequest bind deadline.
                    bindDeadline: 900, ttlSecondsAfterCreated: launch.nativeLease.durationSeconds,
                    ...(guestToken !== undefined ? { secretRef: { name: secretName } } : {}) },
            } }, signal);
            if (response.kind !== 'success') return unknown;
            if (response.value.status === 409) {
                const current = await native.fleetJson({ method: 'GET', path: claimPath(resource) }, signal);
                return current.kind === 'success' && current.value.status === 200 ? acceptedClaim(current.value.value) : unknown;
            }
            return [200, 201, 202].includes(response.value.status) ? acceptedClaim(response.value.value) : unknown;
        },
        inspect,
        async observe(input: unknown, observedAt: number, signal?: AbortSignal): Promise<MachineProvisionerObservationV1> {
            const current = await inspect(input, observedAt, signal);
            const facts = { observedAt, power: 'unknown' as const,
                billing: { location: 'cloud' as const, stoppedBilling: 'unknown' as const } };
            if (current.kind === 'unknown') return { ...facts, availability: 'unavailable', reason: 'native_claim_unknown' };
            if (current.kind === 'absent') return { ...facts, availability: 'absent' };
            // Claim presence/expiry never proves compute power. Ended claims
            // remain present until authenticated native absence is observed.
            return { ...facts, availability: 'present',
                ...('nativeExpiryAt' in current && current.nativeExpiryAt !== undefined
                    && { nativeExpiry: current.nativeExpiryAt }) };
        },
        // The host owns polling/cancellation. Each attach reads this claim once,
        // retaining pending identity, without renewal or a fresh allocation.
        attach: inspect,
        async release(input: unknown, observedAt: number, signal?: AbortSignal, privateSecret = false) {
            const resource = FleetResourceV1Schema.parse(input);
            const unknown = { kind: 'unknown' as const, resource, existence: 'unknown' as const };
            const before = await inspect(resource, observedAt, signal);
            if (before.kind === 'unknown') return unknown;
            const released = { kind: 'released' as const, resource, existence: 'absent' as const };
            async function removeSecret() {
                if (!privateSecret) return true;
                const result = await native.fleetJson({ method: 'DELETE', path: `api/k8s/api/v1/namespaces/${resource.namespace}/secrets/cua-claim-${resource.claimId}` }, signal);
                if (result.kind !== 'success' || ![200, 202, 204, 404].includes(result.value.status)) return false;
                const observed = await native.fleetJson({ method: 'GET', path: `api/k8s/api/v1/namespaces/${resource.namespace}/secrets/cua-claim-${resource.claimId}` }, signal);
                return observed.kind === 'success' && observed.value.status === 404;
            }
            if (before.kind === 'absent') return await removeSecret() ? released : unknown;
            const response = await native.fleetJson({ method: 'DELETE', path: claimPath(resource) }, signal);
            if (response.kind !== 'success' || ![200, 202, 204, 404].includes(response.value.status)) return unknown;
            const after = await inspect(resource, observedAt, signal);
            return after.kind === 'absent' && await removeSecret() ? released : unknown;
        },
    };
}
