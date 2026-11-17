import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { projectArtifactBoundaryReadRow } from '@/dev/testkit/harness/artifactStoreBoundary';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentReceiptDetailV1,
    createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentPlatformContentV1Schema, DeploymentEnvironmentCollectionV1Schema } from '@happier-dev/deployment-protocol/v1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';
import { buildDeploymentAccountChangeV1, DeploymentDomainPageSuccessV1Schema, DeploymentEnvironmentListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    databaseActionLocalIdV1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { databaseActionMetadata, DATABASE_OPERATION_ACTION_INPUT_SCHEMAS_V1, type DatabaseDescriptorV1 } from '@happier-dev/database-protocol';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

// The statement's conditional approval reads its schema across the Machine RPC boundary.
const databaseSchemaRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: databaseSchemaRpc }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { createFrontDoorUiActionExecutor } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { useDeploymentEnvironmentChecks } = await import('./useDeploymentReads');
const { createPluginDeploymentCollectionHostReadStore } = await import('@/components/plugins/surfaces/pluginDeploymentCollectionHostRead');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { getStorage } = await import('@/sync/domains/state/storageStore');

/** The page's rows, whichever typed read returned them. */
const pageItems = (result: unknown) => (result as Readonly<{ value: Readonly<{ items: readonly unknown[] }> }>).value.items;

