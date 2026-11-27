import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { installHostResourceWatchSocket } from './resourceWatchSocket.testFixture';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionRequestEnvelopeV1Schema, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentHealthAggregateV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storage';
import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { clearMachineRequestReachabilityForMachine } from '@/sync/domains/machines/reachability/machineReachability';
import * as machineServiceResource from '@/components/machines/resources/useMachineServiceResource';
import { machineServicesListProjection } from '@/components/machines/services/machineServicesListProjection';
import { createDeploymentReadTransport } from './deploymentReadTransport';
import { observeDeploymentSavedChecks } from './observeDeploymentSavedChecks';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentDomainReadItemV1 } from '@happier-dev/deployments';

// Replace only Home HTTP/credentials; keep Action admission, Resource and P40 real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Current edge', serverUrl: 'https://current-edge.test',
        serverIdentityId: 'srv_current_edge', accountId: 'account', currentAccount: true, active: false });
});
afterEach(async () => { await homes.reset(); });

it('keeps an open Environment saved-check definition list idle until Home publishes a change', async () => {
    const environmentId = 'saved-check-environment';
    const definitionsPath = '/v3/automations/query';
    const lifetime = { scope: { serverId, accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const publish = vi.fn();
    vi.useFakeTimers();
    const observer = observeDeploymentSavedChecks(lifetime, environmentId, publish, { definitions: true });
    try {
        await vi.waitFor(() => expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            pending: false, definitions: { status: 'ready', sources: [] },
        })));
        expect(homes.requestsFor(definitionsPath)).toHaveLength(1);
        expect(homes.requestsFor(definitionsPath)[0]?.input).toMatchObject({ healthCheckSources: { environmentId } });

        const idleStart = homes.requests.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(homes.requests.slice(idleStart)).toEqual([]);

        publishHomeAccountChange(serverId);
        await vi.waitFor(() => expect(homes.requestsFor(definitionsPath)).toHaveLength(2));
    } finally {
        observer.dispose();
        vi.useRealTimers();
    }
});

