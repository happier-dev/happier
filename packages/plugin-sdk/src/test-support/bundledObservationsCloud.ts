import type { MachineProvisionerObservationV1 } from '../machine-provisioners/index.js';
import { MachineProvisionerObservationV1Schema } from '../machine-provisioners/index.js';
import { createPluginHttpFixture, createPluginTestkit } from '../testing/index.js';
import { createAgent37NativeClient } from '../../../plugins/machine-agent37/src/machine/nativeClient.js';
import { createMaritimeNativeClient } from '../../../plugins/machine-maritime/src/machine/nativeClient.js';
import { createMaritimeSandboxClient } from '../../../plugins/machine-maritime/src/sandbox/native.js';
import { createSuperserveNativeClient } from '../../../plugins/machine-superserve/src/machine/nativeClient.js';
import { createUpstashBoxNativeClient } from '../../../plugins/machine-upstash-box/src/machine/nativeClient.js';
import { createFreestyleNativeClient } from '../../../plugins/machine-freestyle/src/machine/nativeClient.js';
import { createE2bNativeClient } from '../../../plugins/machine-e2b/src/machine/nativeClient.js';
import { createVercelNativeClient } from '../../../plugins/machine-vercel/src/machine/nativeClient.js';
import { createDaytonaNativeClient } from '../../../plugins/machine-daytona/src/machine/nativeClient.js';
import { createRailwayNativeClient } from '../../../plugins/machine-railway/src/machine/nativeClient.js';
import { PLUGIN as BOAT_PLUGIN, PLUGIN_MANIFEST as BOAT_MANIFEST } from '../../../plugins/machine-boat/src/manifest.js';

// Inputs follow the native DTOs decoded by each adapter, with provenance beside
// those decoders. Only HTTP is substituted; all identity and observation logic runs.
type ObservationCase = Readonly<{
    plugin: string;
    provisioner: string;
    state: string;
    expected: Partial<MachineProvisionerObservationV1>;
    expectedErrorCode?: string;
    observe: () => Promise<MachineProvisionerObservationV1>;
}>;
const observedAt = Date.UTC(2026, 10, 16);
const expiry = '2026-11-17T00:00:00Z';
const expiryMs = Date.parse(expiry);
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const managedId = 'observation-fixture';
const name = 'happier-observation-fixture';
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const response = (value: unknown, status = 200): typeof fetch => async () => json(value, status);
const unreachable: typeof fetch = async () => { throw new Error('simulated HTTP transport failure'); };
const unavailable = { availability: 'unavailable' } as const;
const absent = { availability: 'absent' } as const;
const present = (power: MachineProvisionerObservationV1['power'], storage: MachineProvisionerObservationV1['storage'] = 'retained') =>
    ({ availability: 'present', power, storage } as const);
function entry(provisioner: string, state: string, expected: Partial<MachineProvisionerObservationV1>, observe: ObservationCase['observe']): ObservationCase {
    return { plugin: 'machine-' + provisioner, provisioner, state, expected, observe };
}
function failures(provisioner: string, inspect: (request: typeof fetch) => Promise<MachineProvisionerObservationV1>, absentValue: unknown = {}, absentStatus = 404): ObservationCase[] {
    return [
        entry(provisioner, 'absent', absent, () => inspect(response(absentValue, absentStatus))),
        entry(provisioner, 'HTTP read failed', unavailable, () => inspect(response({}, 503))),
        entry(provisioner, 'transport read failed', unavailable, () => inspect(unreachable)),
        entry(provisioner, 'malformed native response', unavailable, () => inspect(response({}))),
    ];
}

const agent37Resource = { instanceId: 'abc1234567', managedId, kind: 'vm', size: '2-4', region: 'us' } as const;
const agent37Inspect = (request: typeof fetch) => createAgent37NativeClient(request, signal(), observedAt).inspect(agent37Resource);
const agent37 = [
    ...(['running', 'stopped', 'starting'] as const).map(state => entry('agent37', state,
        present(state === 'starting' ? 'unknown' : state),
        () => agent37Inspect(response({ id: agent37Resource.instanceId, status: state })))),
    ...failures('agent37', agent37Inspect).map(test => ({ ...test,
        ...(test.state === 'HTTP read failed' ? { expectedErrorCode: 'provider_unavailable' }
            : test.state === 'malformed native response' ? { expectedErrorCode: 'agent37_invalid_response' } : {}) })),
];

