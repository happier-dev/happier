import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentChildRpcV1Schema, getActionSpec } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentChildExecutionProofV1, decodeDeploymentChildExecutionV1, encodeExternalActionResolvedTargetV1,
    verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { readDeploymentChildResult } from './deploymentChild';
import { registerDaemonDeploymentChildRpcHandler } from './daemonDeploymentChildRpc';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentReceiptArtifactHeaderV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readReviewedDeploymentDeployInput } from '@/api/externalActionExecutionAuthorization';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { HostRequesterExecutionIdentityInput, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

afterEach(() => vi.restoreAllMocks());

describe('installed deployment child ingress', () => {
    it.each([
        { kind: 'prepare', mismatch: 'none', physicalOwner: true, create: true, role: 'use', sourceOverride: 'sourceIntent', controllerRoot: true },
        { kind: 'prepare', mismatch: 'none', physicalOwner: false, role: 'use', sourceOverride: 'sourceIntent' },
        { kind: 'prepare', mismatch: 'none', physicalOwner: false, role: 'use', sourceOverride: 'sha' },
        { kind: 'prepare', mismatch: 'none', physicalOwner: true, role: 'use', sourceOverride: 'none' },
        { kind: 'prepare', mismatch: 'none', physicalOwner: true, role: 'manage', sourceOverride: 'sourceIntent' },
        { kind: 'prepare', mismatch: 'none', physicalOwner: true, role: 'use', sourceOverride: 'sourceIntent', controllerRoot: true },
        { kind: 'prepare', mismatch: 'none', physicalOwner: true, role: 'manage', sourceOverride: 'sourceIntent', preview: 'fork' },
        { kind: 'prepare', mismatch: 'none', physicalOwner: true, role: 'manage', sourceOverride: 'sourceIntent', preview: 'same repository' },
        { kind: 'member', mismatch: 'none', physicalOwner: true, rollback: true },
        ...(['target', 'home', 'secret', 'source'] as const).map(refusal => ({ kind: 'member' as const, mismatch: 'none' as const, physicalOwner: true, rollback: true, refusal })),
        { kind: 'member', mismatch: 'none', physicalOwner: false, rollback: true },
        { kind: 'review', mismatch: 'none', physicalOwner: true },
        { kind: 'review', mismatch: 'none', physicalOwner: false },
        { kind: 'review', mismatch: 'sha' }, { kind: 'build', mismatch: 'sha' }, { kind: 'member', mismatch: 'sha' },
        { kind: 'review', mismatch: 'pr selector' }, { kind: 'review', mismatch: 'implicit link' },
    ] as const)('binds the admitted source before native $kind work ($mismatch, owner=$physicalOwner, rollback=$rollback, refusal=$refusal, role=$role, source=$sourceOverride, controller=$controllerRoot, preview=$preview)', async scenario => {
        const { kind, mismatch } = scenario;
        const create = 'create' in scenario && scenario.create;
        const installedPlugins = create ? await createAdmittedPluginRuntimeFixture({
            controller: pluginReloadController, runtimeOptions: { pluginIds: [] },
        }) : undefined;
        const refusal = 'refusal' in scenario ? scenario.refusal : undefined;
        const physicalOwner = 'physicalOwner' in scenario && scenario.physicalOwner;
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = environment.targetLinks[0].targetLink;
        delete link.activeDeploymentId;
        link.state = 'configured';
        environment.environment.serverId = 'srv_archive_home';
        environment.environment.controllerMachineId = kind === 'prepare'
            ? 'controllerRoot' in scenario && scenario.controllerRoot ? 'controller' : 'environment-controller'
            : 'receiver';
        environment.environment.buildMachineId = 'receiver';
        environment.environment.runtimeTargetLinkId = mismatch === 'implicit link' ? 'different-runtime' : link.id;
        link.machines = ['receiver']; link.members = [{ machineId: 'receiver', installationId: 'receiver-installation', state: 'active' }];
        if (mismatch === 'implicit link') environment.targetLinks.push({ content: {}, targetLink: {
            ...link, id: 'different-runtime', predecessorTargetLinkId: link.id, contentArtifactId: 'different-link-content' } });
        receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, environmentId: environment.environment.id, targetLinkId: link.id,
            id: 'deployment', state: 'running', actionOperationId: 'operation', requestKey: 'event-A', contentArtifactId: 'candidate',
            ...(kind !== 'review' ? { acceptedExecution: { v: 1 as const,
                controller: { machineId: 'receiver', installationId: 'receiver-installation' },
                builder: { machineId: 'receiver', installationId: 'receiver-installation' }} } : {}) });
        if (receipt.content.sourceIntent.kind !== 'repository') throw new Error('Repository fixture required');
        const selected = { ...receipt.content.sourceIntent, sha: 'a'.repeat(40),
            ...(mismatch === 'pr selector' ? { pullRequestHead: { number: 42 } } : {}) };
        environment.environment.projectSourceId = selected.projectSourceId;
        environment.content.definition = { kind: 'repository', ref: 'main', compose: selected.compose };
        receipt.content.sourceIntent = mismatch === 'sha' ? { ...selected, sha: 'b'.repeat(40) }
            : mismatch === 'pr selector' ? { ...selected, pullRequestHead: { number: 43 } } : selected;
        receipt.content.machines = ['receiver']; receipt.content.buildMachineId = 'receiver';
        receipt.content.machineResults = [];
        if (kind !== 'review') {
            const native = { manifestFingerprint: 'reviewed-manifest', configInputDigests: [], physicalProjectName: 'reviewed-project',
                toolVersion: '2.40.1', services: ['app'], profiles: [] };
            receipt.content.ownServer = { approvedInputBasis: { v: 1, environmentId: environment.environment.id,
                environmentRevision: environment.environment.revision, targetLinkId: link.id, targetLinkRevision: link.revision,
                sourceIntent: receipt.content.sourceIntent, ...native, members: [{ machineId: 'receiver', installationId: 'receiver-installation' }],
                bindings: environment.content.bindings, ownServer: environment.content.ownServer,
                images: receipt.content.images, runtimeProjections: [{ ...native,
                    machineId: 'receiver', installationId: 'receiver-installation', platform: 'linux/amd64' }] } };
        }
        const template = structuredClone(environment);
        template.environment.id = 'preview-template';
        template.environment.contentArtifactId = 'preview-template-content';
        for (const row of template.targetLinks) row.targetLink.environmentId = template.environment.id;
        if ('preview' in scenario) {
            const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
            environment.environment.purpose = 'preview';
            environment.environment.previewTemplateEnvironmentId = template.environment.id;
            environment.environment.previewRepositoryId = 'source-repository';
            environment.environment.previewPullRequestId = '17';
            environment.environment.previewTargetLinkId = template.targetLinks[0].targetLink.id;
            environment.content.previewProvenance = { v: 1, templateEnvironmentId: template.environment.id,
                runtimeTargetLinkId: template.targetLinks[0].targetLink.id, repository, pullRequestId: '17', pullRequestNumber: 17,
                author: { id: 'contributor', login: 'contributor' }, headRepository: scenario.preview === 'fork'
                    ? { ...repository, repository: 'contributor/app' } : repository };
            template.content.previewTemplate = { v: 1, enabled: true, forkPreviews: 'off', repository,
                runtimeTargetLinkId: template.targetLinks[0].targetLink.id, domain: null, bindingBlueprints: [], data: [] };
        }
        const rollback = 'rollback' in scenario && scenario.rollback;
        if (rollback) {
            receipt.deployment.operation = 'rollback';
            receipt.deployment.rollbackOfDeploymentId = 'retained';
        }
        const deployRootInput = { serverId: environment.environment.serverId, environmentId: environment.environment.id,
            ...(mismatch === 'implicit link' ? {} : { targetLinkId: link.id }), requestKey: 'event-A',
            ...(mismatch === 'pr selector' ? { sourceIntent: selected } : { sha: selected.sha }) };
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind, actionId: rollback ? 'deployments.rollback' : 'deployments.deploy', machineId: 'receiver',
            installationId: 'receiver-installation', ...(kind === 'prepare' ? { expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision }
                : kind === 'review' ? {} : { deploymentId: 'deployment',
                actionOperationId: 'operation',
                ...(kind === 'member' ? { phase: 'activate', selectedDeploymentId: 'deployment' } : {}) }), input: {
                serverId: environment.environment.serverId, environmentId: environment.environment.id, targetLinkId: link.id,
                ...(kind === 'prepare' ? {
                    ...('sourceOverride' in scenario && scenario.sourceOverride === 'sourceIntent' ? { sourceIntent: selected } : {}),
                    ...('sourceOverride' in scenario && scenario.sourceOverride === 'sha' ? { sha: selected.sha } : {}),
                } : { expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
                    ...(rollback ? { deploymentId: 'retained' } : {}),
                    contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 }),
                requestKey: kind === 'prepare' ? 'private-deployment-request' : 'event-A' } });
        const channel = await createRequesterCurrentnessSocketHarness();
        // This source-binding fixture uses the exact Home identity; no saved
        // alias/profile enrollment exists at its installed-file boundary.
        const rootInput = kind === 'prepare' ? {
            serverId: environment.environment.serverId, projectSourceId: selected.projectSourceId, requestKey: 'catalog-allocation',
            name: 'Catalog app', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            definition: { from: 'catalogApp', templateRef: { sourceId: 'catalog', itemId: 'app', version: '1',
                ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } },
        } : rollback ? { serverId: environment.environment.serverId, environmentId: environment.environment.id,
            deploymentId: 'retained', requestKey: 'event-A' } : deployRootInput;
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode: 'plain', job, rootInput,
            ...(kind === 'prepare' ? { rootActionId: 'deployments.environments.create' as const } : {}),
            source: { id: selected.projectSourceId, revision: selected.sourceRevision },
            profileId: environment.environment.serverId });
        let prepared: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
        let nativeAcquisitions = 0;
        const effects: unknown[] = [];
        const stagedArtifacts: string[] = [];
        try {
            const projectRows = [createPlainProjectAccountRefRow({ id: 'checkout',
                serverId: environment.environment.serverId, machineId: 'receiver', rootPath: '/source/checkout',
                source: { sourceId: selected.projectSourceId, revision: selected.sourceRevision }, createdAtMs: 1 })];
            const artifact = (id: string, header: unknown, content: unknown) => ({ id, ownerAccountId: 'bob', access: 'owner',
                publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
                if (id === 'candidate') return { status: 200, data: artifact(id,
                    createDeploymentReceiptArtifactHeaderV1('Candidate', receipt.content), receipt.content) };
                if (id === template.environment.contentArtifactId) return { status: 200,
                    data: artifact(id, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Template' }, template.content) };
                if (id === environment.environment.contentArtifactId) return { status: 200,
                    data: artifact(id, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Environment' }, environment.content) };
                if (environment.targetLinks.some(item => item.targetLink.contentArtifactId === id)) return { status: 200,
                    data: artifact(id, { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Link' }, {}) };
                if (create && new URL(url).pathname.startsWith('/v1/artifacts/'))
                    return { status: 404, data: { error: 'not_found' } };
                throw new Error('Unexpected private source read');
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(request.url!).pathname;
                // Secret-launch admission is a protected read carried by POST.
                if (request.method && request.method.toUpperCase() !== 'GET'
                    && !path.endsWith('/secret-launch-admission')) {
                    effects.push(request);
                    throw new Error('No writes may precede source admission');
                }
                if (path.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
                if (refusal === 'source' && path.includes('/v1/projects/sources/')) return { status: 403, data: { error: 'forbidden' } };
                if (path.includes('/v1/projects/sources/')) return { status: 200, data: { ok: true, canManage: true,
                    source: { id: selected.projectSourceId, revision: selected.sourceRevision, name: 'Source', audience: [], createdByAccountId: 'bob',
                        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                            repository: { nameWithOwner: 'owner/source', cloneUrl: 'https://github.com/owner/source.git' }, protocol: 'https' } } } };
                if (refusal === 'home' && path.endsWith('/receipts/deployment')
                    || refusal === 'secret' && path.endsWith('/secret-launch-admission')) return { status: 403, data: { error: 'forbidden' } };
                if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
                if (path.endsWith(`/${template.environment.id}`)) return { status: 200, data: { ok: true,
                    environment: template.environment, targetLinks: template.targetLinks.map(item => item.targetLink) } };
                return { status: 200, data: path.includes('/receipts/') ? { ok: true, deployment: path.endsWith('/retained')
                    ? { ...receipt.deployment, id: 'retained', operation: 'deploy', state: 'succeeded', rollbackOfDeploymentId: undefined }
                    : receipt.deployment }
                    : { ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            });
            prepared = await fixture.prepare();
            if (!rollback && kind !== 'prepare') expect(await readReviewedDeploymentDeployInput({ authorization: prepared.authorization, envelope: fixture.envelope }))
                .toEqual(rootInput);
            // The installed credential boundary needs its Account subject for
            // the real secret-launch proof; Home HTTP verification is substituted.
            const installedToken = `header.${Buffer.from(JSON.stringify({ sub: physicalOwner ? 'bob' : 'ann' })).toString('base64url')}.signature`;
            const custodianAccountId = physicalOwner ? 'bob' : 'ann';
            const owner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => fixture.homeIdentityId,
                resolveHostIdentity: async () => ({ machineId: 'receiver', installationId: fixture.installed.installationId,
                    custodianAccountId }) });
            let identityReads = 0;
            let sourceContext: HostRequesterExecutionIdentityInput['actionContext'];
            let sourceIdentity: HostRequesterExecutionIdentity | undefined;
            const host = { machineId: 'receiver',
                async resolveRequesterIdentity(context: import('@happier-dev/protocol').ActionExecutorContext) {
                    identityReads++;
                    sourceContext = context;
                    const requester = await owner.resolveActionRequester!(context);
                    try { sourceIdentity = requester.identity; return requester.identity; } finally { await requester.dispose(); }
                },
                resolveRequesterRuntime: (ingress: Parameters<typeof resolveAdmittedRequesterAccountReadRuntime>[0]['ingress']) =>
                    resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: fixture.profileId, machineId: 'receiver',
                        installationId: fixture.installed.installationId, isInstalledCurrent: () => true }),
                resolveInstalledRuntime: async () => ({ serverId: fixture.profileId, machineId: 'receiver', accountId: custodianAccountId,
                    credentials: { ...(physicalOwner ? fixture.bob : fixture.ann), token: installedToken }, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
                    isCurrent: async () => refusal !== 'target' }),
                async acquirePluginRuntimeRegistryLease(): Promise<import('@/plugins/runtime/reload/controller').PluginRuntimeRegistryLease> {
                    nativeAcquisitions++;
                    throw Object.assign(new Error('Native acquisition boundary reached'), { code: 'sentinel_native_reached' });
                } };
            const handlers = new Map<string, RpcHandler>();
            registerDaemonDeploymentChildRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, host);
            const handler = handlers.get(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD)!;
            vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
                // Preserve the canonical Project-row protected-read boundary.
                if (new URL(String(url)).pathname.startsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/`))
                    return projectAccountRowsReadHttpResponse(projectRows, String(url), body);
                if (create && new URL(String(url)).pathname === '/v1/artifacts'
                    && body && typeof body === 'object' && 'id' in body && typeof body.id === 'string') {
                    stagedArtifacts.push(body.id);
                    return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
                }
                effects.push({ url, body });
                throw new Error('No Artifact staging may precede source admission');
            });
            const ingress = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
                callerInputAuthorization: prepared.authorization,
                originalActionEnvelope: fixture.envelope, workspaceSyncSourceExecution: fixture.packet,
                machineAdmission: { actorAccountId: 'bob', custodianAccountId, machineId: 'receiver',
                    installationId: fixture.installed.installationId, role: 'role' in scenario ? scenario.role : 'use' as const, encryptionMode: 'plain' as const },
                verifyMachineAdmissionCurrent: async () => true };
            const execute = () => {
                if (create || kind !== 'prepare') return handler(job, ingress);
                const context = buildActionExecutorContextForRpc({ ...ingress, actionId: job.actionId,
                    runtimeAccountId: 'bob', serverId: job.input.serverId, externalActionTarget: fixture.root.binding.target,
                    externalActionExecutionAuthorization: prepared!.authorization });
                const deps = createDaemonDeploymentActionDeps({ credentials: fixture.bob,
                    serverId: job.input.serverId, serverHttpBaseUrl: fixture.serverHttpBaseUrl, machineId: 'receiver',
                    resolveRequesterIdentity: host.resolveRequesterIdentity,
                    // Keep the admitted requester and source-role checks real;
                    // native acquisition is the OS/process boundary.
                    runtime: { async acquire() { throw new Error('Unexpected review acquisition'); },
                        async acquireCandidate() {
                            nativeAcquisitions++;
                            throw Object.assign(new Error('Native acquisition boundary reached'), { code: 'sentinel_native_reached' });
                        } } });
                const parentInput = projectNativeJsonValueForTransport(rootInput);
                if (!parentInput || typeof parentInput !== 'object' || Array.isArray(parentInput))
                    throw new Error('Environment creation object fixture required');
                return invokeHostReviewedChildV1({ parent: { actionId: 'deployments.environments.create', input: parentInput },
                    context, receivingAdmission: ingress.machineAdmission,
                    child: { action: 'deployments.deploy', role: 'template.deploy', input: projectNativeJsonValueForTransport(job.input) },
                    execute: (_input, childContext) => deps.prepareDeployCandidate({ ...job.input, context: childContext }) });
            };
            if (refusal) {
                const store = createActionOperationStore();
                const spec = getActionSpec('deployments.rollback');
                const runner = createActionOperationRunner({ store, generateOperationId: () => 'diagnostic-operation',
                    resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
                const scope = { accountId: 'bob', machineId: 'receiver' };
                await runner.observe({ actionId: spec.id, scope, requestId: 'diagnostic-rollback', input: rootInput,
                    execute: async () => ActionExecuteFailureSchema.parse(readDeploymentChildResult(await execute())) });
                const reason = refusal === 'target' ? 'installed_target_not_current'
                    : refusal === 'source' ? 'home_project_source_read_forbidden' : 'home_deployment_http_forbidden';
                expect(store.get(scope, 'diagnostic-operation')).toMatchObject({ state: 'failed',
                    error: { errorCode: 'action_forbidden', error: `action_forbidden (${reason})` } });
                expect(nativeAcquisitions).toBe(0);
                return;
            }
            if (kind === 'prepare' && scenario.role === 'use' && scenario.sourceOverride === 'sourceIntent'
                && !('controllerRoot' in scenario)) {
                expect(await handler(job, ingress)).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
                expect(nativeAcquisitions).toBe(0);
            }
            const result = await execute();
            if (kind === 'prepare') {
                const refused = scenario.role === 'use' && scenario.sourceOverride !== 'none'
                    && !('controllerRoot' in scenario && scenario.controllerRoot);
                const fork = 'preview' in scenario && scenario.preview === 'fork';
                expect(result).toMatchObject({ ok: false, errorCode: refused ? 'action_forbidden'
                    : fork ? 'deployment_access_denied' : 'sentinel_native_reached' });
                expect(nativeAcquisitions).toBe(refused || fork ? 0 : 1);
                expect(stagedArtifacts).toHaveLength(create ? 1 : 0);
                expect(effects).toEqual([]);
                return;
            }
            expect(result).toMatchObject({ ok: false,
                errorCode: mismatch !== 'none' ? 'target_mismatch' : physicalOwner ? 'sentinel_native_reached' : 'agent_isolation_unavailable' });
            if (physicalOwner && mismatch === 'none') {
                expect(sourceContext?.machineAdmission).toMatchObject({ actorAccountId: 'bob', custodianAccountId: 'bob',
                    machineId: 'receiver', installationId: fixture.installed.installationId });
                expect(sourceContext?.authority).toBe('present_user');
                expect(readRequesterAccountActionContext(sourceContext?.externalActionExecutionAuthorization)?.deploymentChild,
                    'admitted Action authorization retains the receiving child').toEqual(job);
                expect(readRequesterAccountActionContext(sourceContext?.callerInputAuthorization)?.deploymentChild,
                    'original caller authorization retains the receiving child').toEqual(job);
                expect(sourceIdentity).toMatchObject({ kind: 'owner_person' });
            }
            expect(identityReads).toBe(mismatch === 'none' ? 1 : 0);
            expect(nativeAcquisitions).toBe(mismatch === 'none' && physicalOwner ? 1 : 0);
        } finally { await prepared?.dispose(); await channel.close(); await installedPlugins?.dispose(); }
    });
    it.each([
        { encryptionMode: 'plain', kind: 'prepare' },
        { encryptionMode: 'e2ee', kind: 'prepare' },
        { encryptionMode: 'plain', kind: 'build' },
        { encryptionMode: 'e2ee', kind: 'build' },
        { encryptionMode: 'plain', kind: 'member' },
        { encryptionMode: 'e2ee', kind: 'member' },
        { encryptionMode: 'plain', kind: 'member', template: true },
        { encryptionMode: 'e2ee', kind: 'member', template: true },
    ] as const)('preserves exact $encryptionMode child custody and refusal codes for $kind transport ($template)', async scenario => {
        const { encryptionMode, kind } = scenario;
        const template = 'template' in scenario && scenario.template;
        const channel = await createRequesterCurrentnessSocketHarness();
        const fixture = await createDeploymentChildRequesterHarness({ encryptionMode,
            ...(template ? { rootActionId: 'deployments.templates.instantiate' as const, rootInput: {
                mode: 'apply', serverId: kind === 'member' && encryptionMode === 'e2ee' ? 'captured-profile' : 'srv_archive_home',
                machineId: 'controller', projectSourceId: 'source',
                templateRef: { sourceId: 'catalog', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
                environment: { kind: 'existing', environmentId: 'environment', expectedRevision: 1 },
                target: { kind: 'existing', targetLinkId: 'link', expectedRevision: 1, installationId: 'controller-installation' },
                destination: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}` },
                bindings: [], deploy: { requestKey: 'request' },
            } } : {}),
            job: DeploymentChildRpcV1Schema.parse({ v: 1, kind, actionId: 'deployments.deploy',
                machineId: 'receiver', installationId: 'receiver-installation',
                ...(kind === 'prepare' ? { expectedRevision: 1, expectedTargetLinkRevision: 1 }
                    : { deploymentId: 'deployment', actionOperationId: 'operation',
                        ...(kind === 'member' ? { phase: 'activate', selectedDeploymentId: 'selected-deployment' } : {}) }),
                input: { serverId: kind === 'member' && encryptionMode === 'e2ee' ? 'captured-profile' : 'srv_archive_home',
                    environmentId: 'environment', targetLinkId: 'link',
                    ...(kind === 'prepare' ? {} : { expectedRevision: 1, expectedTargetLinkRevision: 1,
                        requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 }) } }) });
        let prepared: Awaited<ReturnType<typeof fixture.prepare>> | undefined;
        let metadataReads = 0;
        let refusedReceiptReads = 0;
        let admissionReads = 0;
        try {
            // Home HTTP and the installed key/credential files are the system
            // boundaries; requester admission, signed packet and child stay real.
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: fixture.root.binding.accountId } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
                throw new Error('Unexpected passive child read');
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const address = new URL(request.url!);
                if (address.pathname === '/v1/deployments/receipts/unrelated') {
                    // Home's real lineage predicate is covered by the signed
                    // server admission suite. This HTTP boundary must return
                    // its refusal, not throw as if Home were unreachable.
                    const headers = new AxiosHeaders(Object.fromEntries(Object.entries(request.headers ?? {})));
                    expect(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe(fixture.root.token);
                    expect(headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe(fixture.job.actionId);
                    expect(headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER)).toBe(encodeExternalActionResolvedTargetV1(fixture.root.binding.target));
                    const encoded = headers.get(EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER);
                    const signature = headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER);
                    if (typeof encoded !== 'string' || typeof signature !== 'string') throw new Error('Missing signed child request');
                    const proof = decodeDeploymentChildExecutionV1(encoded,
                        String(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER) ?? ''));
                    if (!proof) throw new Error('Invalid signed child request');
                    expect(proof).toEqual(createDeploymentChildExecutionProofV1(fixture.packet));
                    expect(verifyExternalActionMachineRequestV1({ authorizationToken: fixture.root.token,
                        effectActionId: fixture.job.actionId, target: fixture.root.binding.target,
                        installationId: fixture.installed.installationId, requestId: fixture.root.binding.requestId,
                        deploymentChildExecution: proof, method: 'GET', path: address.pathname + address.search,
                        publicKey: fixture.receiver.publicKey, signature })).toBe(true);
                    expect(request.data).toBeUndefined();
                    refusedReceiptReads++;
                    // enableAuthentication maps a refused signed purpose to
                    // this connection-authentication response, not HTTP 403.
                    return { status: 401, data: { error: 'invalid_token' } };
                }
                expect(new URL(request.url!).pathname).toBe(kind !== 'prepare'
                    ? '/v1/deployments/receipts/deployment' : '/v1/deployments/environments/environment');
                metadataReads++;
                // A Home without this endpoint must report unsupported_action,
                // not a local authority refusal, and must never launch effects.
                return { status: 404, data: {} };
            });
            prepared = await fixture.prepare();
            const metadataRead = { method: 'GET', path: '/v1/deployments/environments/environment' };
            const http = prepared.authorization.requesterHttpProjection;
            if (!http) throw new Error('Admitted child HTTP projection is unavailable');
            expect(await http.createRequestHeaders({ ...metadataRead, effectActionId: fixture.job.actionId })).not.toBeNull();
            expect(await http.createRequestHeaders({ ...metadataRead, effectActionId: 'deployments.environments.get' })).toBeNull();
            const sourcePath = `/v1/projects/sources/source?serverId=${encodeURIComponent(fixture.homeIdentityId)}`;
            const sourceRead = { method: 'GET', path: sourcePath, effectActionId: fixture.job.actionId };
            // Home binds the canonical Source address to this child's current Environment.
            expect(await http.createRequestHeaders(sourceRead)).not.toBeNull();
            expect(await http.createRequestHeaders({ ...sourceRead, effectActionId: 'projects.sources.read' })).toBeNull();
            // Home owns the exact child purpose. The installed port signs every
            // address the admitted child names and never swaps in another credential.
            for (const address of [
                { method: 'GET', path: `/v1/deployments/environments/environment/domains?serverId=${encodeURIComponent(fixture.homeIdentityId)}` },
                { method: 'GET', path: '/v1/features/authenticated' },
                { method: 'POST', path: '/v1/some/unrelated/route', body: { unrelated: true } },
            ]) {
                const headers = await http.createRequestHeaders({ ...address, effectActionId: fixture.job.actionId });
                expect(headers?.Authorization, `${address.method} ${address.path}`).toBeUndefined();
                const signature = headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
                expect(signature, `${address.method} ${address.path}`).toEqual(expect.any(String));
                expect(verifyExternalActionMachineRequestV1({ authorizationToken: fixture.root.token,
                    effectActionId: fixture.job.actionId, target: fixture.root.binding.target,
                    installationId: fixture.installed.installationId, requestId: fixture.root.binding.requestId,
                    deploymentChildExecution: createDeploymentChildExecutionProofV1(fixture.packet), ...address,
                    publicKey: fixture.receiver.publicKey, signature: signature! })).toBe(true);
            }
            // Raw registrar callbacks are the same untyped transport boundary
            // as RpcHandlerRegistrar; the real handler parses every input.
            const handlers = new Map<string, RpcHandler>();
            registerDaemonDeploymentChildRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                machineId: fixture.job.machineId,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                resolveRequesterRuntime: ingress => resolveAdmittedRequesterAccountReadRuntime({ ingress,
                    serverId: fixture.profileId, machineId: fixture.job.machineId,
                    installationId: fixture.installed.installationId, isInstalledCurrent: () => true }),
                // Installed credential storage is separate from requester custody.
                resolveInstalledRuntime: async () => ({ serverId: fixture.profileId, machineId: fixture.job.machineId,
                    accountId: 'receiver-owner', credentials: fixture.ann, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
                    isCurrent: async () => true }),
                acquirePluginRuntimeRegistryLease: async () => { throw new Error('Unavailable environment must not acquire native execution'); },
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD);
            if (!handler) throw new Error('Installed child handler was not registered');
            const ingress = { signal: new AbortController().signal, callerInputAuthorization: prepared.authorization,
                originalActionEnvelope: fixture.envelope, workspaceSyncSourceExecution: fixture.packet,
                machineAdmission: { actorAccountId: fixture.root.binding.accountId, custodianAccountId: 'receiver-owner',
                    machineId: fixture.job.machineId, installationId: fixture.installed.installationId,
                    role: 'use' as const, encryptionMode },
                // This is Home's live network-verification boundary, not a local grant.
                verifyMachineAdmissionCurrent: async () => { admissionReads++; return true; } };
            if (kind !== 'prepare') {
                // whenBusy is deliberately absent from routing projection.
                // A lossy routing-only comparison must not replace full custody.
                await expect(handler({ ...fixture.job, input: { ...fixture.job.input, whenBusy: 'supersede' } }, ingress))
                    .resolves.toMatchObject({ ok: false, errorCode: 'deployment_child_binding_mismatch' });
                expect(metadataReads).toBe(0);
                const storage = createDaemonDeploymentActionDeps({ credentials: fixture.bob,
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                    serverId: fixture.job.input.serverId, serverHttpBaseUrl: fixture.serverHttpBaseUrl,
                    machineId: fixture.job.machineId,
                    runtime: createOwnServerDeploymentRuntimeForHost({ credentials: fixture.ann,
                        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                        credentialProfileId: fixture.profileId, serverId: fixture.job.input.serverId,
                        serverHttpBaseUrl: fixture.serverHttpBaseUrl, machineId: fixture.job.machineId,
                        acquirePluginRuntimeRegistryLease: async () => { throw new Error('A refused read cannot launch'); } }),
                });
                // A shape-valid receipt read reaches signed Home admission;
                // unrelated custody is denied there, not by a local ID list.
                await expect(storage.deploymentAction('deployments.receipts.get', {
                    serverId: fixture.job.input.serverId, environmentId: fixture.job.input.environmentId,
                    deploymentId: 'unrelated',
                }, { externalActionExecutionAuthorization: prepared.authorization }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden',
                        error: 'action_forbidden (home_signed_authorization_rejected)' });
                expect(metadataReads).toBe(0);
                expect(refusedReceiptReads).toBe(1);
                await expect(storage.deploymentAction('deployments.receipts.get', {
                    serverId: fixture.job.input.serverId, environmentId: 'other-environment', deploymentId: 'unrelated',
                }, { externalActionExecutionAuthorization: prepared.authorization }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden',
                        error: 'action_forbidden (home_signed_authorization_rejected)' });
                expect(metadataReads).toBe(0);
                expect(refusedReceiptReads).toBe(2);
                await expect(handler(fixture.job, ingress)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                expect(metadataReads).toBe(1);
                expect(admissionReads).toBe(1);
                return;
            }
            await expect(handler(fixture.job, ingress)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            expect(metadataReads).toBe(1);
            expect(admissionReads).toBe(1);
            await expect(handler({ ...fixture.job, installationId: 'replaced-installation' }, ingress))
                .resolves.toMatchObject({ ok: false, errorCode: 'target_mismatch' });
            for (const job of [
                { ...fixture.job, input: { ...fixture.job.input, targetLinkId: 'substituted-link' } },
                { ...fixture.job, expectedRevision: 2 },
            ]) await expect(handler(job, ingress)).resolves.toMatchObject({ ok: false, errorCode: 'deployment_child_binding_mismatch' });
            await expect(handler(fixture.job, { ...ingress, verifyMachineAdmissionCurrent: async () => false }))
                .resolves.toMatchObject({ ok: false, errorCode: 'deployment_child_admission_revoked' });
            await expect(handler(fixture.job, { ...ingress, verifyMachineAdmissionCurrent: async () => {
                throw Object.assign(new Error('Home unavailable'), { code: 'ECONNREFUSED' });
            } })).resolves.toMatchObject({ ok: false, errorCode: 'home_unreachable' });
            const stopped = new AbortController();
            stopped.abort();
            await expect(handler(fixture.job, { ...ingress, signal: stopped.signal }))
                .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            await expect(handler(fixture.job, { ...ingress, workspaceSyncSourceExecution: undefined }))
                .resolves.toMatchObject({ ok: false, errorCode: 'deployment_child_custody_missing' });
            expect(metadataReads).toBe(1);
        } finally { await prepared?.dispose(); await channel.close(); }
    });
});