it.each([
    { refusal: 'target_unavailable', recovery: 'registry' },
    { refusal: 'target_unavailable', recovery: 'reconnect' },
    { refusal: 'credential_scope_denied', recovery: 'none' },
    { refusal: 'none', recovery: 'steady-detail' },
] as const)(
    'settles Machine Services $refusal with zero idle requests and recovery via $recovery', async ({ refusal, recovery }) => {
    const machineId = `machine-${recovery}`;
    const installationId = 'installation';
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'account' }), installationId };
    const offlineId = `offline-${recovery}`;
    const idleId = `unserved-${recovery}`;
    const distinctMachines = [machineId, offlineId, idleId].map(id => createHydratedPlainMachineFixture({
        id, accountId: 'account', machine: { installationId, active: id !== offlineId, activeAt: Date.now(), presenceProtocolVersion: 1 },
    }));
    getStorage().getState().applyMachines(distinctMachines, false, { sourceServerId: serverId, sourceAccountId: 'account',
        activityUpdates: distinctMachines.map(({ id, active, activeAt }) => ({ id, active, activeAt })) });
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, id => ({ ...row, id, active: id !== offlineId })).json(),
    }) });
    const actionId = 'machines.services.list';
    const path = `/v1/actions/${actionId}`;
    const admissions: { machineId: string; method: string | undefined }[] = [];
    homes.answer(serverId, `${path}/execution-authorization`, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        if (envelope.target?.kind !== 'machine') throw new Error('Expected a Machine Services target');
        const targetId = envelope.target.machineId;
        admissions.push({ machineId: targetId, method: envelope.resourceContinuation?.method });
        return { body: { v: 1, token: 'machine-services-proof', binding: {
            serverIdentityId: 'srv_current_edge', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
            actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: targetId }, machineId: targetId, installationId,
            custodianAccountId: 'account', accountEncryptionMode: 'plain',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
    } });
    const bytes = Buffer.from(JSON.stringify({ kind: 'snapshot', services: [] }));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const requests: string[] = [];
    let liveWatches = 0;
    let pushes = 0;
    let change: (() => void) | undefined;
    let refused = true;
    let refuseParkedWatch: (() => void) | undefined;
    const read = RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ;
    const open = RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN;
    homes.answer(serverId, path, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        const continuation = envelope.resourceContinuation;
        if (continuation?.method !== read) throw new Error('Idle watches must never send another Action HTTP request');
        requests.push(continuation.method);
        const reply: HomeDomainAnswer = { body: { v: 1, actionId, requestId: envelope.requestId,
            execution: { ok: true, result: { ok: true, resource: continuation.params.resource,
                contentType: 'application/json', bytesBase64: bytes.toString('base64'), digest } } } };
        return reply;
    } });
    const socket = installHostResourceWatchSocket({ actionId, digest: () => digest, onOpen(watch) {
        requests.push(open);
        liveWatches++;
        refuseParkedWatch = () => watch.refuse(refusal);
        change = () => {
            pushes++;
            watch.invalidate(`sha256:${'a'.repeat(64)}`);
        };
        if (refusal === 'target_unavailable' && refused) queueMicrotask(() => watch.refuse(refusal));
    }, onDisconnect() { liveWatches--; } });
    const scope = { serverId, accountId: 'account' };
    const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const transport = createDeploymentReadTransport(lifetime);
    const resource = machineServiceResource.createMachineServiceResourceBinding({ accountLifetime: lifetime, reference: {
        hostRead: actionId, input: { serverId, machineId },
    }, projection: machineServicesListProjection });
    const rows = [...Array.from({ length: 500 }, (_, index) => ({ id: `apps-${index}`, target: machineId })),
        { id: 'offline-app', target: offlineId }, { id: 'unserved-app', target: idleId }].map(({ id, target }) => {
        const link = createDeploymentTargetLinkHeaderV1({ environmentId: id, machines: [target],
            activeDeploymentId: target === idleId ? undefined : `serving-${id}`,
            members: [{ machineId: target, installationId, state: 'active' }] });
        return { title: id, environment: createDeploymentEnvironmentHeaderV1({ serverId, id, runtimeTargetLinkId: link.id }),
            runtimeTargetLink: link };
    });
    const abort = new AbortController();
    const createBinding = machineServiceResource.createMachineServiceResourceBinding;
    const attachments: string[] = [];
    // Count local attachments at the Resource boundary while keeping the real selection and transport.
    const measureBinding: typeof createBinding = input => {
        const binding = createBinding(input);
        if (input.reference.hostRead === 'machines.services.list') {
            const subscribe = binding.selection.subscribe;
            binding.selection.subscribe = (listener, live) => {
                attachments.push(input.reference.input.machineId);
                return subscribe(listener, live);
            };
        }
        return binding;
    };
    const measureBindings = vi.spyOn(machineServiceResource, 'createMachineServiceResourceBinding')
        .mockImplementation(measureBinding);
    vi.useFakeTimers();
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    if (recovery === 'steady-detail') Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    const publishDetail = vi.fn();
    const firstRow = rows[0]!;
    const detail = { ...createDeploymentEnvironmentDetailV1({ environment: firstRow.environment }),
        runtimeTargetLink: firstRow.runtimeTargetLink, builtInUrls: null, memberVersions: {}, secretRevisions: [] };
    const stop = recovery === 'steady-detail'
        ? transport.observeEnvironmentHealth!(scope, detail, publishDetail, { signal: abort.signal })
        : transport.observeEnvironmentCollectionHealth!(scope, rows, () => {}, { signal: abort.signal });
    try {
        await vi.waitFor(() => expect(requests).toContain(open));
        expect(admissions.filter(admission => admission.method === read).map(admission => admission.machineId)).toEqual([machineId]);
        expect(new Set(admissions.map(admission => admission.machineId))).toEqual(new Set([machineId]));
        expect(attachments).toEqual([machineId]);
        expect(requests.filter(method => method === read)).toHaveLength(1);
        expect(requests.filter(method => method === open)).toHaveLength(1);
        if (refusal === 'credential_scope_denied') {
            await vi.waitFor(() => expect(resource.selection.getSnapshot()).toMatchObject({
                subscription: 'live', value: { kind: 'snapshot', services: [] },
            }));
            refuseParkedWatch?.();
        }
        const openCount = requests.length;
        if (recovery === 'steady-detail') {
            const published = publishDetail.mock.calls.length;
            const authorized = admissions.length;
            const homeRequests = homes.requestsFor('/v1/machines/read-batch').length;
            publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: 'unrelated-machine' }, 'authority');
            await vi.advanceTimersByTimeAsync(60_000);
            expect({ homeRequests: homes.requestsFor('/v1/machines/read-batch').length - homeRequests,
                authorizations: admissions.length - authorized, actions: requests.length - openCount,
                publishes: publishDetail.mock.calls.length - published }).toEqual({
                homeRequests: 0, authorizations: 0, actions: 0, publishes: 0,
            });
            expect(liveWatches).toBe(1);
            change?.();
            await vi.waitFor(() => expect(requests.filter(method => method === read)).toHaveLength(2));
            expect(pushes).toBe(1);
            expect(admissions.filter(entry => entry.method === open)).toHaveLength(1);
            return;
        }
        await vi.advanceTimersByTimeAsync(60_000);
        expect(requests.slice(openCount)).toEqual([]);
        if (refusal === 'credential_scope_denied') {
            expect(resource.selection.getSnapshot()).toMatchObject({
                pending: 'idle', subscription: 'ended', error: { code: 'denied', diagnostics: [refusal] },
            });
            expect(resource.selection.getSnapshot().value).toBeUndefined();
            return;
        }
        expect(resource.selection.getSnapshot()).toMatchObject({
            pending: 'idle', subscription: 'reconnecting', error: { code: 'target_unavailable' },
        });
        refused = false;
        const recover = (id: string) => recovery === 'reconnect'
            ? clearMachineRequestReachabilityForMachine(scope, id)
            : publishMachineContributionRegistryProjectionInvalidation({ serverId, machineId: id }, 'authority');
        recover('unrelated-machine');
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(openCount);
        recover(machineId);
        await vi.waitFor(() => expect(requests.filter(method => method === open)).toHaveLength(2));
        await vi.waitFor(() => expect(resource.selection.getSnapshot()).toMatchObject({
            pending: 'idle', subscription: 'live', freshness: 'fresh', value: { kind: 'snapshot', services: [] },
        }));
        expect(requests.filter(method => method === read)).toHaveLength(2);
        if (recovery === 'registry') {
            getStorage().getState().applyMachineActivityUpdates([{ id: offlineId, active: true, activeAt: Date.now() }],
                { sourceServerId: serverId, sourceAccountId: 'account' });
            await vi.waitFor(() => expect(admissions.filter(admission => admission.machineId === offlineId && admission.method === read))
                .toHaveLength(1));
            expect(admissions.some(admission => admission.machineId === idleId)).toBe(false);
        }
    } finally {
        abort.abort();
        stop();
        measureBindings.mockRestore();
        socket.mockRestore();
        if (recovery === 'steady-detail') {
            if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
            else Reflect.deleteProperty(AbortSignal, 'any');
        }
        vi.useRealTimers();
    }
});