const maritime = (['agent-box', 'linux-computer'] as const).flatMap(kind => {
    const resource = { machineId: 'maritime-1', managedId, kind };
    const inspect = (request: typeof fetch) => createMaritimeNativeClient(request, signal(), observedAt).inspect(resource);
    return [
        ...(['active', 'ready', 'sleeping', 'stopped', 'creating'] as const).map(state => entry('maritime', kind + ': ' + state,
            present(state === 'active' || state === 'ready' ? 'running' : state === 'sleeping' ? 'suspended' : state === 'stopped' ? 'stopped' : 'unknown'),
            () => inspect(response({ id: resource.machineId, status: state,
                ...(kind === 'agent-box' ? { externalId: managedId } : { externalUserId: managedId, os: 'linux' }) })))),
        ...failures('maritime', inspect).map(test => ({ ...test, state: kind + ': ' + test.state })),
    ];
});

const maritimeSandboxResource = { sandboxId: 'maritime-sandbox-1', name };
const maritimeSandboxInspect = (request: typeof fetch) => createMaritimeSandboxClient(request, signal(), observedAt).inspect(maritimeSandboxResource);
const maritimeSandbox = [
    ...(['running', 'paused', 'creating', 'ended'] as const).map(state => entry('maritime-sandbox', state,
        state === 'ended' ? absent : present(state === 'running' ? 'running' : state === 'paused' ? 'suspended' : 'unknown'),
        () => maritimeSandboxInspect(response({ id: maritimeSandboxResource.sandboxId, name, state, forEndUser: true,
            dataPlaneUrl: 'https://sandbox.maritime.sh', secret: null })))),
    ...failures('maritime-sandbox', maritimeSandboxInspect),
].map(test => ({ ...test, plugin: 'machine-maritime' }));

const superserveResource = { sandboxId: 'superserve-1', name, managedId };
const superserveInspect = (request: typeof fetch) => createSuperserveNativeClient(request, signal(), observedAt).inspect(superserveResource);
const superserve = [
    ...(['active', 'paused', 'pausing'] as const).map(state => entry('superserve', state,
        { ...present(state === 'active' ? 'running' : state === 'paused' ? 'suspended' : 'unknown', state === 'pausing' ? 'unknown' : 'retained'), nativeExpiry: expiryMs,
            size: { cpuCores: 2, memoryBytes: 4096 * MiB } },
        () => superserveInspect(response({ id: superserveResource.sandboxId, name, status: state,
            metadata: { 'happier-managed-id': managedId }, vcpu_count: 2, memory_mib: 2048, memory_current_mib: 4096,
            auto_delete_at: expiry, auto_delete_seconds: 3600 })))),
    ...failures('superserve', superserveInspect),
    entry('superserve', 'fixed memory allocation', { ...present('suspended'), size: { cpuCores: 1, memoryBytes: 1024 * MiB } },
        () => superserveInspect(response({ id: superserveResource.sandboxId, name, status: 'paused',
            metadata: { 'happier-managed-id': managedId }, vcpu_count: 1, memory_mib: 1024 }))),
];

const upstashResource = { boxId: 'upstash-1', name, managedId };
const upstashInspect = (request: typeof fetch) => createUpstashBoxNativeClient(request, signal(), observedAt).inspect(upstashResource);
const upstash = [
    ...(['idle', 'running', 'paused', 'creating', 'deleted'] as const).map(state => entry('upstash-box', state,
        state === 'deleted' ? absent : present(state === 'idle' || state === 'running' ? 'running' : state === 'paused' ? 'stopped' : 'unknown', state === 'creating' ? 'unknown' : 'retained'),
        () => upstashInspect(response({ id: upstashResource.boxId, name, status: state, labels: ['happier-managed'] })))),
    ...failures('upstash-box', upstashInspect),
];

const freestyleResource = { vmId: 'freestyle-1', name, managedId };
const freestyleInspect = (request: typeof fetch) => createFreestyleNativeClient(request, signal(), observedAt).inspect(freestyleResource);
const freestyle = [
    ...(['running', 'stopped', 'paused', 'starting'] as const).map(state => entry('freestyle', state,
        { ...present(state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : state === 'paused' ? 'suspended' : 'unknown', state === 'starting' ? 'unknown' : 'retained'),
            nativeExpiry: expiryMs, size: { cpuCores: 4, memoryBytes: 8192 * MiB, diskBytes: 32768 * MiB },
            deletionNotices: [{ kind: 'stopped-storage', rule: { kind: 'after-stop', afterMs: 3600000 }, consequence: 'disk-deleted' }] },
        () => freestyleInspect(response({ id: freestyleResource.vmId, slug: name, state, metadata: { 'happier-managed-id': managedId },
            resources: { cpu: 4, memory: 8192, storage: 32768 }, createdAt: '2026-11-16T00:00:00Z', ttlSeconds: 86400, autoDeleteSeconds: 3600 })))),
    ...failures('freestyle', freestyleInspect),
];

