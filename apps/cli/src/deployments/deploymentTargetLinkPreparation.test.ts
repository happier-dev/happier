import axios from 'axios';
import { readHomeRequestBody } from './homeRequestBody.testkit';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDeploymentAction } from '@happier-dev/protocol/actions/executor/deploymentAction';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { prepareProjectOpenReceiptPersistence } from '@/daemon/actionOperations/projectOpenReceiptPersistence';
import fastify from 'fastify';
import { createPlatformFailureNoticeFixture } from './platformFailureNotices.testkit';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentActionOperationRequestIdV1, DeploymentTargetLinkCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

afterEach(() => vi.restoreAllMocks());

it.each(['provider', 'artifact'] as const)('records a claimed created origin from %s Link input as linked', async form => {
    const fixture = createPlatformFailureNoticeFixture(true, true);
    const environment = await fixture.host.readEnvironment();
    const provider = { providerResourceOrigin: 'created' as const, credentialPrincipal: fixture.credentialPrincipal,
        providerIdentity: { providerAccountId: 'native-owner', providerResourceId: 'existing-native-id', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' as const } };
    const artifacts = createCredentialedAccountArtifactStore(fixture.host.credentials);
    const intent = { serverId: 'home', environmentId: environment.environment.id,
        expectedRevision: environment.environment.revision, requestKey: `claimed-origin-${form}`,
        targetId: 'platform', targetKind: 'example', role: 'runtime' as const, machines: [],
        source: { kind: 'plugin' as const, contribution: { pluginId: 'example.deploy', localId: 'platform' } } };
    const published = form === 'artifact' ? await artifacts.create({
        header: { kind: 'deployment-target-link.v1', title: 'Existing project' }, body: JSON.stringify(provider),
    }) : undefined;
    let associatedArtifactId: string | undefined;
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (request.method === 'GET') return { status: 200,
            data: { ok: true, environment: environment.environment, targetLinks: [] } };
        if (path === '/v1/deployments/targets/list') return { status: 200,
            data: { ok: true, items: [], nextCursor: null, coverage: 'complete' } };
        if (path.endsWith('/targets')) {
            const body = readHomeRequestBody(request.data);
            associatedArtifactId = typeof body.contentArtifactId === 'string' ? body.contentArtifactId : undefined;
            return { status: 200, data: { ok: true, environmentId: intent.environmentId,
                revision: 2, targetLinkId: 'linked-resource', targetLinkRevision: 1 } };
        }
        throw new Error(`Unexpected Home request: ${path}`);
    });
    const deps = createDaemonDeploymentActionDeps({ ...fixture.host, accountArtifacts: artifacts });
    const input = published ? { ...intent, contentArtifactId: published.artifactId,
        contentHeaderVersion: published.revision.headerVersion, contentBodyVersion: published.revision.bodyVersion }
        : { ...intent, provider, provisioned: true as const };
    expect(await deps.deploymentAction!('deployments.targets.link', input, {})).toMatchObject({ ok: true });
    expect(associatedArtifactId).toBeTruthy();
    const row = fixture.rows.get(associatedArtifactId!);
    expect(row).toBeDefined();
    const stored = decodePlainArtifactStoredContent(row!.body);
    expect(stored).toEqual({ body: JSON.stringify({ credentialPrincipal: provider.credentialPrincipal,
        providerIdentity: provider.providerIdentity, providerEnvironment: provider.providerEnvironment }) });
});