it.each([true, false])('keeps selected Domain facts on unavailability, with active Environment detail: %s', async reuseDetail => {
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1();
    const environment = { ...base.environment, serverId, controllerMachineId: 'controller', runtimeTargetLinkId: link.id };
    const environmentPath = `/v1/deployments/environments/${environment.id}`;
    homes.answer(serverId, environmentPath, { body: { ok: true, environment, targetLinks: [link] } });
    const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'selected-domain', environmentId: environment.id,
        targetLinkId: link.id, revision: 1, state: 'active', contentArtifactId: 'domain-content', contentHeaderVersion: 1,
        contentBodyVersion: 1, createdByAccountId: 'account', createdAtMs: 1, updatedAtMs: 1 });
    const item: DeploymentDomainReadItemV1 = { domain, title: 'Application', content: {
        hostname: 'app.test', target: { service: 'web', containerPort: 80 } } };
    const facts = { availability: 'observed', unavailableReason: null, observedAt: 1000, vantage: 'outside',
        certificate: { state: 'expiresSoon', expiresAt: 3000 },
        needsYou: { cause: 'certificate', reason: 'expiresSoon', vantage: 'outside' } } as const;
    const input = { serverId, machineId: 'controller', environmentId: environment.id, targetLinkId: link.id, domainIds: [domain.id] };
    const reference = { hostRead: 'deployments.health.edge', input };
    let mismatch: 'environment' | 'link' | 'revision' | undefined;
    const content = () => {
        const bytes = Buffer.from(JSON.stringify({ ok: true, environmentId: mismatch === 'environment' ? 'other-environment' : environment.id,
            targetLinkId: mismatch === 'link' ? 'other-link' : link.id, observation: null,
            domainHealth: [{ domainId: domain.id, domainRevision: mismatch === 'revision' ? domain.revision + 1 : domain.revision,
                facts, observations: [] }] }));
        return { bytesBase64: bytes.toString('base64'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    const row = { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account' }), installationId: 'installation' };
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({ body: await createMachineReadBatchResponseFixture(body, () => row).json() }) });
    const actionId = 'deployments.health.current';
    const actionPath = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        return { body: { v: 1, token: 'current-domain-proof', binding: { serverIdentityId: 'srv_current_edge', accountId: 'account',
            authentication: { kind: 'account', tokenEpoch: 0 }, actionId, requestId: envelope.requestId,
            target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller', installationId: 'installation',
            custodianAccountId: 'account', accountEncryptionMode: 'plain',
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } } };
    } });
    let unavailable = false;
    let deliver: (() => void) | undefined;
    const methods: string[] = [];
    homes.answer(serverId, actionPath, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        expect(envelope.input).toMatchObject(input);
        const continuation = envelope.resourceContinuation;
        if (continuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) throw new Error('Expected a current-health Resource read');
        methods.push(continuation.method);
        const result = unavailable ? { ok: false, code: 'machine_unavailable', reason: 'unavailable' }
            : { ok: true, resource: reference, contentType: 'application/json', ...content() };
        return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } };
    } });
    const socket = installHostResourceWatchSocket({ actionId, digest: () => content().digest, onOpen(watch) {
        deliver = () => watch.invalidate(unavailable
            ? `sha256:${createHash('sha256').update('unavailable').digest('hex')}` : content().digest);
    } });
    const retirementCallbacks = new Set<() => void>();
    const lifetime = { scope: { serverId, accountId: 'account' }, isCurrent: () => true, onRetire(callback: () => void) {
        retirementCallbacks.add(callback);
        return { dispose() { retirementCallbacks.delete(callback); } };
    } };
    const transport = createDeploymentReadTransport(lifetime);
    const abort = new AbortController();
    let items: readonly DeploymentDomainReadItemV1[] = [item];
    const stop = transport.observeDomainHealth!(lifetime.scope, environment.id, items, next => { items = next; }, {
        signal: abort.signal,
        ...(reuseDetail ? { environmentDetail: { environment, runtimeTargetLink: link } } : {}),
    });
    try {
        await vi.waitFor(() => expect(items[0]).toMatchObject({ title: item.title, health: facts }));
        await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
        unavailable = true;
        deliver?.();
        await vi.waitFor(() => expect(items[0]).toMatchObject({ domain, health: facts, healthUnavailableReason: 'machine_unavailable' }));
        expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toHaveLength(2);
        const environmentReads = homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === environmentPath);
        if (reuseDetail) expect(environmentReads).toHaveLength(0);
        else expect(environmentReads.length).toBeGreaterThan(0);
        expect(homes.requests.some(request => request.path.startsWith('/v1/artifacts'))).toBe(false);
        if (reuseDetail) {
            unavailable = false;
            for (const mismatchKind of ['environment', 'link', 'revision'] as const) {
                const previousReadCount = methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ).length;
                await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
                mismatch = mismatchKind;
                deliver?.();
                await vi.waitFor(() => expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ))
                    .toHaveLength(previousReadCount + 1));
                await vi.waitFor(() => expect(items[0]).toMatchObject({ domain, health: undefined, healthUnavailableReason: 'coverage_unavailable' }));
            }
        }
    } finally { abort.abort(); stop(); socket.mockRestore(); }
    expect(retirementCallbacks.size).toBe(0);
});