describe('deployment scoped read transport', () => {
    beforeEach(async () => { await homes.reset(); databaseSchemaRpc.mockReset(); });
    afterEach(() => standardCleanup());

    it('reads database size through the scoped semantic Actions using the receipt target and its Machine placement', async () => {
        const serverIdentityId = 'srv_database_size';
        const serverId = await homes.addHome({ name: 'Database size', serverUrl: 'https://database-size.test',
            serverIdentityId, accountId: 'account-owner', currentAccount: true, active: false });
        await homes.addHome({ name: 'Other Account', serverUrl: 'https://other-database-size.test',
            accountId: 'other-account', currentAccount: true, active: true });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId,
            controllerMachineId: 'controller', runtimeTargetLinkId: 'runtime-link' }) });
        const content = { ...detail.content, template: {
            templateRef: { sourceId: 'catalog', itemId: 'postgres', version: '1', ref: { kind: 'version' as const, version: '1' } },
            definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` }, services: ['postgres'],
            data: [{ service: 'postgres', engine: 'postgres' as const }] } };
        const environmentRef = { serverId, projectSourceId: detail.environment.projectSourceId, environmentId: detail.environment.id };
        const selected: DatabaseDescriptorV1 = { target: { kind: 'deployment_service', environment: environmentRef,
            targetLinkId: 'runtime-link', deploymentId: 'serving-receipt', serviceId: 'postgres', database: 'receipt-database' },
            engine: 'postgresql', label: 'Postgres', origin: { label: 'Active deployment' }, capabilities: [],
            placement: { serverId, accountId: 'account-owner', machineId: 'member', installationId: 'member-installation' } };
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try { await writer.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Database' }, body: JSON.stringify(content) }); }
        finally { writer.dispose(); }
        const stored = homes.artifacts(serverId).read(detail.environment.contentArtifactId);
        if (!stored) throw new Error('Expected the Account Environment Artifact');
        homes.answer(serverId, '/v1/deployments/data-services', { body: { ok: true, items: [{ environment: detail.environment }],
            artifacts: [projectArtifactBoundaryReadRow(stored)], nextCursor: null } });
        const listLocalId = databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1);
        const runLocalId = databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION,
            actionsById: Object.fromEntries([DATABASE_TARGETS_LIST_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1].map(id => {
                const localId = databaseActionLocalIdV1(id);
                const metadata = databaseActionMetadata[id];
                const machineId = id === DATABASE_TARGETS_LIST_ACTION_ID_V1 ? 'controller' : 'member';
                return [`${DATABASE_PLUGIN_ID_V1}/${localId}`, { ...PluginProjectedActionV2Schema.parse({
                    title: metadata.title, dangerLevel: metadata.dangerLevel, readOnly: metadata.readOnly,
                    placementBindings: metadata.placementBindings,
                    ...('confirmation' in metadata ? { confirmation: metadata.confirmation } : {}),
                    ...('confirmationWhen' in metadata ? { confirmationWhen: metadata.confirmationWhen } : {}),
                    id: localId, pluginId: DATABASE_PLUGIN_ID_V1,
                    scopes: ['global', 'machine'], surfaces: ['ui'], execution: { target: 'daemon' },
                    occurrenceId: `database:${localId}`, available: true }),
                    hostOrigin: { serverId, machineId, interactionEnabled: true, phase: 'current',
                        executionOrigin: { serverIdentityId, materializationRef: {
                            machineId, pluginId: DATABASE_PLUGIN_ID_V1, materializationId: 'database-materialization' } } } }];
            })) };
        const withdraw = publishCommittedAppShellPluginUiProjection(() => projection);
        databaseSchemaRpc.mockImplementation(async (request: { method: string }) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) throw new Error('Unexpected Machine RPC');
            return { ok: true, inputSchema: DATABASE_OPERATION_ACTION_INPUT_SCHEMAS_V1[DATABASE_STATEMENT_RUN_ACTION_ID_V1].jsonSchema };
        });
        const invocations: unknown[] = [];
        await answerExternalActionAccountForHome(homes, serverId, { actionId: 'action.invoke', tokenEpoch: 0,
            machineId: 'controller', installationId: 'controller-installation',
            additionalMachines: [{ machineId: 'member', installationId: 'member-installation' }],
            execute: (value, context) => {
                invocations.push(context.envelope);
                expect(context.requesterAccountContext.token).toBe(writer.credentials.token);
                const input = value as { action: { localId: string } };
                return input.action.localId === listLocalId ? { targets: [selected], completeness: { complete: true } }
                    : { ok: true, operation: 'statement.run', results: [{ columns: [{ name: 'size_bytes', nativeType: 'text', semanticType: 'text' }],
                        rows: [{ cells: [{ type: 'text', value: '4096' }] }], completeness: { complete: true } }] };
            } });
        try {
            const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' },
                isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
            const page = await createDeploymentReadTransport(lifetime).listDataServicePage!(lifetime.scope, {}, { signal: new AbortController().signal });
            expect(page, JSON.stringify(page.ok ? page.value.items[0]?.databaseSizes : page)).toMatchObject({ ok: true, value: { items: [{ databaseSizes: [{ service: 'postgres',
                deploymentId: 'serving-receipt', size: { status: 'available', bytes: 4096 } }] }] } });
            expect(invocations).toMatchObject([{ target: { kind: 'machine', machineId: 'controller' }, input: {
                action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: listLocalId }, input: { scope: { kind: 'environment', environment: environmentRef } } } },
            { target: { kind: 'machine', machineId: 'member' }, input: { action: { pluginId: DATABASE_PLUGIN_ID_V1, localId: runLocalId },
                input: { operation: 'statement.run', mode: 'read', target: selected.target } } }]);
            expect(homes.requests.filter(request => request.path === '/v1/actions/action.invoke').every(request => request.serverId === serverId)).toBe(true);
        } finally { withdraw(); }
    });

    it.each(['plain', 'e2ee'] as const)('projects %s live addresses from the serving receipt and current Domains in one batch, including latest commit facts', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Live address', serverUrl: 'https://live-address.test',
            accountId: 'account-owner', accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const active = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
            id: 'serving-old', contentArtifactId: 'serving-artifact', state: 'succeeded' }) });
        active.content.commitSubject = 'Older serving commit';
        const latest = createDeploymentReceiptHeaderV1({ id: 'latest-failed', contentArtifactId: 'failed-artifact',
            state: 'failed', requestedByAccountId: 'latest-requester' });
        const withoutSubject = { ...latest, contentArtifactId: 'without-commit-subject' };
        const unreadable = { ...latest, contentArtifactId: 'unreadable-latest-body' };
        const runtime = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: active.deployment.id });
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'current-domain', environmentId: detail.environment.id,
            targetLinkId: runtime.id, revision: 1, state: 'active', contentArtifactId: 'current-domain-artifact',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000 });
        const platform = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
            id: 'platform-serving', contentArtifactId: 'platform-artifact', state: 'succeeded' }),
            content: DeploymentPlatformContentV1Schema.parse({ sourceIntent: { kind: 'repository', projectSourceId: 'source-app',
                sourceRevision: 1, sha: 'b'.repeat(40) }, commitSubject: 'Repair worker startup',
                sourceMethod: 'gitIntegration', machines: [], images: [], machineResults: [], steps: [],
                platform: { credentialPrincipal: { kind: 'account', accountId: 'account-owner', purpose: {
                    consumer: { pluginId: 'happier.deployment-vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                    target: { kind: 'account', account: { service: { pluginId: 'happier.machine-vercel', localId: 'vercel' }, accountId: 'connected' } } },
                    providerIdentity: { providerAccountId: 'team', providerResourceId: 'project', providerEnvironment: 'production' },
                    providerEnvironment: { kind: 'production' }, targetLinkRevision: 1,
                    observation: { v: 1, state: 'succeeded', observedAtMs: 1000, urls: ['https://platform.example.test/'] } } }) });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try {
            for (const [id, kind, title, body] of [
                [detail.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, 'App', detail.content],
                [active.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Serving revision', active.content],
                [latest.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Failed revision', platform.content],
                [withoutSubject.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Uncaptured commit', { ...platform.content, commitSubject: undefined }],
                [unreadable.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Readable receipt header', {}],
                [platform.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, 'Platform revision', platform.content],
                [domain.contentArtifactId, 'deployment-domain.v1', 'Current Domain', { hostname: 'app.example.test',
                    target: { service: 'app', containerPort: 3000 } }],
            ] as const) await writer.createArtifactDocument({ artifactId: id, header: { kind, title }, body: JSON.stringify(body) });
        } finally { writer.dispose(); }
        const root = '/v1/deployments/environments';
        const base = DeploymentEnvironmentListResultV1Schema.parse({ ok: true, items: [detail.environment],
            currentDeployments: [latest], runtimeTargetLinks: [runtime], nextCursor: null });
        const respond = (overrides: object = {}) => homes.answer(serverId, root, { body: { ...base,
            servingDeployments: [active.deployment], liveAddressDomains: [domain], totalCount: 1, ...overrides } });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const transport = createDeploymentReadTransport(lifetime);
        const options = { signal: new AbortController().signal };
        const readItem = async () => {
            const page = await transport.listEnvironments(lifetime.scope, { includeTotal: true }, options);
            expect(page.ok, JSON.stringify(page)).toBe(true);
            if (!page.ok) throw new Error(page.failure.code);
            return DeploymentEnvironmentCollectionV1Schema.parse(page.value).items[0]!;
        };
        respond();
        const counted = await transport.listEnvironments(lifetime.scope, { includeTotal: true }, options);
        expect(counted).toMatchObject({ ok: true, value: { totalCount: 1 } });
        const before = homes.requests.length;
        expect(await readItem()).toMatchObject({ liveAddress: 'https://app.example.test/', currentDeployment: {
            id: latest.id, commitSubject: 'Repair worker startup', requestedByAccountId: 'latest-requester',
            source: { kind: 'repository', sha: 'b'.repeat(40), subject: 'Repair worker startup' },
        } });
        const reads = homes.requests.slice(before);
        expect(reads.filter(request => request.path === '/v1/artifacts/read').map(request => request.input)).toEqual([
            { artifactIds: [detail.environment.contentArtifactId, latest.contentArtifactId, active.deployment.contentArtifactId, domain.contentArtifactId] },
        ]);
        expect(reads.filter(request => request.path.startsWith(`${root}/`))).toEqual([]);
        const controller = createDeploymentReadControllerV1({ scope: lifetime.scope, transport });
        const collection = controller.acquireCollection({}, { mounted: true, visible: true, focused: true });
        try {
            await collection.refresh();
            expect(collection.getSnapshot().value?.items[0]).toHaveProperty('liveAddress', 'https://app.example.test/');
            expect(collection.getSnapshot().value?.items[0]?.currentDeployment).toMatchObject({
                commitSubject: 'Repair worker startup', requestedByAccountId: 'latest-requester',
                source: { kind: 'repository', sha: 'b'.repeat(40), subject: 'Repair worker startup' },
            });
            respond({ liveAddressDomains: [] });
            controller.invalidate({ environmentId: detail.environment.id });
            await collection.refresh();
            expect(collection.getSnapshot().value?.items[0]).toHaveProperty('liveAddress', null);
        } finally { collection.release(); controller.retire(); }
        respond({ currentDeployments: [withoutSubject] });
        expect((await readItem()).currentDeployment).toMatchObject({ commitSubject: null,
            requestedByAccountId: 'latest-requester', source: { kind: 'repository', sha: 'b'.repeat(40) } });
        respond({ currentDeployments: [unreadable] });
        const unavailable = (await readItem()).currentDeployment;
        expect(unavailable).toMatchObject({ title: 'Readable receipt header', requestedByAccountId: 'latest-requester' });
        expect(unavailable).not.toHaveProperty('commitSubject');
        expect(unavailable).not.toHaveProperty('source');
        respond({ servingDeployments: [{ ...active.deployment, contentArtifactId: 'missing-serving-content' }] });
        expect(await readItem()).not.toHaveProperty('liveAddress');
        respond({ liveAddressDomains: [{ ...domain, contentArtifactId: 'missing-domain-content' }] });
        expect(await readItem()).not.toHaveProperty('liveAddress');
        respond({ coverage: 'partial' });
        expect(await readItem()).toHaveProperty('liveAddress', 'https://app.example.test/');
        respond({ coverage: 'partial', liveAddressDomains: [] });
        expect(await readItem()).not.toHaveProperty('liveAddress');
        respond({ servingDeployments: [platform.deployment], liveAddressDomains: [],
            runtimeTargetLinks: [{ ...runtime, activeDeploymentId: platform.deployment.id }], coverage: 'partial' });
        expect(await readItem()).toHaveProperty('liveAddress', 'https://platform.example.test/');
        respond({ servingDeployments: [{ ...platform.deployment, state: 'failed' }], liveAddressDomains: [],
            runtimeTargetLinks: [{ ...runtime, activeDeploymentId: platform.deployment.id }] });
        expect(await readItem()).toHaveProperty('liveAddress', null);
        homes.answer(serverId, root, { body: base });
        expect(await readItem()).not.toHaveProperty('liveAddress');
        const uncounted = await transport.listEnvironments(lifetime.scope, {}, options);
        expect(uncounted.ok).toBe(true);
        if (uncounted.ok) expect(uncounted.value).not.toHaveProperty('totalCount');
        respond();
        const beforeExact = homes.requests.length;
        const exact = await transport.listEnvironments(lifetime.scope, { environmentIds: [detail.environment.id] }, options);
        expect(exact.ok).toBe(true);
        expect(pageItems(exact)[0]).not.toHaveProperty('liveAddress');
        expect(homes.requests.slice(beforeExact).filter(request => request.path === '/v1/artifacts/read').map(request => request.input))
            .toEqual([{ artifactIds: [detail.environment.contentArtifactId] }]);
    });

    it.each(['plain', 'e2ee'] as const)('opens %s Account Domain labels from the bundled page without detail fanout', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Domain labels', serverUrl: 'https://domain-labels.test',
            accountId: 'account-owner', accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const domain = { v: 1, id: 'domain-label', environmentId: detail.environment.id, targetLinkId: detail.targetLinks[0]!.targetLink.id,
            revision: 1, state: 'active', contentArtifactId: 'domain-label-artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
            createdByAccountId: 'account-owner', createdAtMs: 1000, updatedAtMs: 1000 };
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Private Environment title' }, body: JSON.stringify(detail.content) });
            await account.createArtifactDocument({ artifactId: domain.contentArtifactId,
                header: { kind: 'deployment-domain.v1', title: 'Application domain' }, body: JSON.stringify({ hostname: 'app.test',
                    target: { service: 'app', containerPort: 80 }, healthCheck: { path: '/', expectStatus: 200 } }) });
        } finally { account.dispose(); }
        const artifacts = [detail.environment.contentArtifactId, domain.contentArtifactId].map(id => {
            const stored = homes.artifacts(serverId).read(id);
            if (!stored) throw new Error('The Account writer did not create the page Artifact');
            return projectArtifactBoundaryReadRow(stored);
        });
        const response = DeploymentDomainPageSuccessV1Schema.parse({ ok: true, items: [{ domain, environment: detail.environment }],
            projectSources: [{ id: detail.environment.projectSourceId, name: 'Saved Project name' }], artifacts, nextCursor: null });
        homes.answer(serverId, '/v1/deployments/domains', { body: response });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const before = homes.requests.length;
        const page = await createDeploymentReadTransport(lifetime).listDomainPage!(lifetime.scope, {}, { signal: new AbortController().signal });
        expect(page).toMatchObject({ ok: true, value: { items: [{ title: 'Application domain', environmentTitle: 'Private Environment title',
            projectSourceName: 'Saved Project name', environment: detail.environment }], nextCursor: null } });
        const paths = homes.requests.slice(before).map(request => request.path.split('?')[0]);
        expect(paths.filter(path => path.startsWith('/v1/deployments/'))).toEqual(['/v1/deployments/domains']);
        expect(paths).not.toContain('/v1/artifacts/read');
    });

    it.each(['plain', 'e2ee'] as const)('reads %s Activity through the existing mode-aware receipt transport', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Activity', serverUrl: 'https://activity-deployments.test',
            accountId: 'account-owner', accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        const receipt = createDeploymentReceiptDetailV1();
        Object.assign(receipt.content, { actor: { actorKind: 'agent', sessionId: 'claude-session', onBehalfOf: { serverId: 'home', accountId: 'ana' } } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }, body: JSON.stringify(detail.content) });
            await account.createArtifactDocument({ artifactId: receipt.deployment.contentArtifactId,
                header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Deploy', steps: receipt.content.steps }, body: JSON.stringify(receipt.content) });
        } finally { account.dispose(); }
        const root = '/v1/deployments/environments';
        homes.answer(serverId, root, { body: { ok: true, items: [detail.environment], nextCursor: null } });
        homes.answer(serverId, `${root}/${detail.environment.id}`, { body: { ok: true, environment: detail.environment,
            targetLinks: detail.targetLinks.map(item => item.targetLink) } });
        homes.answer(serverId, `${root}/${detail.environment.id}/deployments`, {
            select: (_input, request) => {
                const query = new URL(request.url).searchParams;
                expect(Object.fromEntries(query)).toMatchObject({ actorAccountId: 'account-owner',
                    requestedAtFromMs: '1000', requestedAtToMs: '2000' });
                return { body: { ok: true, items: [receipt.deployment], nextCursor: null } };
            } });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'account-owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const { readDeploymentActivityPage } = await import('./deploymentActivityRead');
        const page = await readDeploymentActivityPage(lifetime, { limit: 10, projectSourceId: detail.environment.projectSourceId,
            kind: 'receipt', actorAccountId: 'account-owner', requestedAtFromMs: 1000, requestedAtToMs: 2000 }, [],
            { signal: new AbortController().signal });
        expect(page.unavailableSources).toEqual([]);
        expect(page).toMatchObject({ coverage: 'complete', nextCursor: null,
            items: [{ kind: 'receipt', receipt: { id: receipt.deployment.id,
                actor: { actorKind: 'agent', sessionId: 'claude-session', onBehalfOf: { serverId: 'home', accountId: 'ana' } } } }] });
    });

    it.each(['plain', 'e2ee'] as const)('opens the exact %s protected pending request without blanking the Environment', async mode => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(11);
        const serverId = await homes.addHome({ name: 'Pending request', serverUrl: 'https://pending-deployments.test', accountId: 'account-owner',
            accountEncryptionMode: mode, ...(mode === 'e2ee' ? { credentials: { token, secret: encodeBase64(secret, 'base64url') } } : {}) });
        if (mode === 'e2ee') homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing-fingerprint',
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { DeploymentPendingDeployIntentV1Schema } = await import('@happier-dev/protocol/deployments/storedAppInputV1');
        const { ArtifactEncryption } = await import('@/sync/encryption/artifactEncryption');
        const account = await captureLazyActionAccountContext(serverId);
        const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
        try {
            await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }, body: JSON.stringify(detail.content) });
            const intent = DeploymentPendingDeployIntentV1Schema.parse({ sourceIntent: { kind: 'repository',
                projectSourceId: detail.environment.projectSourceId, sourceRevision: 1, sha: 'b'.repeat(40) },
                requestKey: 'latest-request', targetLinkId: detail.environment.runtimeTargetLinkId, actionOperationId: 'latest-operation' });
            const resource = await account.readArtifactPublicLinkResource(detail.environment.contentArtifactId);
            if (!resource) throw new Error('Missing fixture resource');
            const pendingDeploy = mode === 'plain' ? { t: 'plain', v: intent } : { t: 'encrypted',
                c: await new ArtifactEncryption(resource.dataKey!).encryptHeader(intent) };
            const pendingAdmission = { requesterAccountId: 'account-owner', serverId, requestKey: intent.requestKey,
                actionOperationId: intent.actionOperationId, controller: { machineId: 'machine-a', installationId: 'installation-a' }, environmentRevision: 1 };
            const answer = (pending: unknown, admission: unknown = pendingAdmission) => homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`,
                { body: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink), pendingDeploy: pending, pendingAdmission: admission ?? undefined } });
            answer(pendingDeploy);
            const transport = createDeploymentReadTransport(account.accountLifetime);
            const controller = createDeploymentReadControllerV1({ scope: account.accountLifetime.scope, transport });
            const lease = controller.acquireEnvironment(detail.environment.id, { mounted: true, visible: true, focused: true });
            const before = homes.requests.filter(request => request.path === '/v1/artifacts/read').length;
            try {
                await lease.refresh();
                expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { content: detail.content,
                    pendingDeployment: { status: 'ready', intent, admission: pendingAdmission } } });
                expect(homes.requests.filter(request => request.path === '/v1/artifacts/read').length - before).toBe(1);
                answer(mode === 'plain' ? { t: 'encrypted', c: 'wrong-mode' } : { t: 'plain', v: intent });
                await lease.refresh();
                expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { content: detail.content,
                    pendingDeployment: { status: 'unavailable', reason: 'deployment_content_unavailable' } } });
                answer(pendingDeploy, { ...pendingAdmission, actionOperationId: 'other-operation' });
                await lease.refresh();
                expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { content: detail.content,
                    pendingDeployment: { status: 'unavailable', reason: 'deployment_conflict' } } });
                answer(pendingDeploy, null);
                await lease.refresh();
                expect(lease.getSnapshot()).toMatchObject({ status: 'ready', value: { content: detail.content,
                    pendingDeployment: { status: 'unavailable', reason: 'operation_unavailable' } } });
                answer(undefined);
                await lease.refresh();
                expect(lease.getSnapshot().value).not.toHaveProperty('pendingDeployment');
            } finally { lease.release(); controller.retire(); }
        } finally { account.dispose(); }
    });

    it('opens only requested data-link choices through one Artifact batch and retains their saved titles', async () => {
        const serverId = await homes.addHome({ name: 'Data choices', serverUrl: 'https://data-choices.test', accountId: 'alice' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const targetLink = createDeploymentTargetLinkHeaderV1({ role: 'data', targetKind: 'database', machines: [], members: [],
            source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
        const content = { providerIdentity: { providerAccountId: 'team', providerResourceId: 'internal-project-id', providerEnvironment: 'main' },
            providerEnvironment: { kind: 'custom' as const, id: 'main' },
            credentialPrincipal: { kind: 'account' as const, accountId: 'alice',
                purpose: { consumer: { pluginId: 'com.example.database', localId: 'projects-link' }, purpose: 'database' },
                target: { kind: 'account' as const, account: { service: { pluginId: 'com.example.database', localId: 'database' },
                    accountId: 'database-token' } } } };
        try {
            await account.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
                header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Customer database' }, body: JSON.stringify(content) });
            const before = homes.requests.length;
            const transport = createDeploymentReadTransport(account.accountLifetime);
            expect(await transport.readTargetLinks(account.accountLifetime.scope, [targetLink],
                { signal: new AbortController().signal })).toEqual({ ok: true,
                value: [{ targetLink, title: 'Customer database', content }] });
            expect(homes.requests.slice(before).filter(request => request.path === '/v1/artifacts/read').map(request => request.input))
                .toEqual([{ artifactIds: [targetLink.contentArtifactId] }]);
            expect(homes.requests.slice(before).filter(request => request.path.startsWith('/v1/deployments'))).toEqual([]);
        } finally { account.dispose(); }
    });

    it('keeps a later preview page in an all-pages receipt observation and does no hidden or unrelated receipt reads', async () => {
        const serverId = await homes.addHome({ name: 'Preview pages', serverUrl: 'https://preview-pages.test', accountId: 'alice', active: false });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        const controllerMachine = createMachineFixture({ id: 'preview-controller', active: true, presenceProtocolVersion: 1 });
        const machineScope = { sourceServerId: serverId, sourceAccountId: 'alice' };
        getStorage().getState().applyMachines([controllerMachine], true, machineScope);
        const rows = ['first', 'later'].map(id => {
            const environment = createDeploymentEnvironmentHeaderV1({ id, serverId, contentArtifactId: `${id}-content`,
                controllerMachineId: controllerMachine.id,
                owner: { kind: 'account', accountId: 'alice' } });
            const deployment = createDeploymentReceiptHeaderV1({ id: `${id}-receipt`, environmentId: id,
                contentArtifactId: `${id}-receipt-content`, state: 'running' });
            return { environment, deployment };
        });
        for (const { environment, deployment } of rows) {
            await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: environment.id }, body: '{}' });
            await account.createArtifactDocument({ artifactId: deployment.contentArtifactId,
                header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: deployment.id }, body: '{}' });
        }
        homes.answer(serverId, '/v1/deployments/environments', { select: (_body, request) => {
            const later = new URL(request.url).searchParams.has('cursor');
            const row = rows[later ? 1 : 0]!;
            return { body: { ok: true, items: [row.environment], currentDeployments: [row.deployment],
                nextCursor: later ? null : 'later' } };
        } });
        const store = createPluginDeploymentCollectionHostReadStore({ lifetime: account.accountLifetime });
        const entry = store.getEntry({ hostRead: 'deployments.environments.list', input: { serverId } });
        let release = entry.subscribe(() => {}, true);
        const value = () => JSON.parse(new TextDecoder().decode(entry.getSnapshot().value?.bytes)) as {
            items: { environment: { id: string }; currentDeployment: { state: string } | null }[];
            controllerAvailability: { machineId: string; state: string }[];
        };
        const push = (environmentId: string, deploymentId: string) => publishHomeAccountChange(serverId,
            [buildDeploymentAccountChangeV1({ environmentId, deploymentId, revision: 2 }).entityId], { changeKinds: ['account'] });
        const reads = () => homes.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments').length;
        try {
            await entry.refresh();
            expect(value().items.map(row => row.environment.id)).toEqual(['first', 'later']);
            const before = reads();
            push('unrelated', 'unrelated-receipt');
            expect(reads()).toBe(before);
            rows[1]!.deployment = { ...rows[1]!.deployment, state: 'succeeded', revision: 2 };
            push('later', 'later-receipt');
            await vi.waitFor(() => expect(value().items[1]?.currentDeployment?.state).toBe('succeeded'));
            expect(reads()).toBe(before + 2);
            const onlineDigest = entry.getSnapshot().value?.digest;
            expect(value().controllerAvailability).toEqual([{ machineId: controllerMachine.id, state: 'available' }]);
            getStorage().getState().applyMachineActivityUpdates([{ id: controllerMachine.id, active: false, activeAt: 2 }], machineScope);
            await vi.waitFor(() => expect(entry.getSnapshot().value?.digest).not.toBe(onlineDigest));
            const pausedDigest = entry.getSnapshot().value?.digest;
            expect(value().controllerAvailability).toEqual([{ machineId: controllerMachine.id, state: 'paused' }]);
            expect(reads()).toBe(before + 2);
            getStorage().getState().applyMachineActivityUpdates([{ id: controllerMachine.id, active: true, activeAt: 3 }], machineScope);
            await vi.waitFor(() => expect(entry.getSnapshot().value?.digest).toBe(onlineDigest));
            getStorage().getState().applyMachineActivityUpdates([{ id: controllerMachine.id, active: true, activeAt: 4 }], machineScope);
            expect(entry.getSnapshot().value?.digest).toBe(onlineDigest);
            release();
            release = () => {};
            const hiddenReads = reads();
            getStorage().getState().applyMachineActivityUpdates([{ id: controllerMachine.id, active: false, activeAt: 5 }], machineScope);
            expect(entry.getSnapshot().value?.digest).not.toBe(pausedDigest);
            push('later', 'later-receipt');
            expect(reads()).toBe(hiddenReads);
        } finally { release(); store.dispose(); account.dispose(); }
    });

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

    it.each(['plain', 'e2ee'] as const)('projects %s Environment headers and batches visible history facts', async mode => {
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
        detail.content.backup = { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'open' },
            occurrenceId: 'destination', config: { bucket: 'recovery' }, credentialBindings: [],
            sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
            ownership: { environmentId: detail.environment.id, prefix: 'backups' }, retention: { kind: 'keepEverything' } };
        // An App installed from a catalog keeps its private template provenance; the collection carries only the
        // listing pointer, so Installed draws the App's own mark (J50, QA-SHELL-1114).
        detail.content.template = { templateRef: { sourceId: 'apps', itemId: 'postgres', version: '1',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, definition: detail.content.definition, services: ['web'] } as never;
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
                backupConfigured: true, catalogTemplate: { sourceId: 'apps', itemId: 'postgres', version: '1' },
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
            .toEqual([{ artifactIds: [environmentHeader.contentArtifactId] }]);
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
            value: { items: [{ ...receiptHeader, title: 'aaaaaaa', steps: receiptDetail.content.steps },
                { ...otherReceipt, title: 'aaaaaaa', steps: receiptDetail.content.steps }] } });
        const collectionReads = homes.requests.filter(request => request.path === '/v1/artifacts/read').slice(artifactRequests);
        expect(collectionReads).toHaveLength(3);
        expect(collectionReads.map(request => request.input)).toEqual(expect.arrayContaining([
            { artifactIds: [environmentHeader.contentArtifactId, receiptHeader.contentArtifactId] },
            { artifactIds: [environmentHeader.contentArtifactId] },
            { artifactIds: [receiptHeader.contentArtifactId, otherReceipt.contentArtifactId] },
        ]));
        const controller = createDeploymentReadControllerV1({ scope, transport });
        const demand = { mounted: true, visible: true, focused: true };
        const collection = controller.acquireCollection({}, demand);
        const history = controller.acquireHistory(environmentHeader.id, {}, demand);
        try {
            await Promise.all([collection.refresh(), history.refresh()]);
            expect(collection.getSnapshot().value?.items[0]?.currentDeployment).toEqual({ ...receiptHeader,
                title: 'Exact revision A', steps: receiptDetail.content.steps,
                source: { kind: 'repository', sha: 'a'.repeat(40) }, commitSubject: null });
            expect(collection.getSnapshot().value?.items[0]).toHaveProperty('backupConfigured', true);
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
            .toEqual([{ artifactIds: [environmentHeader.contentArtifactId] }]);
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
        const unconfigured = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
            serverId, id: 'unconfigured', contentArtifactId: 'unconfigured-content' }) });
        unconfigured.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/app' },
            runtimeTargetLinkId: unconfigured.environment.runtimeTargetLinkId!, domain: null, bindingBlueprints: [], data: [] };
        const notNeeded = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({
            serverId, id: 'not-needed', contentArtifactId: 'not-needed-content' }) });
        notNeeded.content.backup = { notNeeded: true };
        const configurationWriter = await captureLazyActionAccountContext(serverId);
        try {
            for (const candidate of [unconfigured, notNeeded]) await configurationWriter.createArtifactDocument({
                artifactId: candidate.environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: candidate.content.name },
                body: JSON.stringify(candidate.content),
            });
        } finally { configurationWriter.dispose(); }
        // No receipts or backup history exist for this page. Configured membership is independent of runs.
        homes.answer(serverId, root, { body: { ok: true,
            items: [environmentHeader, unconfigured.environment, notNeeded.environment], nextCursor: null } });
        const beforeMembership = homes.requests.length;
        expect(await transport.listEnvironments(scope, {}, options)).toMatchObject({ ok: true, value: { items: [
            { environment: environmentHeader, backupConfigured: true, previewTemplateConfigured: false },
            { environment: unconfigured.environment, backupConfigured: false, previewTemplateConfigured: true },
            { environment: notNeeded.environment, backupConfigured: false, previewTemplateConfigured: false },
        ] } });
        const membershipRequests = homes.requests.slice(beforeMembership);
        expect(membershipRequests.filter(request => request.path.split('?')[0] === root)).toHaveLength(1);
        expect(membershipRequests.filter(request => request.path === '/v1/artifacts/read').map(request => request.input))
            .toEqual([{ artifactIds: [environmentHeader.contentArtifactId,
                unconfigured.environment.contentArtifactId, notNeeded.environment.contentArtifactId] }]);
        expect(membershipRequests.filter(request => request.path.includes('/backups')
            || request.path.startsWith(`${root}/`))).toEqual([]);
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