const e2bResource = { sandboxId: 'e2b-1', managedId, timeoutSeconds: 86400 };
const e2bInspect = (request: typeof fetch) => createE2bNativeClient(request, signal(), observedAt).inspect(e2bResource);
const e2b = [
    ...(['running', 'paused'] as const).map(state => entry('e2b', state,
        { ...present(state === 'running' ? 'running' : 'suspended'), nativeExpiry: expiryMs,
            size: { cpuCores: 2, memoryBytes: 4096 * MiB, diskBytes: 10240 * MiB } },
        () => e2bInspect(response({ sandboxID: e2bResource.sandboxId, state, endAt: expiry, cpuCount: 2, memoryMB: 4096, diskSizeMB: 10240,
            metadata: { 'happier-managed-id': managedId } })))),
    ...failures('e2b', e2bInspect),
    entry('e2b', 'invalid expiry', unavailable, () => e2bInspect(response({ sandboxID: e2bResource.sandboxId, state: 'paused', endAt: 'invalid', metadata: { 'happier-managed-id': managedId } }))),
    entry('e2b', 'no allocated disk dimension', { ...present('running'), size: { cpuCores: 2, memoryBytes: 4096 * MiB } },
        () => e2bInspect(response({ sandboxID: e2bResource.sandboxId, state: 'running', endAt: expiry, cpuCount: 2, memoryMB: 4096, diskSizeMB: 0,
            metadata: { 'happier-managed-id': managedId } }))),
];

const daytonaResource = { sandboxId: 'daytona-1', name, managedId, organizationId: 'organization-1', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox' };
const daytonaInspect = (request: typeof fetch) => createDaytonaNativeClient(request, signal(), observedAt).inspect(daytonaResource);
const daytona = [
    ...(['started', 'stopped', 'archived', 'paused', 'starting', 'destroyed'] as const).map(state => entry('daytona', state,
        state === 'destroyed' ? absent : { ...present(state === 'started' ? 'running' : state === 'stopped' || state === 'archived' ? 'stopped' : state === 'paused' ? 'suspended' : 'unknown', state === 'starting' ? 'unknown' : 'retained'), nativeExpiry: expiryMs,
            size: { cpuCores: 2, memoryBytes: 4 * GiB, diskBytes: 10 * GiB } },
        () => daytonaInspect(response({ id: daytonaResource.sandboxId, name, organizationId: daytonaResource.organizationId, state,
            cpu: 2, memory: 4, disk: 10, toolboxProxyUrl: daytonaResource.toolboxProxyUrl, labels: { 'happier-managed-id': managedId }, autoDestroyAt: expiry })))),
    ...failures('daytona', daytonaInspect),
];

const railwayResource = { sandboxId: 'railway-1', environmentId: 'environment-1', managedId };
const railwayInspect = (request: typeof fetch) => createRailwayNativeClient(request, signal(), observedAt).inspect(railwayResource);
const railway = [
    ...(['RUNNING', 'CREATING', 'FAILED', 'DESTROYING', 'DESTROYED'] as const).map(state => entry('railway', state,
        state === 'DESTROYED' ? absent : present(state === 'RUNNING' ? 'running' : 'unknown', state === 'RUNNING' ? 'retained' : 'unknown'),
        () => railwayInspect(response({ data: { sandbox: { id: railwayResource.sandboxId, environmentId: railwayResource.environmentId, status: state, idleTimeoutMinutes: 0 } } })))),
    ...failures('railway', railwayInspect, { data: { sandbox: null } }, 200),
    entry('railway', 'GraphQL read failed over HTTP 200', unavailable, () => railwayInspect(response({ errors: [{ message: 'vendor detail' }], data: { sandbox: null } }))),
];

const vercelResource = { name, managedId, createdAt: observedAt - 1000, teamId: 'team-1', projectId: 'project-1' };
const vercelInspect = (request: typeof fetch) => createVercelNativeClient({ teamId: vercelResource.teamId, projectId: vercelResource.projectId }, request, signal(), observedAt).inspect(vercelResource);
function vercelResponse(state: 'running' | 'stopped' | 'stopping', snapshot: 'retained' | 'lost' | 'expired' | 'unavailable' | 'none' = 'none'): typeof fetch {
    return async input => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.includes('/snapshots/')) return snapshot === 'unavailable' ? json({}, 503) : json({ snapshot: {
            id: 'snapshot-1', sourceSessionId: 'session-1', status: snapshot === 'lost' ? 'deleted' : 'created', createdAt: observedAt,
            expiresAt: snapshot === 'expired' ? observedAt - 1 : expiryMs,
        } });
        return json({ sandbox: { name, createdAt: vercelResource.createdAt, tags: { 'happier-managed-id': managedId }, currentSessionId: 'session-1',
            ...(snapshot === 'none' ? {} : { currentSnapshotId: 'snapshot-1' }), persistent: true, status: state, expiresAt: expiryMs, vcpus: 4, memory: 8192 },
            session: { id: 'session-1', sourceSandboxName: name, projectId: vercelResource.projectId, createdAt: observedAt, vcpus: 2, memory: 4096 } });
    };
}
const vercel = [
    entry('vercel', 'running', { ...present('running'), nativeExpiry: expiryMs, size: { cpuCores: 2, memoryBytes: 4096 * MiB } }, () => vercelInspect(vercelResponse('running'))),
    entry('vercel', 'stopping', { ...present('unknown', 'unknown'), size: { cpuCores: 2, memoryBytes: 4096 * MiB } }, () => vercelInspect(vercelResponse('stopping'))),
    ...(['retained', 'lost', 'expired', 'unavailable', 'none'] as const).map(snapshot => entry('vercel', 'stopped; snapshot ' + snapshot,
        { ...present('stopped', snapshot === 'retained' ? 'retained' : snapshot === 'unavailable' ? 'unknown' : 'lost'), size: { cpuCores: 2, memoryBytes: 4096 * MiB } },
        () => vercelInspect(vercelResponse('stopped', snapshot)))),
    ...failures('vercel', vercelInspect).filter(test => test.state !== 'absent'),
    entry('vercel', 'absent; attachment absence established', absent, () => vercelInspect(async input => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return path.endsWith('/snapshots') ? json({ snapshots: [], pagination: { next: null } }) : json({}, 404);
    })),
    entry('vercel', 'absent VM; attachment read failed', unavailable, () => vercelInspect(response({}, 404))),
];

