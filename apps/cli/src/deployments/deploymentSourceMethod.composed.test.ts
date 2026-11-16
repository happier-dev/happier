import axios from 'axios';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { DeploymentTargetLinkCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createRuntimeTargetForHost, prepareRuntimeTargetCreateForHost } from './runtimeTargetCreateForHost';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { prepareTargetLinkForHost } from './prepareTargetLinkForHost';
import { readDeploymentTargetV1 } from './targets/deploymentTargetCatalog';
import { createContributedDeploymentTargetForHost } from './targets/contributedDeploymentTargetForHost';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import * as vercel from '../../../../packages/plugins/deploy-vercel/src/index';
import { PLUGIN_MANIFEST as machineVercel } from '../../../../packages/plugins/machine-vercel/src/manifest';

afterEach(() => vi.restoreAllMocks());

it('retains a real Vercel Create choice through protected storage and omitted-method preparation', async () => {
    const boundary = createPlainAccountArtifactHttpBoundary();
    // The external Account-mode read is plain; the Artifact codec and storage path remain real.
    const artifacts = createAccountArtifactStore({ credentials: boundary.credentials, getAccountEncryptionMode: async () => 'plain' });
    const origin = 'https://source-method.test';
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.owner = { kind: 'account', accountId: 'owner' };
    environment.environment.controllerMachineId = 'machine-a';
    environment.content.definition = { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`,
        document: 'services: {}', profiles: [], services: [] };
    const account = { service: { pluginId: machineVercel.id, localId: 'vercel-account' }, accountId: 'profile' };
    const principal = { kind: 'account' as const, accountId: 'owner', purpose: {
        consumer: { pluginId: vercel.manifest.id, localId: 'project-create' }, purpose: 'deploy.manage' },
        target: { kind: 'account' as const, account } };
    const source = { kind: 'plugin' as const, contribution: { pluginId: vercel.manifest.id, localId: 'runtime' } };
    const request = DeploymentTargetLinkCreateIntentInputV1Schema.parse({ serverId: 'home',
        environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
        requestKey: 'upload-create', targetId: 'runtime', targetKind: 'vercel', role: 'runtime', machines: [], source,
        providerCreate: { credentialRef: account, credentialPrincipal: principal, providerAccountId: 'team_exact',
            providerEnvironment: { kind: 'production' }, resourceName: 'upload-app', sourceMethod: 'upload' } });
    const kit = await createPluginTestkit({ manifest: vercel.manifest, module: vercel, services: {
        http: createPluginHttpFixture({ async request() { return { status: 200, headers: {},
            body: new TextEncoder().encode(JSON.stringify({ id: 'prj_created', accountId: 'team_exact', name: 'upload-app' })) }; } }),
    } });
    const mounted = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: vercel.manifest, files: { [vercel.manifest.entrypoints!.daemon!]: 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: vercel.activate }) }],
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    const app = fastify();
    // The reviewed child crosses HTTP; Vercel's Action and HTTP result mapping remain real.
    app.post('/child', async req => {
        const { input } = req.body as { input: unknown };
        const invocation = getActionSpec('action.invoke').inputSchema.parse(input);
        return { ok: true, result: await kit.invokeAction(invocation.action.localId, StrictJsonValueSchema.parse(invocation.input)) };
    });
    try {
        const target = readDeploymentTargetV1(source, mounted.registry.contributes.deploymentTargets);
        const plan = prepareRuntimeTargetCreateForHost(request, target);
        const operations = createHostActionOperationRuntime({ machineId: 'machine-a', serverId: 'home', resolveAccountId: async () => 'owner' });
        const result = await operations.runActionOperation({ actionId: 'deployments.targets.link', input: request,
            context: { actionRequestId: 'create-upload', hostReviewedChild: createHostReviewedChildPortV1({
                actionId: 'deployments.targets.link', input: request, context: {}, plan,
                async execute(input) {
                    const response = await app.inject({ method: 'POST', url: '/child', payload: { input } });
                    expect(response.statusCode, response.body).toBe(200);
                    return ActionExecuteResultSchema.parse(response.json());
                },
            }) },
            execute: async context => {
                const created = await createRuntimeTargetForHost(request, target, context);
                if (!created.ok) return created;
                return { ok: true, result: created.recovery };
            },
        });
        expect.soft(result).toMatchObject({ ok: true, result: { provider: { sourceMethod: 'upload', providerResourceOrigin: 'created' } } });
        if (!result.ok) throw new Error(result.errorCode);
        const { DeploymentTargetLinkProviderIntentInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
        const intent = DeploymentTargetLinkProviderIntentInputV1Schema.parse(result.result);
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (path === '/v1/deployments/targets/list') return { status: 200, data: { ok: true, items: [], nextCursor: null, coverage: 'complete' } };
            throw new Error(`Unexpected Home request: ${path}`);
        });
        const prepared = await prepareTargetLinkForHost({ input: intent, context: {}, acknowledgedCreate: true }, {
            serverHttpBaseUrl: origin, artifacts, assertCurrent: async () => {},
            artifactAuthorization: () => async () => ({ Authorization: `Bearer ${boundary.credentials.token}` }),
            readMetadata: async () => ({ ok: true, environment: environment.environment, targetLinks: [] }),
        });
        if ('ok' in prepared) throw new Error('Expected a new provider association');
        const link = createDeploymentTargetLinkHeaderV1({ id: 'created-link', environmentId: prepared.environmentId,
            source, role: 'runtime', targetKind: 'vercel', machines: [], members: [], createdByAccountId: 'owner',
            contentArtifactId: prepared.contentArtifactId, contentHeaderVersion: prepared.contentHeaderVersion,
            contentBodyVersion: prepared.contentBodyVersion });
        const artifact = await runWithServerHttpBaseUrl(origin, () => artifacts.read(link.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        const reopened = readDeploymentTargetLinkArtifactV1(link, artifact);
        expect.soft(reopened).toMatchObject({ ok: true, content: { sourceMethod: 'upload', providerResourceOrigin: 'created' } });
        if (!reopened.ok) throw new Error('Expected reopened protected provider content');
        environment.environment.runtimeTargetLinkId = link.id;
        environment.targetLinks = [{ targetLink: link, content: reopened.content }];
        const targetHost = createContributedDeploymentTargetForHost({ credentials: boundary.credentials, serverId: 'home',
            machineId: 'machine-a', serverHttpBaseUrl: origin, readEnvironment: async () => environment,
            readReceipt: async () => { throw new Error('Preparation must not read a receipt'); },
            readPreparedDeploymentContent: async () => { throw new Error('Preparation authors a candidate'); },
            assertCurrent: async () => {}, resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => mounted.registry }),
            createCandidate: async () => ({ contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 }),
            writeTransition: async () => { throw new Error('Preparation must not write a transition'); },
        });
        const prepare = (sourceMethod?: 'upload' | 'gitIntegration') => targetHost.prepareCandidate({
            environmentId: environment.environment.id, targetLinkId: link.id, context: {}, ...(sourceMethod ? { sourceMethod } : {}),
        }, environment);
        expect.soft(await prepare()).toMatchObject({ ok: true, content: { sourceMethod: 'upload' } });
        expect(await prepare('gitIntegration')).toMatchObject({ ok: true, content: { sourceMethod: 'gitIntegration' } });
        // COR4-164 (#164): an agent Session's Home-minted root reaches preparation with the Session host's
        // projected same-Account custody (requesterAccountProjection), not a dispatched requester context.
        const sessionCarrier = (accountId: string) => {
            const carrier = { v: 1, token: 'session-root', binding: { accountId, actionId: 'deployments.deploy' } };
            Object.defineProperty(carrier, 'requesterAccountProjection', { value: { accountId }, enumerable: false });
            return carrier as unknown as NonNullable<Parameters<typeof targetHost.prepareCandidate>[0]['context']['externalActionExecutionAuthorization']>;
        };
        const ownerAccountId = readAccountIdFromToken(boundary.credentials.token);
        if (!ownerAccountId) throw new Error('Expected a credential owner');
        expect.soft(await targetHost.prepareCandidate({ environmentId: environment.environment.id, targetLinkId: link.id,
            context: { externalActionExecutionAuthorization: sessionCarrier(ownerAccountId) } }, environment))
            .toMatchObject({ ok: true, content: { sourceMethod: 'upload' } });
        // Another Account's carrier never borrows this host's credentials, and a bare root without custody stays refused.
        await expect(targetHost.prepareCandidate({ environmentId: environment.environment.id, targetLinkId: link.id,
            context: { externalActionExecutionAuthorization: sessionCarrier('someone-else') } }, environment))
            .rejects.toMatchObject({ code: 'action_forbidden' });
        const bare = sessionCarrier(ownerAccountId);
        await expect(targetHost.prepareCandidate({ environmentId: environment.environment.id, targetLinkId: link.id,
            context: { externalActionExecutionAuthorization: { ...bare } } }, environment))
            .rejects.toMatchObject({ code: 'action_forbidden' });
        delete reopened.content.sourceMethod;
        expect(await prepare()).toMatchObject({ ok: true, content: { sourceMethod: 'gitIntegration' } });
    } finally { await app.close(); await mounted.dispose(); await kit.dispose(); }
});

it('returns the retained Create branch outcome after the real host association succeeds', async () => {
    const boundary = createPlainAccountArtifactHttpBoundary();
    const artifacts = createAccountArtifactStore({ credentials: boundary.credentials, getAccountEncryptionMode: async () => 'plain' });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.owner = { kind: 'account', accountId: 'owner' };
    const account = { service: { pluginId: machineVercel.id, localId: 'vercel-account' }, accountId: 'profile' };
    const productionBranchOutcome = { status: 'defaultKept' as const, branch: 'main', requestedBranch: 'release',
        failureCause: { phase: 'deployment.provider.branch', errorClass: 'Error', errorCode: 'branch_missing', httpStatus: 400 } };
    const source = { kind: 'plugin' as const, contribution: { pluginId: vercel.manifest.id, localId: 'runtime' } };
    const provider = { credentialPrincipal: { kind: 'account' as const, accountId: 'owner', purpose: {
        consumer: { pluginId: vercel.manifest.id, localId: 'project-create' }, purpose: 'deploy.manage' },
        target: { kind: 'account' as const, account } },
        providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_created', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' as const }, sourceMethod: 'gitIntegration' as const,
        preparedNative: { projectName: 'created-app', productionBranchOutcome } };
    const requests: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        requests.push(path);
        if (path === '/v1/deployments/targets/list') return { status: 200,
            data: { ok: true, items: [], nextCursor: null, coverage: 'complete' } };
        if (path.endsWith('/targets')) return { status: 200, data: { ok: true,
            environmentId: environment.environment.id, revision: 2, targetLinkId: 'created-link', targetLinkRevision: 1 } };
        if (request.method === 'GET') return { status: 200, data: { ok: true, environment: environment.environment, targetLinks: [] } };
        throw new Error(`Unexpected Home request: ${path}`);
    });
    const host = { credentials: boundary.credentials, serverId: 'home', serverHttpBaseUrl: 'https://branch-result.test', machineId: 'machine-a' };
    const runtime = createOwnServerDeploymentRuntimeForHost({ ...host,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const deps = createDaemonDeploymentActionDeps({ ...host, accountArtifacts: artifacts, runtime,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
    const result = await deps.deploymentAction('deployments.targets.link', { serverId: 'home',
        environmentId: environment.environment.id, expectedRevision: environment.environment.revision, requestKey: 'branch-created',
        targetId: 'runtime', targetKind: 'vercel', role: 'runtime', machines: [], source, provider, provisioned: true }, {});
    expect(result, JSON.stringify({ result, requests })).toMatchObject({ ok: true, targetLinkId: 'created-link', productionBranchOutcome });
    expect(requests.filter(path => path.endsWith('/targets'))).toHaveLength(1);
    expect(boundary.rows.size).toBe(1);
});