it('shares current edge health between a three-Environment list and the selected page', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1({ machines: ['joining'],
        members: [{ machineId: 'joining', installationId: 'joining-installation', state: 'joining' }] });
    const detail = { ...base, environment: { ...base.environment, serverId, protection: 'production' as const, controllerMachineId: 'controller',
        runtimeTargetLinkId: link.id, ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' } },
        runtimeTargetLink: link, builtInUrls: null, memberVersions: {}, secretRevisions: [] };
    const input = { serverId, machineId: 'controller', environmentId: detail.environment.id, targetLinkId: link.id };
    const reference = { hostRead: 'deployments.health.edge', input };
    const proof = { environmentId: detail.environment.id, targetLinkId: link.id, targetLinkRevision: link.revision,
        machineId: 'edge', role: 'edge', status: 'up' as 'up' | 'down', observedAtMs: 100,
        source: { kind: 'domain', observerMachineId: 'controller' } };
    let observation: typeof proof | null = proof;
    const content = () => {
        const bytes = Buffer.from(JSON.stringify({ ok: true, environmentId: detail.environment.id, targetLinkId: link.id, observation }));
        return { bytesBase64: bytes.toString('base64'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    const row = { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account' }), installationId: 'installation' };
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, () => row).json(),
    }) });
    const actionId = 'deployments.health.current';
    const actionPath = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        return { body: { v: 1, token: 'current-edge-proof', binding: {
            serverIdentityId: 'srv_current_edge', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
            actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'controller' },
            machineId: 'controller', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
    } });
    let deliver: (() => void) | undefined;
    let reads = 0;
    homes.answer(serverId, actionPath, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        if (envelope.resourceContinuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) throw new Error('Expected a current-edge Resource read');
        reads++;
        return { body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true,
            result: { ok: true, resource: reference, contentType: 'application/json', ...content() } } } };
    } });
    const socket = installHostResourceWatchSocket({ actionId, digest: () => content().digest, onOpen(watch) {
        deliver = () => watch.invalidate(content().digest);
    } });
    let aggregate: DeploymentEnvironmentHealthAggregateV1 | undefined;
    const abort = new AbortController();
    const retirementCallbacks = new Set<() => void>();
    const scope = { serverId, accountId: 'account' };
    const transport = createDeploymentReadTransport({ scope,
        isCurrent: () => true, onRetire: callback => {
            retirementCallbacks.add(callback);
            return { dispose() { retirementCallbacks.delete(callback); } };
        } });
    const rows = [
        { title: 'API', environment: detail.environment, runtimeTargetLink: link },
        { title: 'Status', environment: createDeploymentEnvironmentHeaderV1({ serverId, id: 'status' }) },
        { title: 'Billing', environment: createDeploymentEnvironmentHeaderV1({ serverId, id: 'billing' }) },
    ];
    const rowFacts = new Map<string, DeploymentEnvironmentHealthAggregateV1 | undefined>();
    const edgeStates: string[] = [];
    const stopCollection = transport.observeEnvironmentCollectionHealth!(scope, rows, (id, value) => {
        rowFacts.set(id, value);
        if (id === detail.environment.id && value) edgeStates.push(value.status);
    }, { signal: abort.signal });
    try {
        expect(edgeStates).not.toContain('down');
        await vi.waitFor(() => expect(rowFacts.get(detail.environment.id)).toMatchObject({ status: 'up' }));
        // The saved-check read can settle before the edge answers. Its initial unknown is quiet.
        expect(edgeStates.filter(state => state !== 'unknown')).toEqual(['up']);
        expect(rowFacts.size).toBe(3);
        transport.observeEnvironmentHealth!(scope, detail, (_feed, value) => { aggregate = value; }, { signal: abort.signal });
        expect(aggregate).toBe(rowFacts.get(detail.environment.id));
        expect(reads).toBe(1);
        await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
        const healthy = deliver;
        observation = { ...proof, status: 'down', observedAtMs: 101 };
        healthy?.();
        await vi.waitFor(() => {
            expect(rowFacts.get(detail.environment.id)).toMatchObject({ status: 'down', edgeUnreachable: true });
            expect(aggregate).toBe(rowFacts.get(detail.environment.id));
        });
        expect(edgeStates.filter(state => state === 'down')).toHaveLength(1);
        expect(deliver).toBe(healthy);
        observation = null;
        healthy?.();
        await vi.waitFor(() => expect(aggregate).toMatchObject({ members: [{ machineId: 'edge', status: 'unknown' }] }));
        observation = proof;
        healthy?.();
        await vi.waitFor(() => expect(aggregate).toMatchObject({ members: [{ machineId: 'edge', status: 'up' }] }));
        observation = { ...proof, targetLinkRevision: link.revision + 1 };
        deliver?.();
        await vi.waitFor(() => expect(aggregate).toMatchObject({ members: [{ machineId: 'edge', status: 'unknown' }] }));
    } finally { abort.abort(); stopCollection(); socket.mockRestore(); }
    expect(retirementCallbacks.size).toBe(0);
});