async function boatObserve(value: unknown, status = 200, transportFailure = false): Promise<MachineProvisionerObservationV1> {
    const http = createPluginHttpFixture({ async request(request) {
        if (transportFailure) throw new Error('simulated HTTP transport failure');
        return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) };
    } });
    const host = await createPluginTestkit({ manifest: BOAT_MANIFEST, module: BOAT_PLUGIN, services: { http } });
    try { return MachineProvisionerObservationV1Schema.parse(await host.invokeAction('inspect', { resource: { sandboxId: 'bx_23456789' } })); }
    finally { await host.dispose(); }
}
const boatValue = (state: string, facts: Readonly<Record<string, unknown>> = {}) =>
    ({ ok: true, type: 'sandbox.info', sandbox: { id: 'bx_23456789', state, ...facts } });
const stoppedNotice = { kind: 'stopped-storage', rule: { kind: 'after-stop', afterMs: 14 * 24 * 60 * 60 * 1000 }, consequence: 'disk-deleted' } as const;
const boat = [
    ...(['ready', 'idle', 'running', 'archiving', 'provisioning'] as const).map(state => entry('boat', state,
        present(state === 'archiving' || state === 'provisioning' ? 'unknown' : 'running', state === 'provisioning' ? 'unknown' : 'retained'),
        () => boatObserve(boatValue(state)))),
    entry('boat', 'archived; retained disk', present('stopped'), () => boatObserve(boatValue('archived', { dataExpiredAt: null }))),
    entry('boat', 'archived; lost disk', present('stopped', 'lost'), () => boatObserve(boatValue('archived', { dataExpiredAt: '2026-11-15T00:00:00Z' }))),
    entry('boat', 'archived; disk fact absent', present('stopped', 'unknown'), () => boatObserve(boatValue('archived'))),
    entry('boat', 'degraded running; retained native facts', { ...unavailable, storage: 'retained', nativeExpiry: expiryMs, deletionNotices: [] },
        () => boatObserve(boatValue('running', { health: 'degraded', archiveAfter: expiry }))),
    entry('boat', 'degraded archived; retained native facts', { ...unavailable, storage: 'retained', nativeExpiry: expiryMs, deletionNotices: [stoppedNotice] },
        () => boatObserve(boatValue('archived', { health: 'degraded', archiveAfter: expiry, dataExpiredAt: null }))),
    entry('boat', 'native failure', unavailable, () => boatObserve(boatValue('error'))),
    entry('boat', 'absent', absent, () => boatObserve({ ok: false, code: 'not_found' }, 404)),
    entry('boat', 'HTTP read failed', unavailable, () => boatObserve({ ok: false, code: 'service_unavailable' }, 503)),
    entry('boat', 'transport read failed', unavailable, () => boatObserve({}, 200, true)),
    entry('boat', 'malformed native response', unavailable, () => boatObserve({})),
];

export const CLOUD_OBSERVATION_CASES: readonly ObservationCase[] = [
    ...agent37, ...maritime, ...maritimeSandbox, ...superserve, ...upstash, ...freestyle, ...e2b, ...vercel, ...daytona, ...railway, ...boat,
];
