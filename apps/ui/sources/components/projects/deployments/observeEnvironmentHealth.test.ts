import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionRequestEnvelopeV1Schema, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentHealthFeedV1 } from '@happier-dev/deployments';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { environmentHealthObserver } from './observeEnvironmentHealth';
import { createDeploymentReadTransport } from './deploymentReadTransport';
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

it('reads selected Domain facts through the same controller Resource while keeping metadata and prior facts on unavailability', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1();
    const environment = { ...base.environment, serverId, controllerMachineId: 'controller', runtimeTargetLinkId: link.id };
    homes.answer(serverId, `/v1/deployments/environments/${environment.id}`, { body: { ok: true, environment, targetLinks: [link] } });
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
    const content = () => {
        const bytes = Buffer.from(JSON.stringify({ ok: true, environmentId: environment.id, targetLinkId: link.id,
            observation: null, domainHealth: [{ domainId: domain.id, domainRevision: domain.revision, facts, observations: [] }] }));
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
    homes.answer(serverId, actionPath, { select: async (body, request) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        expect(envelope.input).toMatchObject(input);
        const continuation = envelope.resourceContinuation;
        if (!continuation) throw new Error('Expected existing current-health Resource continuation');
        methods.push(continuation.method);
        const reply = (result: unknown): HomeDomainAnswer => ({ body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return reply(unavailable
            ? { ok: false, code: 'machine_unavailable', reason: 'unavailable' }
            : { ok: true, resource: reference, contentType: 'application/json', ...content() });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
            return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return reply({ ok: true, closed: true });
        const subscriptionId = continuation.params.subscriptionId;
        return new Promise<HomeDomainAnswer>(resolve => {
            deliver = () => resolve(reply({ ok: true, status: 'event', event: { version: 1, kind: 'invalidated', subscriptionId,
                digest: unavailable ? `sha256:${createHash('sha256').update('unavailable').digest('hex')}` : content().digest } }));
            const abort = () => resolve(reply({ ok: true, status: 'idle' }));
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) abort();
        });
    } });
    const lifetime = { scope: { serverId, accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const transport = createDeploymentReadTransport(lifetime);
    const abort = new AbortController();
    let items: readonly DeploymentDomainReadItemV1[] = [item];
    const stop = transport.observeDomainHealth!(lifetime.scope, environment.id, items, next => { items = next; }, { signal: abort.signal });
    try {
        await vi.waitFor(() => expect(items[0]).toMatchObject({ title: item.title, health: facts }));
        await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
        unavailable = true;
        deliver?.();
        await vi.waitFor(() => expect(items[0]).toMatchObject({ domain, health: facts, healthUnavailableReason: 'machine_unavailable' }));
        expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toHaveLength(2);
        expect(homes.requests.some(request => request.path.startsWith('/v1/artifacts'))).toBe(false);
    } finally { abort.abort(); stop(); }
});

it('pushes the same observer current edge proof into the Environment aggregate and withdraws missing or stale proof', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1({ machines: ['joining'],
        members: [{ machineId: 'joining', installationId: 'joining-installation', state: 'joining' }] });
    const detail = { ...base, environment: { ...base.environment, controllerMachineId: 'controller',
        runtimeTargetLinkId: link.id, ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' } },
        runtimeTargetLink: link, memberVersions: {}, secretRevisions: [] };
    const input = { serverId, machineId: 'controller', environmentId: detail.environment.id, targetLinkId: link.id };
    const reference = { hostRead: 'deployments.health.edge', input };
    const proof = { environmentId: detail.environment.id, targetLinkId: link.id, targetLinkRevision: link.revision,
        machineId: 'edge', role: 'edge', status: 'up', observedAtMs: 100,
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
    homes.answer(serverId, actionPath, { select: async (body, request) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        const continuation = envelope.resourceContinuation;
        if (!continuation) throw new Error('Expected current edge Resource continuation');
        const reply = (result: unknown): HomeDomainAnswer => ({ body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
            return reply({ ok: true, resource: reference, contentType: 'application/json', ...content() });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
            return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return reply({ ok: true, closed: true });
        const subscriptionId = continuation.params.subscriptionId;
        return new Promise<HomeDomainAnswer>(resolve => {
            deliver = () => resolve(reply({ ok: true, status: 'event', event: {
                version: 1, kind: 'invalidated', subscriptionId, digest: content().digest,
            } }));
            const abort = () => resolve(reply({ ok: true, status: 'idle' }));
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) abort();
        });
    } });
    let feed: DeploymentEnvironmentHealthFeedV1 | undefined;
    const abort = new AbortController();
    const stop = environmentHealthObserver({ scope: { serverId, accountId: 'account' },
        isCurrent: () => true, onRetire: () => ({ dispose() {} }) })(
        { serverId, accountId: 'account' }, detail, value => { feed = value; }, { signal: abort.signal });
    try {
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'up' }] } }));
        await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
        const first = deliver;
        observation = null;
        first?.();
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'unknown' }] } }));
        await vi.waitFor(() => expect(deliver).not.toBe(first));
        const second = deliver;
        observation = proof;
        second?.();
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'up' }] } }));
        await vi.waitFor(() => expect(deliver).not.toBe(second));
        observation = { ...proof, targetLinkRevision: link.revision + 1 };
        deliver?.();
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'unknown' }] } }));
    } finally { abort.abort(); stop?.(); }
});
