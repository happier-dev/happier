import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptDetailV1,
    createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';


const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { createFrontDoorUiActionExecutor } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { useDeploymentEnvironmentChecks } = await import('./useDeploymentReads');

/** The page's rows, whichever typed read returned them. */
const pageItems = (result: unknown) => (result as Readonly<{ value: Readonly<{ items: readonly unknown[] }> }>).value.items;

describe('deployment scoped read transport', () => {
    beforeEach(() => homes.reset());
    afterEach(() => standardCleanup());

    it('consumes the existing selected native Service Resource as current health without another observer or probe', async () => {
        const serverIdentityId = 'srv_environment_health';
        const serverId = await homes.addHome({ name: 'Environment health', serverUrl: 'https://environment-health.test',
            serverIdentityId, accountId: 'account', currentAccount: true, active: false });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const base = createDeploymentEnvironmentDetailV1();
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: base.environment.id,
            machines: ['machine'],
            members: [{ machineId: 'machine', installationId: 'installation', state: 'active' }] });
        const detail = { ...base, environment: { ...base.environment, serverId, runtimeTargetLinkId: targetLink.id },
            targetLinks: [{ targetLink }], runtimeTargetLink: targetLink, memberVersions: {}, secretRevisions: [] };
        let state: 'down' | 'up' = 'down';
        let installationId = 'installation';
        let denied = false;
        const value = () => ({ kind: 'snapshot', services: [{ serviceId: 'app/web', name: 'Web', authority: 'project',
            lifecyclePurpose: 'deployment', generation: 'generation', state: state === 'up' ? 'healthy' : 'unhealthy',
            environmentId: detail.environment.id, capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
            health: { status: state, freshness: 'current', observedAtMs: state === 'up' ? 200 : 100,
                ...(state === 'down' ? { reason: 'not_ready' } : {}) },
            deployment: { deploymentId: 'current', installationId, service: { kind: 'deployment',
                machineId: 'machine', environmentId: detail.environment.id, environmentInstanceId: 'app', composeService: 'web', serviceId: 'app/web' } },
        }] });
        const content = () => { const bytes = Buffer.from(JSON.stringify(value())); return { bytesBase64: bytes.toString('base64'),
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }; };
        const machine = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({ body:
            await createMachineReadBatchResponseFixture(input, () => machine).json() }) });
        const actionId = 'machines.services.list';
        const actionPath = `/v1/actions/${actionId}`;
        homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            return { body: { v: 1, token: 'home-health-proof', binding: { serverIdentityId, accountId: 'account',
                authentication: { kind: 'account', tokenEpoch: 0 }, actionId, requestId: envelope.requestId,
                target: { kind: 'machine', machineId: 'machine' }, machineId: 'machine', installationId: 'installation',
                custodianAccountId: 'account', accountEncryptionMode: 'plain',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } } };
        } });
        const methods: string[] = [];
        let deliver: (() => void) | undefined;
        homes.answer(serverId, actionPath, { select: async (body, request) => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
            const continuation = envelope.resourceContinuation;
            if (!continuation) throw new Error('Expected the existing Services Resource continuation');
            expect(envelope.input).toMatchObject({ environmentId: detail.environment.id });
            methods.push(continuation.method);
            const reply = (result: unknown): HomeDomainAnswer => ({ body: { v: 1, actionId,
                requestId: envelope.requestId, execution: { ok: true, result } } });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) return reply(denied
                ? { ok: false, code: 'deployment_access_denied', reason: 'unavailable' }
                : { ok: true, resource: continuation.params.resource, contentType: 'application/json', ...content() });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) return reply({ ok: true,
                subscriptionId: continuation.params.subscriptionId, digest: content().digest });
            if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return reply({ ok: true, closed: true });
            return new Promise<HomeDomainAnswer>(resolve => {
                deliver = () => resolve(reply({ ok: true, status: 'event', event: { version: 1, kind: 'invalidated',
                    subscriptionId: continuation.params.subscriptionId, digest: content().digest } }));
                const abort = () => resolve(reply({ ok: true, status: 'idle' }));
                request.signal?.addEventListener('abort', abort, { once: true });
                if (request.signal?.aborted) abort();
            });
        } });
        const transport = createDeploymentReadTransport(lifetime);
        homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: {
            ok: true, environment: detail.environment, targetLinks: [targetLink],
        } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        await writer.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Health' }, body: JSON.stringify(detail.content) });
        writer.dispose();
        const controller = createDeploymentReadControllerV1({ scope: lifetime.scope, transport });
        const hook = await renderHook(() => useDeploymentEnvironmentChecks(controller, detail.environment.id,
            { mounted: true, visible: true, focused: true }));
        const feed = () => hook.getCurrent().feed;
        try {
            await vi.waitFor(() => expect(feed()).toMatchObject({ status: 'ready', environmentId: detail.environment.id,
                members: [{ machineId: 'machine', services: [{ serviceId: 'app/web', state: 'down', observedAt: 100, reason: 'not_ready' }] }] }));
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'ready', items: [{
                machineId: 'machine', services: [{ serviceId: 'app/web', state: 'down' }],
            }] }));
            const reads = homes.requests.length;
            await act(async () => controller.invalidate(Array.from({ length: 100 }, (_, i) => ({ environmentId: `peer-${i}`, deploymentId: `receipt-${i}` }))));
            expect(homes.requests).toHaveLength(reads);
            expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toHaveLength(1);
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            const firstDelivery = deliver;
            state = 'up'; deliver?.();
            await vi.waitFor(() => expect(feed()?.members[0]?.services[0]).toMatchObject({ state: 'up', observedAt: 200, reason: null }));
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'ready', items: [{ services: [{ state: 'up', observedAt: 200 }] }] }));
            expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toHaveLength(2);
            await vi.waitFor(() => expect(deliver).not.toBe(firstDelivery));
            const mismatchDelivery = deliver;
            installationId = 'replacement-installation'; deliver?.();
            await vi.waitFor(() => expect(feed()).toMatchObject({ status: 'unavailable', members: [{
                machineId: 'machine', installationId: 'installation', status: 'unavailable', services: [],
                failure: { code: 'target_mismatch' },
            }] }));
            await vi.waitFor(() => expect(hook.getCurrent().result).toMatchObject({ status: 'unavailable', reason: 'target_mismatch' }));
            expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toHaveLength(3);
            await vi.waitFor(() => expect(deliver).not.toBe(mismatchDelivery));
            denied = true; deliver?.();
            await vi.waitFor(() => expect(feed()).toMatchObject({ status: 'unavailable', members: [{
                failure: { code: 'deployment_access_denied' },
            }] }));
            await vi.waitFor(() => expect(hook.getCurrent().result).toEqual({ status: 'denied', items: [] }));
            expect(methods.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toHaveLength(4);
        } finally { await hook.unmount(); controller.retire(); await flushHookEffects(); }
        await vi.waitFor(() => expect(methods).toContain(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE));
        expect(homes.requests.some(request => request.path.includes('deployments.health'))).toBe(false);
    });

    it('rejects a supplied empty exact-ID Action vector before deployment networking; internal empty demand makes no HTTP request', async () => {
        const serverId = await homes.addHome({ name: 'Exact empty query', serverUrl: 'https://empty-deployments.test', accountId: 'alice' });
        const execute = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'alice' });
        const before = homes.requests.length;
        await expect(execute('deployments.environments.list', { serverId, environmentIds: [] }))
            .rejects.toMatchObject({ code: 'invalid_parameters' });
        expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/deployments')
            || request.path.startsWith('/v1/artifacts'))).toEqual([]);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const transport = createDeploymentReadTransport(account.accountLifetime);
            const beforeInternalEmpty = homes.requests.length;
            expect(await transport.listEnvironments(account.accountLifetime.scope, { environmentIds: [] },
                { signal: new AbortController().signal })).toEqual({ ok: true, value: { items: [], nextCursor: null } });
            expect(homes.requests.slice(beforeInternalEmpty)).toEqual([]);
        } finally { account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('keeps %s collection header-only and batches visible history contents for revision and failure facts', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Deployments', serverUrl: 'https://deployments-ui.test', accountId: 'account-owner',
            accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}),
        });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const receiptDetail = createDeploymentReceiptDetailV1();
        receiptDetail.deployment.state = 'running';
        receiptDetail.content.steps = [{ id: 'source', label: 'Source', state: 'succeeded' }];
        receiptDetail.content.machineResults = [{ machineId: receiptDetail.content.machines[0]!, installationId: 'installation',
            steps: [], activation: 'pending', health: 'unknown', incumbentStopped: true }];
        const environmentHeader = detail.environment;
        const targetHeader = detail.targetLinks[0]!.targetLink;
        // Retained custody has no body consumer on the selected Environment page.
        // Leave those Artifacts absent so an accidental body read also fails closed.
        const retainedLinks = Array.from({ length: 100 }, (_, index) => createDeploymentTargetLinkHeaderV1({
            id: `retained-${index}`, contentArtifactId: `retained-artifact-${index}`,
        }));
        const targetLinks = [...retainedLinks, targetHeader];
        const receiptHeader = receiptDetail.deployment;
        const otherReceipt = createDeploymentReceiptHeaderV1({ id: 'deployment-b', contentArtifactId: 'artifact-deployment-b' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try {
            for (const [artifactId, kind, title, content] of [[environmentHeader.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, detail.content.name, detail.content],
                [targetHeader.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, '', detail.targetLinks[0]!.content],
                [receiptHeader.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Exact revision A', receiptDetail.content],
                [otherReceipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Exact revision B', receiptDetail.content]] as const) {
                await writer.createArtifactDocument({ artifactId, header: { kind, title,
                    ...(artifactId === receiptHeader.contentArtifactId ? { steps: receiptDetail.content.steps } : {}) }, body: JSON.stringify(content) });
            }
        } finally { writer.dispose(); }
        const artifactRequests = homes.requests.filter(request => request.path === '/v1/artifacts/read').length;
        const root = '/v1/deployments/environments';
        const projectSources = [{ id: environmentHeader.projectSourceId, name: 'Saved Project, not a checkout folder' }];
        const runtimeTargetLink = { ...targetHeader, activeDeploymentId: receiptHeader.id };
        homes.answer(serverId, root, { body: { ok: true, items: [environmentHeader], currentDeployments: [receiptHeader],
            projectSources, runtimeTargetLinks: [runtimeTargetLink], nextCursor: null } });
        const controllerAvailability = { machineId: environmentHeader.controllerMachineId, state: 'paused' };
        homes.answer(serverId, `${root}/${environmentHeader.id}`, { body: { ok: true, environment: environmentHeader,
            targetLinks, controller: controllerAvailability } });
        homes.answer(serverId, `${root}/${environmentHeader.id}/deployments`, { body: { ok: true, items: [receiptHeader, otherReceipt], nextCursor: null } });
        homes.answer(serverId, `/v1/deployments/receipts/${receiptHeader.id}`, { body: { ok: true, deployment: receiptHeader, cancellable: false } });
        const transport = createDeploymentReadTransport(lifetime);
        const scope = { ...lifetime.scope, projectSourceId: environmentHeader.projectSourceId };
        const options = { signal: new AbortController().signal };
        expect(await transport.listEnvironments(scope, {}, options)).toMatchObject({ ok: true,
            value: { items: [{ environment: environmentHeader, title: detail.content.name,
                projectSourceName: projectSources[0]!.name, liveVersionTitle: 'Exact revision A',
                currentDeployment: { ...receiptHeader, title: 'Exact revision A', steps: receiptDetail.content.steps } }] } });
        const exactHeaderQuery = { environmentIds: [environmentHeader.id], machineId: undefined };
        const beforeExactHeaders = homes.requests.length;
        expect(await transport.listEnvironments(scope, exactHeaderQuery, options)).toMatchObject({ ok: true,
            value: { items: [{ environment: environmentHeader, title: detail.content.name }] } });
        const exactHeaderRequests = homes.requests.slice(beforeExactHeaders);
        const exactList = exactHeaderRequests.find(request => request.path.split('?')[0] === root);
        expect(new URLSearchParams(exactList?.path.split('?')[1]).getAll('environmentIds')).toEqual([environmentHeader.id]);
        expect(exactHeaderRequests.filter(request => request.path === '/v1/artifacts/read').map(request => request.input))
            .toEqual([{ artifactIds: [environmentHeader.contentArtifactId], projection: 'headers' }]);
        expect(exactHeaderRequests.filter(request => request.path.includes('/deployments/receipts/')
            || request.path === `${root}/${environmentHeader.id}/deployments`)).toEqual([]);
        const unexpectedEnvironment = createDeploymentEnvironmentHeaderV1({ ...environmentHeader,
            id: 'not-a-requested-owner', contentArtifactId: 'unrequested-owner-content' });
        homes.answer(serverId, root, { body: { ok: true, items: [environmentHeader, unexpectedEnvironment], nextCursor: null } });
        const beforeWrongPage = homes.requests.length;
        expect(await transport.listEnvironments(scope, exactHeaderQuery, options)).toMatchObject({ ok: false,
            failure: { code: 'invalid_response', retryable: false } });
        expect(homes.requests.slice(beforeWrongPage).filter(request => request.path === '/v1/artifacts/read')).toEqual([]);
        homes.answer(serverId, root, { body: { ok: true, items: [environmentHeader], currentDeployments: [receiptHeader], nextCursor: null } });
        expect(await transport.listHistory(scope, environmentHeader.id, {}, options)).toMatchObject({ ok: true,
            value: { items: [{ ...receiptHeader, title: 'aaaaaaa' }, { ...otherReceipt, title: 'aaaaaaa' }] } });
        const collectionReads = homes.requests.filter(request => request.path === '/v1/artifacts/read').slice(artifactRequests);
        expect(collectionReads.map(request => request.input)).toEqual([
            { artifactIds: [environmentHeader.contentArtifactId, receiptHeader.contentArtifactId], projection: 'headers' },
            { artifactIds: [environmentHeader.contentArtifactId], projection: 'headers' },
            { artifactIds: [receiptHeader.contentArtifactId, otherReceipt.contentArtifactId] },
        ]);
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const demand = { mounted: true, visible: true, focused: true };
        const collection = controller.acquireCollection({}, demand);
        const history = controller.acquireHistory(environmentHeader.id, {}, demand);
        try {
            await Promise.all([collection.refresh(), history.refresh()]);
            expect(collection.getSnapshot().value?.items[0]?.currentDeployment).toEqual({ ...receiptHeader,
                title: 'Exact revision A', steps: receiptDetail.content.steps });
            expect(history.getSnapshot().value?.items[0]?.title).toBe('aaaaaaa');
        } finally { collection.release(); history.release(); controller.retire(); }
        const beforeDetail = homes.requests.filter(request => request.path === '/v1/artifacts/read').length;
        expect(await transport.readEnvironment(scope, environmentHeader.id, options)).toEqual({ ok: true, value: {
            environment: environmentHeader, content: detail.content, targetLinks: targetLinks.map(targetLink => ({ targetLink })),
            controller: controllerAvailability,
        } });
        expect(homes.requests.filter(request => request.path === '/v1/artifacts/read').slice(beforeDetail).map(request => request.input))
            .toEqual([{ artifactIds: [environmentHeader.contentArtifactId] }]);
        expect(await transport.readReceipt(scope, environmentHeader.id, receiptHeader.id, options))
            .toEqual({ ok: true, value: { ...receiptDetail, cancellable: false,
                cancellationConsequence: { kind: 'service-down-until-rollback' } } });
        homes.answer(serverId, root, { body: { ok: true, items: [environmentHeader], currentDeployments: [otherReceipt],
            projectSources, runtimeTargetLinks: [runtimeTargetLink], nextCursor: null } });
        expect(await transport.listEnvironments(scope, {}, options)).toMatchObject({ ok: true,
            value: { items: [{ projectSourceName: projectSources[0]!.name, liveVersionTitle: null,
                currentDeployment: { id: otherReceipt.id, title: 'Exact revision B', steps: null } }] } });
        homes.answer(serverId, `${root}/${environmentHeader.id}`, { body: { ok: true,
            environment: { ...environmentHeader, contentBodyVersion: 2 }, targetLinks: [targetHeader] } });
        expect(await transport.readEnvironment(scope, environmentHeader.id, options)).toMatchObject({ ok: false,
            failure: { code: 'deployment_conflict', retryable: false } });

        // One missing or malformed Artifact must not blank valid siblings.
        const badEnvironment = createDeploymentEnvironmentHeaderV1({ ...environmentHeader,
            id: 'bad-environment', contentArtifactId: 'missing-environment-artifact' });
        const staleEnvironment = createDeploymentEnvironmentHeaderV1({ ...environmentHeader,
            id: 'stale-environment', contentArtifactId: otherReceipt.contentArtifactId });
        const badReceipt = createDeploymentReceiptHeaderV1({ id: 'bad-receipt', contentArtifactId: 'missing-receipt-artifact' });
        homes.answer(serverId, root, { body: { ok: true, items: [badEnvironment, environmentHeader, staleEnvironment],
            currentDeployments: [badReceipt], nextCursor: 'next-environment-page' } });
        const beforePartial = homes.requests.filter(request => request.path === '/v1/artifacts/read').length;
        const partial = await transport.listEnvironments(scope, {}, options);
        expect(partial).toMatchObject({ ok: true, value: {
            items: [{ environment: environmentHeader, currentDeployment: null }], coverage: 'partial', nextCursor: 'next-environment-page',
        } });
        expect(pageItems(partial)).toHaveLength(1);
        expect(homes.requests.filter(request => request.path === '/v1/artifacts/read').slice(beforePartial)).toHaveLength(1);
        const sharedEnvironment = createDeploymentEnvironmentHeaderV1({ ...environmentHeader, id: 'shared-environment' });
        homes.answer(serverId, root, { body: { ok: true, items: [environmentHeader, sharedEnvironment], nextCursor: null } });
        const beforeShared = homes.requests.filter(request => request.path === '/v1/artifacts/read').length;
        const shared = await transport.listEnvironments(scope, {}, options);
        expect(shared).toMatchObject({ ok: true, value: { items: [
            { environment: environmentHeader }, { environment: sharedEnvironment },
        ] } });
        expect(homes.requests.filter(request => request.path === '/v1/artifacts/read').slice(beforeShared).map(request => request.input))
            .toEqual([{ artifactIds: [environmentHeader.contentArtifactId], projection: 'headers' }]);
        homes.answer(serverId, `${root}/${environmentHeader.id}/deployments`, { body: { ok: true,
            items: [badReceipt, receiptHeader, { ...otherReceipt, contentBodyVersion: 2 }], nextCursor: 'next-history-page' } });
        const partialHistory = await transport.listHistory(scope, environmentHeader.id, {}, options);
        expect(partialHistory).toMatchObject({ ok: true, value: { items: [{ id: receiptHeader.id }], coverage: 'partial', nextCursor: 'next-history-page' } });
        expect(pageItems(partialHistory)).toHaveLength(1);
        const domain = { v: 1, id: 'valid-domain', environmentId: environmentHeader.id, targetLinkId: targetHeader.id,
            revision: 1, state: 'active', contentArtifactId: 'domain-artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
            createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000 };
        const domainWriter = await captureLazyActionAccountContext(serverId);
        try {
            await domainWriter.createArtifactDocument({ artifactId: domain.contentArtifactId,
                header: { kind: 'deployment-domain.v1', title: 'Application' }, body: JSON.stringify({ hostname: 'app.test',
                    target: { service: 'app', containerPort: 80 }, healthCheck: { path: '/', expectStatus: 200 } }) });
        } finally { domainWriter.dispose(); }
        homes.answer(serverId, `${root}/${environmentHeader.id}/domains`, { body: { ok: true, environmentId: environmentHeader.id,
            revision: 1, domains: [{ ...domain, id: 'missing-domain', contentArtifactId: 'missing-domain-artifact' }, domain,
                { ...domain, id: 'stale-domain', contentArtifactId: receiptHeader.contentArtifactId }], nextCursor: 'next-domain-page' } });
        const partialDomains = await transport.listDomains!(scope, environmentHeader.id, {}, options);
        expect(partialDomains).toMatchObject({ ok: true, value: { items: [{ domain: { id: domain.id } }], coverage: 'partial', nextCursor: 'next-domain-page' } });
        expect(pageItems(partialDomains)).toHaveLength(1);
        homes.answer(serverId, '/v1/artifacts/read', { status: 503, body: { error: 'artifact_content_unavailable' } });
        expect(await transport.listEnvironments(scope, {}, options)).toMatchObject({ ok: false,
            failure: { code: 'artifact_content_unavailable' } });
        expect(await transport.listHistory(scope, environmentHeader.id, {}, options)).toMatchObject({ ok: false,
            failure: { code: 'artifact_content_unavailable' } });
        expect(await transport.listDomains!(scope, environmentHeader.id, {}, options)).toMatchObject({ ok: false,
            failure: { code: 'artifact_content_unavailable' } });
        homes.answer(serverId, root, { body: { ok: false, error: 'deployment_access_denied' } });
        expect(await transport.listEnvironments(scope, {}, options)).toMatchObject({ ok: false,
            failure: { code: 'deployment_access_denied' } });
    });

    it('rejects a retired or foreign Account before any deployment read', async () => {
        const serverId = await homes.addHome({ name: 'Retired', serverUrl: 'https://retired-deployments.test', accountId: 'alice' });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'alice' }, isCurrent: () => false,
            onRetire: () => ({ dispose() {} }) };
        const transport = createDeploymentReadTransport(lifetime);
        expect(await transport.readEnvironment({ ...lifetime.scope, projectSourceId: 'source' }, 'environment',
            { signal: new AbortController().signal })).toMatchObject({ ok: false, failure: { code: 'action_account_scope_changed' } });
        expect(homes.requests.filter(request => request.path.startsWith('/v1/deployments'))).toHaveLength(0);
    });
});