it.each(['upload', 'gitIntegration'] as const)('completes titled native Create (%s) through the same association owner as a retained Finish linking', async sourceMethod => {
    const fixture = createPlatformFailureNoticeFixture(true, true);
    const environment = await fixture.host.readEnvironment();
    const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } } as const;
    const input = DeploymentTargetLinkCreateIntentInputV1Schema.parse({ serverId: 'home',
        environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
        requestKey: 'create-and-associate', targetId: 'platform', targetKind: 'example', role: 'runtime', machines: [], source,
        title: 'Reviewed destination',
        providerCreate: { credentialRef: fixture.credentialPrincipal.target.account, credentialPrincipal: fixture.credentialPrincipal,
            providerAccountId: 'native-owner', providerEnvironment: { kind: 'production' }, resourceName: 'reviewed-name', sourceMethod,
            ...(sourceMethod === 'gitIntegration' ? { repository: { kind: 'github', deployment: 'https://github.com',
                repository: 'example/site' }, productionBranch: 'production' } : {}) } });
    const provider = { credentialPrincipal: fixture.credentialPrincipal, providerIdentity: {
        providerAccountId: 'native-owner', providerResourceId: 'created-native-id', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'created-name' } };
    let associations = 0;
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (request.method === 'GET') return { status: 200,
            data: { ok: true, environment: environment.environment, targetLinks: [] } };
        if (path === '/v1/deployments/targets/list') return { status: 200,
            data: { ok: true, items: [], nextCursor: null, coverage: 'complete' } };
        if (path.endsWith('/targets')) {
            associations++;
            return { status: 200, data: { ok: true, environmentId: input.environmentId,
                revision: 2, targetLinkId: 'created-link', targetLinkRevision: 1 } };
        }
        throw new Error(`Unexpected Home request: ${path}`);
    });
    const runtime = createOwnServerDeploymentRuntimeForHost({ ...fixture.host,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const deps = createDaemonDeploymentActionDeps({ ...fixture.host,
        accountArtifacts: createCredentialedAccountArtifactStore(fixture.host.credentials), runtime,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const plan = await deps.prepareHostReviewedChildren!({ actionId: 'deployments.targets.link', input, context: {} });
    if (!plan || 'ok' in plan) throw new Error('Expected native Create review');
    const native = fastify();
    let creates = 0;
    // Native execution is the external boundary; preparation, association and operation settlement stay real.
    native.post('/create', async () => { creates++; return { ok: true, result: provider }; });
    const context: ActionExecutorContext = { hostReviewedChild: createHostReviewedChildPortV1({
        actionId: 'deployments.targets.link', input, context: {}, plan,
        async execute() {
            return ActionExecuteResultSchema.parse((await native.inject({ method: 'POST', url: '/create' })).json());
        },
    }) };
    const operations = createHostActionOperationRuntime({ machineId: 'controller', serverId: 'home',
        resolveAccountId: async () => 'owner', generateOperationId: () => 'complete-create' });
    try {
        const result = await operations.runActionOperation({ actionId: 'deployments.targets.link', input, context,
            execute: context => executeDeploymentAction('deployments.targets.link', input, context, deps) });
        expect(result).toMatchObject({ ok: true, result: { ok: true, targetLinkId: 'created-link' } });
        expect(operations.store.get({ accountId: 'owner', machineId: 'controller' }, 'complete-create'))
            .toMatchObject({ state: 'succeeded', result: { ok: true, targetLinkId: 'created-link' } });
        expect(creates).toBe(1);
        expect(associations).toBe(1);
        expect([...fixture.rows.values()].map(row => decodePlainArtifactStoredContent(row.header)))
            .toContainEqual(expect.objectContaining({ kind: 'deployment-target-link.v1', title: input.title }));
        expect([...fixture.rows.values()].map(row => {
            const stored = decodePlainArtifactStoredContent(row.body);
            return stored && typeof stored === 'object' && 'body' in stored && typeof stored.body === 'string'
                ? JSON.parse(stored.body) : stored;
        })).toContainEqual({ ...provider, providerResourceOrigin: 'created' });
    } finally { await native.close(); }
});

describe('provider link preparation through the installed Action host', () => {
    it.each([
        ['plain', 'match'], ['e2ee', 'match'], ['plain', 'partial'], ['e2ee', 'partial'],
        ['plain', 'denied'], ['e2ee', 'denied'], ['plain', 'mode-mismatch'], ['e2ee', 'wrong-key'],
    ] as const)('compares another Source’s normalized link for two %s Team recipients (%s) before writing', async (mode, comparison) => {
        const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } } as const;
        const owner = { kind: 'team', teamId: 'shared-team' } as const;
        const current = createDeploymentEnvironmentHeaderV1({ owner });
        const existing = createDeploymentEnvironmentHeaderV1({ id: 'other-environment', projectSourceId: 'other-source', owner });
        const link = createDeploymentTargetLinkHeaderV1({ id: 'other-link', environmentId: existing.id,
            source, targetKind: 'platform', machines: [], members: [] });
        const providerIdentity = { providerAccountId: 'native-account', providerResourceId: 'native-resource', providerEnvironment: 'production' };
        const dataKey = randomBytes(32);
        const encode = (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, dataKey));
        const stored = { id: link.contentArtifactId, ownerAccountId: 'other-owner', access: 'view', encryptionMode: mode,
            publicAudience: 'none', header: encode({ kind: 'deployment-target-link.v1', title: 'Existing destination' }),
            body: encode({ body: JSON.stringify({ providerIdentity }) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 };
        const requests: string[] = [];
        const artifactWrites = vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('Duplicate preparation must not write'); });
        const envelopes: string[] = [];
        for (const recipient of ['first-recipient', 'second-recipient']) {
            const secret = randomBytes(32);
            const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: recipient })).toString('base64url')}.s`,
                encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey: secret, publicKey: x25519.getPublicKey(secret) } };
            const envelope = mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                dataKey, recipientPublicKey: x25519.getPublicKey(comparison === 'wrong-key' ? randomBytes(32) : secret), randomBytes }));
            envelopes.push(envelope);
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
                if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
                expect(path).toBe(`/v1/artifacts/${link.contentArtifactId}`);
                if (comparison === 'denied') return { status: 403, data: { error: 'artifact_access_denied' } };
                return { status: 200, data: { ...stored, dataEncryptionKey: envelope,
                    ...(comparison === 'mode-mismatch' ? { encryptionMode: 'e2ee' } : {}) } };
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(request.url!).pathname;
                requests.push(path);
                if (request.method === 'GET') return { status: 200, data: { ok: true, environment: current, targetLinks: [] } };
                if (path !== '/v1/deployments/targets/list') throw new Error('Duplicate preparation reached association');
                const body = readHomeRequestBody(request.data);
                expect(body.scope).toEqual(owner);
                return { status: 200, data: { ok: true, items: body.cursor ? [{ environment: existing, targetLink: link }] : [],
                    coverage: comparison === 'partial' ? 'partial' : 'complete', nextCursor: body.cursor ? null : 'next-page' } };
            });
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://link.test',
                machineId: 'controller', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                acquirePluginRuntimeRegistryLease: async () => { throw new Error('Link preparation cannot execute native effects'); } });
            const deps = createDaemonDeploymentActionDeps({ credentials, accountArtifacts: createCredentialedAccountArtifactStore(credentials),
                serverId: 'home', serverHttpBaseUrl: 'https://link.test', machineId: 'controller', runtime,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
            const result = await deps.deploymentAction('deployments.targets.link', { serverId: 'home', environmentId: current.id,
                expectedRevision: current.revision, requestKey: 'link-provider', source, targetId: 'platform', targetKind: 'platform',
                role: 'runtime', machines: [], provider: { credentialPrincipal: { kind: 'account', accountId: recipient,
                    purpose: { consumer: { pluginId: 'example.deploy', localId: 'platform' }, purpose: 'manage' },
                    target: { kind: 'account', account: { service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' } } },
                    providerIdentity, providerEnvironment: { kind: 'production' } } }, {});
            if (comparison === 'match') expect(result).toEqual({ ok: false, error: 'provider_scope_already_linked', environment: {
                serverId: 'home', projectSourceId: existing.projectSourceId, environmentId: existing.id }, targetLinkId: link.id });
            else {
                const error = comparison === 'partial' ? 'deployment_content_unavailable'
                    : comparison === 'denied' ? 'action_forbidden'
                        : comparison === 'mode-mismatch' ? 'artifact_account_mode_mismatch' : 'client_required';
                expect(result).toMatchObject({ ok: false, errorCode: error });
                expect(result).not.toHaveProperty('targetLinkId');
                expect(result).not.toHaveProperty('environment');
            }
        }
        if (mode === 'e2ee') expect(envelopes[0]).not.toEqual(envelopes[1]);
        expect(requests.filter(path => path === '/v1/deployments/targets/list')).toHaveLength(comparison === 'partial' ? 2 : 4);
        expect(artifactWrites).not.toHaveBeenCalled();
    });
});

it('refuses a runtime create before native effect when the admitted operation owner is unavailable', async () => {
    const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
    // HTTP is the external boundary; no Home/native request may precede durable operation admission.
    const http = vi.spyOn(axios, 'request').mockImplementation(async () => { throw new Error('Create escaped operation custody'); });
    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://link.test',
        machineId: 'controller', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        acquirePluginRuntimeRegistryLease: async () => { throw new Error('Create escaped operation custody'); } });
    const deps = createDaemonDeploymentActionDeps({ credentials, accountArtifacts: createCredentialedAccountArtifactStore(credentials),
        serverId: 'home', serverHttpBaseUrl: 'https://link.test', machineId: 'controller', runtime,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const result = await deps.deploymentAction('deployments.targets.link', {
        serverId: 'home', environmentId: 'environment', expectedRevision: 1, requestKey: 'create-once',
        targetId: 'runtime', role: 'runtime', targetKind: 'platform', machines: [],
        source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'runtime' } },
        providerCreate: { resourceName: 'reviewed-name', providerAccountId: 'native-account', providerEnvironment: { kind: 'production' },
            credentialRef: { service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' },
            credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
                consumer: { pluginId: 'example.deploy', localId: 'create' }, purpose: 'manage' }, target: { kind: 'account', account: {
                    service: { pluginId: 'example.deploy', localId: 'service' }, accountId: 'credential' } } } },
    }, {});
    expect(result).toMatchObject({ ok: false, errorCode: 'source_unavailable' });
    expect(http).not.toHaveBeenCalled();
});

it.each([false, true])('retains a native create acknowledgment before a failed Home follow-up without repeating unknown creates (unknown=%s)', async unknown => {
    const fixture = createPlatformFailureNoticeFixture(true, true);
    const { credentials } = fixture.host;
    const source = { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } } as const;
    const request = DeploymentTargetLinkCreateIntentInputV1Schema.parse({ serverId: 'home', environmentId: 'environment',
        expectedRevision: 1, requestKey: 'create-once', targetId: 'platform', targetKind: 'example', role: 'runtime', machines: [], source,
        providerCreate: { credentialRef: fixture.credentialPrincipal.target.account, credentialPrincipal: fixture.credentialPrincipal,
            providerAccountId: 'native-owner', providerEnvironment: { kind: 'production' }, resourceName: 'reviewed-name' } });
    const provider = { credentialPrincipal: fixture.credentialPrincipal, providerIdentity: {
        providerAccountId: 'native-owner', providerResourceId: 'returned-native-id', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'returned-name' } };
    const timeline: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), 'native-link-custody-'));
    const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), accountId: 'custodian', machineId: 'controller' });
    let interruptedSnapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null | undefined;
    const home = vi.spyOn(axios, 'request').mockImplementation(async () => {
        timeline.push('home');
        const retained = (await open()).retained;
        expect(retained).toHaveLength(1);
        expect(retained[0]).toMatchObject({ snapshot: { state: 'running', domainRef: {
            kind: 'deploymentTargetLink', serverId: 'home', environmentId: request.environmentId,
            requestKey: request.requestKey, purpose: 'create' }, result: {
            ok: false, error: 'deployment_link_incomplete', recovery: { provisioned: true, provider } } } });
        const interrupted = createHostActionOperationRuntime({ machineId: 'controller', serverId: 'home',
            resolveAccountId: async () => 'owner', projectOpenReceiptPersistence: await open() });
        expect(await interrupted.runActionOperation({ actionId: 'deployments.targets.link', input: request,
            context: { ...context, actionRequestId: 'retry-after-coordinator-loss' },
            execute: activeContext => executeDeploymentAction('deployments.targets.link', request, activeContext, deps),
        })).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown', effectAttempted: true });
        interruptedSnapshot = interrupted.store.get({ accountId: 'owner', machineId: 'controller' }, 'native-create-operation');
        timeline.push('durable-checkpoint');
        throw new Error('Home unavailable');
    });
    const runtime = createOwnServerDeploymentRuntimeForHost({ ...fixture.host,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const deps = createDaemonDeploymentActionDeps({ ...fixture.host, accountArtifacts: createCredentialedAccountArtifactStore(credentials), runtime,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const plan = await deps.prepareHostReviewedChildren!({ actionId: 'deployments.targets.link', input: request, context: {} });
    if (!plan || 'ok' in plan) throw new Error('Expected reviewed native create plan');
    const app = fastify();
    // Native child execution is an HTTP boundary; declarations, reviewed-child policy and host flow stay real.
    app.post('/child', async () => {
        expect((await open()).retained[0]).toMatchObject({ snapshot: {
            operationId: 'native-create-operation', requestId: readDeploymentActionOperationRequestIdV1('deployments.targets.link', request),
            domainRef: { kind: 'deploymentTargetLink', requestKey: request.requestKey, purpose: 'create' } } });
        timeline.push('native'); return unknown
        ? { ok: false, errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' }
        : { ok: true, result: provider }; });
    const context: ActionExecutorContext = {
        hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'deployments.targets.link', input: request, context: {}, plan,
            async execute(input, _context, actionId) {
                return ActionExecuteResultSchema.parse((await app.inject({ method: 'POST', url: '/child', payload: { actionId, input } })).json());
            } }),
    };
    try {
        const createOperations = async () => createHostActionOperationRuntime({ machineId: 'controller', serverId: 'home',
            resolveAccountId: async () => 'owner', generateOperationId: () => 'native-create-operation',
            projectOpenReceiptPersistence: await open() });
        const operations = await createOperations();
        const invoke = (owner: Awaited<ReturnType<typeof createOperations>>, actionRequestId: string) => owner.runActionOperation({
            actionId: 'deployments.targets.link', input: request, context: { ...context, actionRequestId },
            execute: activeContext => executeDeploymentAction('deployments.targets.link', request, activeContext, deps),
        });
        const result = await invoke(operations, 'first-transport');
        expect(timeline.filter(step => step === 'native')).toHaveLength(1);
        if (unknown) {
            expect(result).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
            expect((await open()).retained[0]?.snapshot.result).toBeUndefined();
            expect(home).not.toHaveBeenCalled();
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'deployment_link_incomplete', details: {
                recovery: { requestKey: request.requestKey, provisioned: true, provider },
                failure: { error: expect.stringContaining('target_link.environment_read') } } });
            expect(result).toMatchObject({ failureCause: { phase: 'deployment.home.request', errorClass: 'Error' } });
            expect(timeline).toContain('durable-checkpoint');
            expect(interruptedSnapshot).toMatchObject({ state: 'failed',
                error: { errorCode: 'action_outcome_unknown', effectAttempted: true },
                result: { ok: false, error: 'deployment_link_incomplete', recovery: { provisioned: true, provider } } });
            expect((await open()).retained[0]?.snapshot).toMatchObject({ state: 'failed', result: {
                ok: false, error: 'deployment_link_incomplete', recovery: { provisioned: true, provider },
                failure: { error: expect.stringContaining('target_link.environment_read') } } });
        }
        const restarted = await createOperations();
        const replay = await invoke(restarted, 'fresh-transport-after-restart');
        expect(replay).toMatchObject({ ok: false,
            errorCode: unknown ? 'action_outcome_unknown' : 'deployment_link_incomplete' });
        if (!unknown) expect(replay).toMatchObject({
            failureCause: { phase: 'deployment.home.request', errorClass: 'Error' },
            details: { recovery: { requestKey: request.requestKey, provisioned: true, provider },
                failure: { error: expect.stringContaining('target_link.environment_read') } },
        });
        expect(timeline.filter(step => step === 'native')).toHaveLength(1);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
