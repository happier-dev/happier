import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import nacl from 'tweetnacl';
import { $ZodError } from 'zod/v4/core';
import { decodeBase64, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { nativeCaddyImage, nativeCaddyProfile } from '@happier-dev/cli-common/machineSetup';
import { withSocketTempDir } from '../../../../../../cli/src/testkit/fs/tempDir';
import { materializeCaddyInitialConfigV1 } from '../../../../../../cli/src/deployments/targets/ownServer/caddyRouteMaterialization';
import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentDeployAdmissionInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema,
    type ActionExecutorContext } from '@happier-dev/protocol';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_REVIEWED_CHILD_HEADER,
    ExternalActionDaemonDispatchRequestSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { decodeReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentContentV1Schema, DeploymentEnvironmentContentV1Schema, DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentSocketHome } from '@/testkit/deploymentSocketHome.testkit.mjs';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createAutomationInTx } from '@/app/automations/automationCrudService';
import { projectDeploymentDomainHeader } from '@/app/deployments/deploymentDomainService';
import { projectDeploymentReceiptHeader } from '@/app/deployments/deploymentService';
import { withConfiguredDaemonTestHome } from '../../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonDeploymentActionDeps } from '../../../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0ControllerCredentials, readS0Installation } from '../../../../../../cli/src/deployments/deploymentDaemonIngress.testkit';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { adoptServerProfileHomeConnectionDescriptor } from '../../../../../../cli/src/server/serverProfiles';
import { configuration } from '../../../../../../cli/src/configuration';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createFilesystemEffectAdmission } from '../../../../../../cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import * as installationStore from '../../../../../../cli/src/daemon/identity/store';
import { resetInMemoryAccountSettingsContextForTests } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createOwnServerDockerBoundary } from '../../../../../../cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from '../../../../../../cli/src/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { resolveDeploymentSourcePathForHost, resolveOwnServerDeploymentIdentityForHost, resolveOwnServerDeploymentRootForHost } from '../../../../../../cli/src/deployments/targets/ownServer/paths';
import { createAdmittedPluginRuntimeFixture } from '../../../../../../cli/src/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '../../../../../../cli/src/plugins/runtime/reload/singleton';
import { createProjectAccountSnapshotMutation, withdrawActiveProjectAccountRowsSnapshot } from '../../../../../../cli/src/workspaces/projectAccountRows';
import { materializeWorkspaceRefForMachineRoot } from '../../../../../../cli/src/workspaces/workspaceRefsV1';
import { createCredentialedAccountArtifactStore } from '../../../../../../cli/src/api/artifacts/accountArtifactStore';
import { createCliApprovalsArtifactStore } from '../../../../../../cli/src/session/actions/approvals/artifactStore';
import { preparePreviewDomainForHost } from '../../../../../../cli/src/deployments/previewDomainForHost';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { bindProcessLogger, Logger, logger } from '../../../../../../cli/src/ui/logger';

afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

// A server process owns one Home identity; cases restart its isolated storage
// and create fresh Accounts without replacing that process-level identity.
const serverId = `srv_${randomUUID().replaceAll('-', '')}`;

it.each(['bare', 'retained-controller', 'planned-url', 'ordinary-planned-url'] as const)('deploys one exact reviewed preview without inherited secrets or data (%s)', async scenario => {
    const retainedController = scenario === 'retained-controller';
    const ordinaryPreview = scenario === 'ordinary-planned-url';
    const remoteBuilder = scenario === 'planned-url';
    const plannedDomain = remoteBuilder || ordinaryPreview;
    await withSocketTempDir(async caddyDirectory => {
    await withConfiguredDaemonTestHome({ prefix: 'fork-create-approval-', env: {
        HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
        HAPPIER_LOG_LEVEL: 'warn',
    } }, async () => {
        const httpActivity: Array<{ method: string; path: string; status: number; effectActionId?: string }> = [];
        const createAttempts: Array<Pick<ReturnType<typeof DeploymentEnvironmentCreateStorageInputV1Schema.parse>,
            'requestKey' | 'projectSourceId' | 'controllerMachineId' | 'buildMachineId' | 'contentArtifactId' | 'preview' | 'firstTargetLink'>> = [];
        const deployAttempts: Array<{ requestKey: string; actionOperationId: string;
            reviewedChild: { actionId: string; role: string; inputDigest: string } | null; inputDigest: string }> = [];
        const dispatchObservations: Array<{ actionId: string; rootActionId?: string; bindingPresent: boolean;
            nativeKind?: string; authoredDigestPresent: boolean; inputArm: string }> = [];
        const home = await createDeploymentSocketHome({ serverId, configureApp(app: FastifyInstance) {
            app.addHook('onSend', async (request, reply, payload) => {
                const path = request.url.split('?')[0]!;
                if (reply.statusCode >= 400 || path.startsWith('/v1/deployments/') || path.startsWith('/v1/artifacts')
                    || path.startsWith('/v1/projects/sources/') || path.startsWith('/v1/account/project-rows/')) {
                    const effectActionId = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
                    httpActivity.push({ method: request.method, path, status: reply.statusCode,
                        ...(typeof effectActionId === 'string' ? { effectActionId } : {}) });
                }
                if (request.method === 'POST' && path === '/v1/deployments/environments') {
                    const parsed = DeploymentEnvironmentCreateStorageInputV1Schema.safeParse(request.body);
                    if (parsed.success) {
                        const input = parsed.data;
                        createAttempts.push({ requestKey: input.requestKey, projectSourceId: input.projectSourceId,
                            controllerMachineId: input.controllerMachineId, buildMachineId: input.buildMachineId,
                            contentArtifactId: input.contentArtifactId, preview: input.preview, firstTargetLink: input.firstTargetLink });
                    }
                }
                if (request.method === 'POST' && /^\/v1\/deployments\/environments\/[^/]+\/deploy$/.test(path)) {
                    const parsed = DeploymentDeployAdmissionInputV1Schema.safeParse(request.body);
                    if (parsed.success) {
                        const { actionOperationId, ...input } = parsed.data;
                        const header = request.headers[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER];
                        const reviewedChild = typeof header === 'string' ? decodeReviewedActionChildHttpProofV1(header) : null;
                        deployAttempts.push({ requestKey: input.requestKey, actionOperationId,
                            reviewedChild: reviewedChild && { actionId: reviewedChild.actionId, role: reviewedChild.role,
                                inputDigest: reviewedChild.inputDigest },
                            inputDigest: computeActionInputApprovalDigestV1('deployments.deploy', input) });
                    }
                }
                return payload;
            });
        } });
        let ingress: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
        let secondIngress: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
        let mounted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        let caddyServer: ReturnType<typeof createServer> | undefined;
        let restoreMachineHome: (() => void) | undefined;
        let builderNativeHomeDir: string | undefined;
        const restoreLogger = bindProcessLogger(new Logger({ logFilePath: join(configuration.happyHomeDir, 'native-boundary.log'),
            allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false }));
        const caddyWrites: string[] = [];
        try {
            await adoptServerProfileHomeConnectionDescriptor({ descriptor: { v: 1, homeServerIdentityId: home.serverId,
                canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
                expectedProfileId: configuration.activeServerId, createIfMissing: true, observation: 'exact' });
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(() =>
                installationBoundary.getStore() ?? readS0Installation(home));
            let targetHome = home;
            let buildHome = home;
            if (retainedController || remoteBuilder) {
                // A second already paired Machine precondition, matching the real Home
                // fixture's publication codec and installation-key storage.
                const keys = nacl.sign.keyPair(), installationId = randomUUID();
                const machine = await db.machine.create({ data: { id: randomUUID(), accountId: home.accountId,
                    active: true, installationId, installationPublicKey: new Uint8Array(keys.publicKey),
                    metadata: encodePlainMachineStoredContent({ host: 'Retained preview controller', platform: 'linux',
                        happyCliVersion: 'test', homeDir: home.baseDir, happyHomeDir: home.baseDir }),
                    dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                } });
                buildHome = { ...home, machineId: machine.id, installationId, keys };
                if (retainedController) targetHome = buildHome;
                if (remoteBuilder) {
                    const controllerHomeDir = configuration.happyHomeDir;
                    const builderHomeDir = join(controllerHomeDir, 'builder-home');
                    builderNativeHomeDir = builderHomeDir;
                    await mkdir(builderHomeDir, { recursive: true, mode: 0o700 });
                    const descriptor = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir');
                    if (!descriptor) throw new Error('The native fixture requires an explicit CLI home boundary');
                    // The two genuine ingresses represent separate host filesystems.
                    // Keep their native roots distinct through the existing async installation boundary.
                    Object.defineProperty(configuration, 'happyHomeDir', { configurable: true, enumerable: descriptor.enumerable,
                        get: () => installationBoundary.getStore()?.installationId === installationId ? builderHomeDir : controllerHomeDir });
                    restoreMachineHome = () => { Object.defineProperty(configuration, 'happyHomeDir', descriptor); };
                }
            }
            const credentials = readS0ControllerCredentials(home);
            const checkout = join(configuration.happyHomeDir, 'fork-checkout');
            await mkdir(checkout, { recursive: true });
            const caddySocket = join(caddyDirectory, 'admin.sock');
            const caddyConfigPath = join(caddyDirectory, 'initial.json');
            const publicServer = 'observed-public';
            const caddyConfig = materializeCaddyInitialConfigV1({ adminSocket: '/run/domain-native/admin.sock',
                originListen: [`:${nativeCaddyProfile.portRequirement.containerPort}`],
                publicServer, publicListen: [':443'], publicHttpListen: [':80'] });
            if (plannedDomain) {
                await mkdir(caddyDirectory, { recursive: true });
                await writeFile(caddyConfigPath, JSON.stringify(caddyConfig));
                // Only the native Caddy HTTP boundary is substituted. Selection,
                // materialization, exact ETags, installation proofs and settlement stay real.
                caddyServer = createServer(async (request, response) => {
                    const segments = request.url!.split('/').filter(Boolean).map(decodeURIComponent);
                    const rootLength = segments[3] === 'servers' ? 5 : 3;
                    const read = (parts: readonly string[]): unknown => parts.reduce<unknown>((value, key) =>
                        value && typeof value === 'object' ? Reflect.get(value, key) : undefined, caddyConfig);
                    const rootParts = segments.slice(1, rootLength);
                    const root = read(rootParts);
                    if (!root || typeof root !== 'object') { response.writeHead(404).end(); return; }
                    const etag = `"${createHash('sha256').update(JSON.stringify(root)).digest('hex')}"`;
                    if (request.method === 'GET') {
                        response.setHeader('ETag', etag);
                        response.end(JSON.stringify(read(segments.slice(1)))); return;
                    }
                    if (request.headers['if-match'] !== etag) { response.writeHead(412).end(); return; }
                    if (request.method !== 'PUT') { response.writeHead(405).end(); return; }
                    const collection = read(segments.slice(1, -1));
                    if (!Array.isArray(collection)) { response.writeHead(404).end(); return; }
                    let body = '';
                    for await (const chunk of request) body += String(chunk);
                    const next: unknown = JSON.parse(body);
                    collection.splice(Number(segments.at(-1)), 0, next);
                    caddyWrites.push(request.url!);
                    response.end();
                });
                await new Promise<void>((resolve, reject) => {
                    caddyServer!.once('error', reject); caddyServer!.listen(caddySocket, resolve);
                });
            }
            const docker = await createOwnServerDockerBoundary(join(configuration.happyHomeDir, 'docker'), plannedDomain ? {
                nativeCaddy: { Id: 'c'.repeat(64), Name: '/observed-caddy', State: { Running: true },
                    Config: { Image: nativeCaddyImage, Labels: { 'dev.happier.machine-setup.recipe': 'caddy@1' },
                        Cmd: ['caddy', 'run', '--resume', '--config', '/etc/caddy/happier.json'] },
                    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Mounts: [
                        { Type: 'bind', Source: caddyDirectory, Target: '/run/domain-native' },
                        { Type: 'bind', Source: caddyConfigPath, Target: '/etc/caddy/happier.json' },
                    ] }, NetworkSettings: { Ports: { '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '443' }],
                        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }] }, Networks: {} } },
            } : { operatingSystem: 'Docker Desktop' });
            vi.stubEnv('PATH', `${join(configuration.happyHomeDir, 'docker')}${delimiter}${process.env.PATH ?? ''}`);
            const image = await docker.registerImage('app', 'approved-fork');
            await writeFile(join(checkout, 'compose.yaml'), JSON.stringify({ services: { app: { image: image.registryReference,
                ...(plannedDomain ? { expose: ['8080'], environment: { PREVIEW_LABEL: '${PREVIEW_LABEL}',
                    PRIMARY_URL: '${PRIMARY_URL}', DOMAIN_URL: '${DOMAIN_URL}' } } : {}),
            } } }));
            const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
            git('init', '--quiet'); git('config', 'user.name', 'Fork Deployment Fixture');
            git('config', 'user.email', 'fork@example.test');
            if (retainedController) await writeFile(join(checkout, 'reviewed-revision.txt'), 'previous-head\n');
            git('add', '.'); git('commit', '--quiet', '-m', 'Fork head');
            const previousHead = git('rev-parse', 'HEAD');
            if (retainedController) {
                await writeFile(join(checkout, 'reviewed-revision.txt'), 'reviewed-head\n');
                git('add', 'reviewed-revision.txt'); git('commit', '--quiet', '-m', 'Reviewed new head');
            }
            const exactHead = git('rev-parse', 'HEAD');
            const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
            const source = await inTx(tx => createProjectSourceInTx(tx, home.accountId, { serverId: home.serverId,
                name: 'Fork review fixture', requestKey: randomUUID(), repository: {
                    provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: repository.repository, cloneUrl: 'https://github.com/owner/app.git' }, protocol: 'https',
                } }));
            if (!source.ok) throw new Error(source.error);
            await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                const mutate = createProjectAccountSnapshotMutation({ credentials, serverId: home.serverId });
                expect(await mutate(snapshot => {
                    const buildWorkspace = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
                        serverId: home.serverId, machineId: buildHome.machineId, rootPath: checkout,
                        source: { sourceId: source.source.id, revision: source.source.revision },
                        nowMs: 1, createId: randomUUID,
                    });
                    // Each runtime renders its own checkout; remote image transfer
                    // does not provision a Source workspace on the runtime Machine.
                    const workspaceRefs = remoteBuilder ? materializeWorkspaceRefForMachineRoot(buildWorkspace.workspaceRefs, {
                        serverId: home.serverId, machineId: home.machineId, rootPath: checkout,
                        source: { sourceId: source.source.id, revision: source.source.revision },
                        nowMs: 1, createId: randomUUID,
                    }).workspaceRefs : buildWorkspace.workspaceRefs;
                    return { ...snapshot, workspaceRefs: [...workspaceRefs] };
                })).toMatchObject({ status: 'applied' });
            });
            const sample = createDeploymentEnvironmentDetailV1();
            const templateId = randomUUID(), runtimeId = randomUUID(), templateDomainId = randomUUID();
            const templateDomainContent = { hostname: '*.preview.test', target: { service: 'app', containerPort: 8080, path: '/app' } };
            const safeBindings = [
                { purpose: 'variable', phase: 'runtime', name: 'PREVIEW_LABEL', source: { kind: 'value', value: 'reviewed-public-value' } },
                { purpose: 'variable', phase: 'runtime', name: 'PRIMARY_URL', source: { kind: 'deploymentFact', fact: 'primaryUrl' } },
                { purpose: 'variable', phase: 'runtime', name: 'DOMAIN_URL', source: { kind: 'deploymentFact', fact: 'domainUrl', domainId: templateDomainId } },
            ] as const;
            const templateRef = { sourceId: 'apps', itemId: 'postgresql', version: '17',
                ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } };
            const content = DeploymentEnvironmentContentV1Schema.parse({ ...sample.content,
                bindings: ordinaryPreview ? [] : [createDeploymentSecretVariableBindingV1({ name: 'PARENT_SECRET', phase: 'runtime',
                    resourceId: 'parent-secret', resourceRevision: 1 })],
                template: ordinaryPreview ? undefined : { templateRef, services: ['database'],
                    definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` },
                    data: { engine: 'postgres', service: 'database', logicalBackup: { adapter: 'postgres-v1', database: 'DB_NAME' } },
                    volumes: [{ id: 'parent-data', service: 'database', target: '/var/lib/postgresql/data',
                        persistent: true, backup: true, consistency: 'logicalDump' }] },
                definition: { kind: 'repository', ref: 'main', compose: {
                path: 'compose.yaml', profiles: [], services: [] } }, previewTemplate: {
                v: 1, enabled: true, forkPreviews: 'approveEachCommit', repository, runtimeTargetLinkId: runtimeId,
                domain: plannedDomain ? { domainId: templateDomainId, templateSlug: 'app', hostnamePattern: 'pr-{number}-{template-slug}' } : null, bindingBlueprints: ordinaryPreview ? safeBindings : [
                    createDeploymentSecretVariableBindingV1({ name: 'BLUEPRINT_SECRET', phase: 'runtime', resourceId: 'blueprint-secret', resourceRevision: 1 }),
                    { purpose: 'variable', phase: 'runtime', name: 'PARENT_DATABASE', source: { kind: 'reference',
                        environmentId: 'production-database', export: 'database', via: 'privateNetwork' } },
                    ...(plannedDomain ? safeBindings : []),
                ], data: ordinaryPreview ? [] : [{ kind: 'managed', dataTargetLinkId: 'production-database', ownership: 'happierManaged',
                    parentBranchRef: { providerProjectId: 'project', branchId: 'production' } },
                    { kind: 'template', templateRef, dataExportNames: ['DATABASE_URL'], connectTo: { service: 'app' } }],
            } });
            const template = await db.deploymentEnvironment.create({ data: { id: templateId,
                projectSourceId: source.source.id, createdByAccountId: home.accountId,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: home.machineId, buildMachineId: plannedDomain ? buildHome.machineId : home.machineId,
                ...await home.createContentArtifact({ body: JSON.stringify(content) }, 'deployment-environment.v1') } });
            const templateRuntime = await db.deploymentTargetLink.create({ data: { id: runtimeId, environmentId: template.id,
                createdByAccountId: home.accountId, role: 'runtime', state: 'configured', sourceKind: 'host',
                hostTargetId: 'own-server', targetKind: 'ownServer',
                ...await home.createContentArtifact({ body: JSON.stringify(sample.targetLinks[0]!.content) }, 'deployment-target-link.v1'),
                machines: { create: [{ machineId: home.machineId, installationId: home.installationId, position: 0, state: 'active' }] },
            } });
            await db.deploymentEnvironment.update({ where: { id: template.id }, data: { runtimeTargetLinkId: runtimeId } });
            if (plannedDomain) await db.deploymentDomain.create({ data: { id: templateDomainId, environmentId: template.id,
                targetLinkId: runtimeId, state: 'active', createdByAccountId: home.accountId,
                ...await home.createContentArtifact({ body: JSON.stringify(templateDomainContent) }, 'deployment-domain.v1') } });
            // Establish the saved preview admission prerequisite through the same
            // definition writer as template enrollment; this journey supplies the PR input directly.
            const admission = await inTx(tx => createAutomationInTx(tx, { accountId: home.accountId,
                serverIdentityId: home.serverId, input: {
                    automationId: randomUUID(), name: 'Fork preview admission', enabled: true, triggers: [],
                    assignments: [{ machineId: home.machineId, enabled: true }],
                    executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null,
                        deploymentEnvironment: { serverId: home.serverId, projectSourceId: source.source.id,
                            environmentId: template.id, previewRole: 'preview_admission' },
                        workflow: { t: 'plain', v: { workspace: { directory: checkout },
                            executionTarget: { kind: 'detached_run' },
                            deploymentPreview: { serverId: home.serverId, environmentId: template.id },
                            inlineDefinition: { version: 1, inputs: [], defaults: {}, blocks: [{
                                kind: 'action', id: 'preview-source', actionId: 'deployments.environments.get', input: {
                                    serverId: { kind: 'literal', value: home.serverId },
                                    environmentId: { kind: 'literal', value: template.id },
                                },
                            }] } } },
                    },
                },
            }));
            expect(await db.automation.findUnique({ where: { id: admission.id }, select: {
                deploymentEnvironmentId: true, deploymentPreviewRole: true, enabled: true, deletedAt: true,
            } })).toEqual({ deploymentEnvironmentId: template.id, deploymentPreviewRole: 'preview_admission',
                enabled: true, deletedAt: null });
            let retainedChild: { id: string; contentArtifactId: string } | undefined;
            if (retainedController) {
                const { template: _template, previewTemplate: _preview, backup: _backup, ...ordinary } = content;
                const retainedContent = DeploymentEnvironmentContentV1Schema.parse({ ...ordinary, name: 'pr-17', bindings: [],
                    definition: { ...content.definition, ref: previousHead }, previewProvenance: {
                        v: 1, templateEnvironmentId: template.id, runtimeTargetLinkId: runtimeId, repository,
                        headRepository: { ...repository, repository: 'contributor/app' }, pullRequestId: '17', pullRequestNumber: 17,
                        author: { id: 'contributor', login: 'contributor' },
                    } });
                retainedChild = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                    createdByAccountId: home.accountId, protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers',
                    controllerMachineId: targetHome.machineId, buildMachineId: targetHome.machineId,
                    referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(retainedContent.bindings),
                    previewTemplateEnvironmentId: template.id, previewRepositoryId: source.source.id,
                    previewPullRequestId: '17', previewTargetLinkId: runtimeId,
                    ...await home.createContentArtifact({ body: JSON.stringify(retainedContent) }, 'deployment-environment.v1') } });
                const target = await db.deploymentTargetLink.create({ data: { environmentId: retainedChild.id,
                    createdByAccountId: home.accountId, role: 'runtime', state: 'configured', sourceKind: 'host',
                    hostTargetId: 'own-server', targetKind: 'ownServer',
                    ...await home.createContentArtifact({ body: JSON.stringify(sample.targetLinks[0]!.content) }, 'deployment-target-link.v1'),
                    machines: { create: [{ machineId: targetHome.machineId, installationId: targetHome.installationId, position: 0, state: 'active' }] },
                } });
                await db.deploymentEnvironment.update({ where: { id: retainedChild.id }, data: { runtimeTargetLinkId: target.id } });
            }
            mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
                controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
            const createIngressFor = async (ingressHome: typeof home) => {
                const identity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => home.serverId,
                    resolveHostIdentity: async () => ({ custodianAccountId: home.accountId,
                        machineId: ingressHome.machineId, installationId: ingressHome.installationId }) });
                const resolveRequesterIdentity: Parameters<typeof createDaemonDeploymentActionDeps>[0]['resolveRequesterIdentity'] = async context => {
                    const requester = await identity.resolveActionRequester!(context);
                    try { return requester.identity; } finally { await requester.dispose(); }
                };
                const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: home.serverId,
                    serverHttpBaseUrl: home.baseUrl, machineId: ingressHome.machineId, resolveRequesterIdentity,
                    acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry() });
                return await createS0DeploymentDaemonIngress({ home: ingressHome, resolveDeploymentRequesterIdentity: resolveRequesterIdentity,
                    async observeReceivedRequest(request) {
                        if (!request.method.endsWith(`:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`)) return;
                        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.params, request.method);
                        const parsed = ExternalActionDaemonDispatchRequestSchema.parse(decoded.params);
                        const binding = parsed.executionAuthorization?.binding;
                        const native = binding?.deploymentNativeAdmission;
                        const operand = parsed.envelope.v === 1 ? parsed.envelope.input : undefined;
                        // Store only closed framing labels; content, signatures and credentials stay in transport.
                        dispatchObservations.push({ actionId: parsed.actionId, rootActionId: binding?.actionId,
                            bindingPresent: binding !== undefined, nativeKind: native?.kind,
                            authoredDigestPresent: native !== undefined && 'authoredMetadataDigest' in native
                                && typeof native.authoredMetadataDigest === 'string',
                            inputArm: parsed.envelope.v === 2 ? 'sealed' : operand && typeof operand === 'object'
                                ? 'content' in operand ? 'authored' : 'contentArtifactId' in operand ? 'prepared' : 'other' : 'other' });
                    },
                    createDeploymentActionDeps: requester => createDaemonDeploymentActionDeps({
                        credentials: requester?.credentials ?? credentials, serverId: home.serverId,
                        serverHttpBaseUrl: home.baseUrl, machineId: ingressHome.machineId, resolveRequesterIdentity,
                        ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}), runtime,
                        acquirePluginRuntimeRegistryLease: () => pluginReloadController.acquireRuntimeRegistry(),
                    }),
                });
            };
            ingress = await createIngressFor(home);
            if (retainedController || remoteBuilder) secondIngress = await createIngressFor(buildHome);
            const executorFor = (signedIn: typeof credentials) => createCliActionExecutorFromCredentials({
                credentials: signedIn, readCredentials: async () => signedIn, machineId: home.machineId,
                serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl });
            const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: home.serverId,
                projectSourceId: source.source.id, requestKey: randomUUID(), name: 'pr-17', mode: 'apply',
                protection: 'nonProduction', purpose: 'preview', deployerMode: 'managers', preview: {
                    templateEnvironmentId: template.id, expectedTemplateRevision: template.revision,
                    runtimeTargetLinkId: runtimeId, pullRequestId: '17', headSha: exactHead, provenance: {
                        v: 1, templateEnvironmentId: template.id, runtimeTargetLinkId: runtimeId, repository,
                        headRepository: ordinaryPreview ? repository : { ...repository, repository: 'contributor/app' }, pullRequestId: '17', pullRequestNumber: 17,
                        author: { id: 'contributor', login: 'contributor' },
                    },
                } });
            const context = { surface: 'cli', authority: 'present_user', serverId: home.serverId,
                serverIdentityId: home.serverId, runtimeAccountId: home.accountId, actionRequestId: randomUUID() } satisfies ActionExecutorContext;
            await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                const deploymentRoot = await resolveOwnServerDeploymentRootForHost(configuration.happyHomeDir, home.serverId);
                await expect(readdir(deploymentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
                const environments = await db.deploymentEnvironment.count(), secrets = await db.savedSecretResource.count();
                const readNativeRefusals = async () => {
                    logger.flushSync();
                    return (await readFile(logger.getLogPath(), 'utf8').catch(() => ''))
                        .split('\n').filter(line => line.includes('[Deployment] Domain native'));
                };
                if (ordinaryPreview) {
                    const executeReviewed = async (actionId: ActionId, actionInput: unknown) => {
                        const receivedStart = ingress!.readReceivedMethods().length;
                        const result = await executorFor(credentials).execute(actionId, actionInput,
                            { ...context, actionRequestId: randomUUID() });
                        expect(result, JSON.stringify({ actionId, result, templateEnvironmentId: template.id,
                            createAttempts, httpFailures: httpActivity.filter(item => item.status >= 400) }))
                            .toMatchObject({ ok: true });
                        if (result.ok && result.result && typeof result.result === 'object'
                            && 'kind' in result.result && result.result.kind === 'approval_request_created'
                            && 'artifactId' in result.result && typeof result.result.artifactId === 'string') {
                            const artifactId = result.result.artifactId;
                            const decided = await executorFor(credentials).execute('approval.request.decide', {
                                artifactId, decision: 'approve',
                            }, { ...context, actionRequestId: randomUUID() });
                            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { ok: true } });
                            const approval = await createCliApprovalsArtifactStore({ credentials, serverId: home.serverId,
                                serverHttpBaseUrl: home.baseUrl }).approvalsGet({ artifactId });
                            let nativeRefusals: string[] | undefined;
                            if (approval?.execution?.ok === false) {
                                nativeRefusals = await readNativeRefusals();
                            }
                            expect(approval?.execution, JSON.stringify({ actionId, execution: approval?.execution,
                                templateEnvironmentId: template.id,
                                children: await db.deploymentEnvironment.findMany({ where: { previewTemplateEnvironmentId: template.id },
                                    select: { id: true, contentArtifactId: true } }), createAttempts,
                                nativeRefusals, caddyWrites, nativeFailures: await docker.readFailures(),
                                receivedMethods: ingress!.readReceivedMethods().slice(receivedStart),
                                dispatchObservations,
                                domainHttp: httpActivity.filter(item => item.path.includes('/domains')),
                                nativeCommands: (await docker.readInvocations()).slice(-12).map(call => ({ command: call.args[0],
                                    operation: call.args[0] === 'compose'
                                        ? call.args.find(arg => ['config', 'create', 'up', 'start'].includes(arg)) : call.args[1] })),
                                httpTail: httpActivity.slice(-16),
                                httpFailures: httpActivity.filter(item => item.status >= 400) })).toMatchObject({ ok: true });
                        }
                    };
                    await executeReviewed('deployments.environments.create', input);
                    const child = await db.deploymentEnvironment.findFirstOrThrow({ where: { previewTemplateEnvironmentId: template.id } });
                    const artifacts = createCredentialedAccountArtifactStore(credentials);
                    const childArtifact = await artifacts.read(child.contentArtifactId);
                    expect(DeploymentEnvironmentContentV1Schema.parse(JSON.parse(childArtifact!.body!)).bindings).toEqual(safeBindings);
                    const domain = preparePreviewDomainForHost({ selection: content.previewTemplate!.domain!,
                        pullRequestNumber: 17, domain: templateDomainContent });
                    expect(await db.deployment.count()).toBe(0);
                    expect(await docker.readInvocations()).toEqual([]);
                    await executeReviewed('deployments.deploy', { serverId: home.serverId, environmentId: child.id,
                        targetLinkId: child.runtimeTargetLinkId, requestKey: `${input.requestKey}-deploy`, sha: exactHead });
                    const receipt = await db.deployment.findFirstOrThrow({ where: { environmentId: child.id } });
                    expect(receipt).toMatchObject({ state: 'succeeded', operation: 'deploy' });
                    const receiptArtifact = await artifacts.read(receipt.contentArtifactId);
                    const receiptContent = DeploymentOwnServerContentV1Schema.parse(JSON.parse(receiptArtifact!.body!));
                    expect(receiptContent.previewDomain).toEqual({ domainId: templateDomainId, url: domain.url });
                    expect(receiptContent.sourceIntent).toMatchObject({ kind: 'repository', sha: exactHead });
                    expect(receiptContent.machines).toEqual([home.machineId]);
                    expect(deployAttempts).toHaveLength(1);
                    expect(deployAttempts[0]!.reviewedChild).toBeNull();
                    const acceptedDeploy = httpActivity.findIndex(item => item.method === 'POST' && item.status === 200
                        && item.path === `/v1/deployments/environments/${child.id}/deploy`);
                    expect(acceptedDeploy).toBeGreaterThanOrEqual(0);
                    expect(httpActivity.slice(acceptedDeploy + 1).filter(item => item.method === 'GET'
                        && item.path.startsWith(`/v1/deployments/environments/${template.id}`))).toEqual([]);
                    const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: child.id } });
                    const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: child.runtimeTargetLinkId! } });
                    await executeReviewed('deployments.domains.add', { serverId: home.serverId, environmentId: child.id,
                        targetLinkId: link.id, expectedRevision: current.revision, expectedTargetLinkRevision: link.revision,
                        domainId: child.id, requestKey: `${input.requestKey}-domain`, content: domain.content });
                    expect(dispatchObservations).toContainEqual(expect.objectContaining({ actionId: 'deployments.domains.add',
                        rootActionId: 'deployments.domains.add', bindingPresent: true, authoredDigestPresent: true }));
                    const installedDomain = await db.deploymentDomain.findFirstOrThrow({ where: { environmentId: child.id } });
                    expect(projectDeploymentDomainHeader(installedDomain)).toMatchObject({ id: child.id, state: 'warning',
                        dnsHealth: { status: expect.stringMatching(/^(down|unknown)$/) } });
                    expect(await docker.readRuntimeEnvironment('app')).toMatchObject({ PREVIEW_LABEL: 'reviewed-public-value',
                        PRIMARY_URL: domain.url, DOMAIN_URL: domain.url });
                    expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
                    expect(await docker.readRunningImageConfig('app')).toBe(image.configDigest);
                    expect(caddyWrites.length).toBeGreaterThan(0);
                    expect(httpActivity).toContainEqual(expect.objectContaining({ method: 'GET',
                        path: `/v1/deployments/environments/${template.id}`, status: 200, effectActionId: 'deployments.environments.get' }));
                    expect(await db.deploymentEnvironment.count()).toBe(environments + 1);
                    expect(await db.deployment.count()).toBe(1);
                    expect(await db.savedSecretResource.count()).toBe(secrets);
                    return;
                }
                const pending = await executorFor(credentials).execute('deployments.environments.create', input, context);
                expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                if (!pending.ok || !pending.result || typeof pending.result !== 'object'
                    || !('artifactId' in pending.result) || typeof pending.result.artifactId !== 'string') throw new Error('Expected approval Artifact');
                const other = await db.account.create({ data: { encryptionMode: 'plain' } });
                const token = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user',
                    authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
                const beforeOtherDecision = httpActivity.length;
                const refused = await executorFor({ token, encryption: null }).execute('approval.request.decide', {
                    artifactId: pending.result.artifactId, decision: 'approve',
                }, { ...context, runtimeAccountId: other.id, actionRequestId: randomUUID() });
                expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'approval_not_found' });
                expect(httpActivity.slice(beforeOtherDecision)).toContainEqual(expect.objectContaining({ method: 'GET',
                    path: `/v1/artifacts/${pending.result.artifactId}`, status: 404 }));
                expect(await db.deploymentEnvironment.count()).toBe(environments);
                if (retainedChild) expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: retainedChild.id } }))
                    .toMatchObject({ contentArtifactId: retainedChild.contentArtifactId, controllerMachineId: targetHome.machineId });
                expect(await db.savedSecretResource.count()).toBe(secrets);
                expect(await docker.readInvocations()).toEqual([]);
                expect(await db.deployment.count()).toBe(0);
                await expect(readdir(deploymentRoot)).rejects.toMatchObject({ code: 'ENOENT' });
                if (builderNativeHomeDir) await expect(readdir(await resolveOwnServerDeploymentRootForHost(builderNativeHomeDir,
                    home.serverId))).rejects.toMatchObject({ code: 'ENOENT' });
                // The same signed requester can spend this exact Create review;
                // native acquisition is the genuine source/image boundary.
                const decided = await executorFor(credentials).execute('approval.request.decide', {
                    artifactId: pending.result.artifactId, decision: 'approve',
                }, { ...context, actionRequestId: randomUUID() });
                expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { ok: true } });
                const settledApproval = await createCliApprovalsArtifactStore({ credentials, serverId: home.serverId,
                    serverHttpBaseUrl: home.baseUrl }).approvalsGet({ artifactId: pending.result.artifactId });
                const children = await db.deploymentEnvironment.findMany({ where: { previewTemplateEnvironmentId: template.id },
                    select: { id: true, contentArtifactId: true } });
                const receiptArtifacts = await db.deployment.findMany({ select: { id: true, contentArtifactId: true, state: true } });
                const receiptDiagnostics = settledApproval?.execution?.ok === false
                    ? (await db.deployment.findMany()).map(row => {
                        let projectionIssues: { path: PropertyKey[]; code: string }[] | undefined;
                        try { projectDeploymentReceiptHeader(row); }
                        catch (error) {
                            if (error instanceof $ZodError) projectionIssues = error.issues.map(issue => ({ path: issue.path, code: issue.code }));
                            else throw error;
                        }
                        return { id: row.id, state: row.state, revision: row.revision,
                            contentHeaderVersion: row.contentHeaderVersion, contentBodyVersion: row.contentBodyVersion,
                            actionOperationId: row.actionOperationId, requestedAtMs: row.requestedAt.getTime(),
                            startedAtMs: row.startedAt?.getTime(), settledAtMs: row.settledAt?.getTime(), projectionIssues };
                    }) : undefined;
                const reviewedArgs = settledApproval && 'actionArgs' in settledApproval ? settledApproval.actionArgs : undefined;
                const artifacts = createCredentialedAccountArtifactStore(credentials);
                const candidateUpdate = httpActivity.findLast(item => item.method === 'POST' && item.status === 200
                    && item.effectActionId === 'deployments.deploy' && item.path.startsWith('/v1/artifacts/'));
                const candidateArtifact = settledApproval?.execution?.ok === false && candidateUpdate
                    ? await artifacts.read(candidateUpdate.path.slice('/v1/artifacts/'.length)) : undefined;
                const candidateContent = candidateArtifact?.body
                    ? DeploymentContentV1Schema.safeParse(JSON.parse(candidateArtifact.body)) : undefined;
                expect(settledApproval?.execution, JSON.stringify({ execution: settledApproval?.execution,
                    nativeRefusals: settledApproval?.execution?.ok === false ? await readNativeRefusals() : undefined,
                    caddyWrites, dispatchObservations,
                    templateContentArtifactId: template.contentArtifactId, runtimeContentArtifactId: templateRuntime.contentArtifactId,
                    approvalArtifactId: pending.result.artifactId, children, receiptArtifacts, receiptDiagnostics,
                    httpFailures: httpActivity.filter(item => item.status >= 400), httpTail: httpActivity.slice(-12), createAttempts, deployAttempts,
                    requestedCreateKey: input.requestKey, requestContextId: context.actionRequestId,
                    nativeInvocationCount: (await docker.readInvocations()).length,
                    nativeFailures: await docker.readFailures(),
                    nativeCommands: (await docker.readInvocations()).slice(-12).map(call => ({ command: call.args[0],
                        operation: call.args[0] === 'compose'
                            ? call.args.find(arg => ['config', 'create', 'up', 'start'].includes(arg)) : call.args[1] })),
                    candidateContent: candidateContent && (candidateContent.success ? { ok: true }
                        : { ok: false, issues: candidateContent.error.issues.map(issue => ({ path: issue.path, code: issue.code })) }),
                    reviewedContentArtifactId: reviewedArgs && typeof reviewedArgs === 'object' && 'contentArtifactId' in reviewedArgs
                        ? reviewedArgs.contentArtifactId : undefined })).toMatchObject({ ok: true });
                expect(await db.deploymentEnvironment.count()).toBe(environments + (retainedController ? 0 : 1));
                expect(await db.savedSecretResource.count()).toBe(secrets);
                const child = await db.deploymentEnvironment.findFirstOrThrow({ where: { previewTemplateEnvironmentId: template.id } });
                if (retainedChild) expect(child).toMatchObject({ id: retainedChild.id, controllerMachineId: targetHome.machineId,
                    buildMachineId: targetHome.machineId });
                const receipts = await db.deployment.findMany({ where: { environmentId: child.id } });
                expect(receipts).toHaveLength(1);
                expect(receipts[0]).toMatchObject({ state: 'succeeded', operation: 'deploy' });
                const childArtifact = await artifacts.read(child.contentArtifactId);
                const childContent = DeploymentEnvironmentContentV1Schema.parse(JSON.parse(childArtifact!.body!));
                if (plannedDomain) expect(childContent.bindings).toEqual(safeBindings);
                else expect(childContent.bindings).toEqual([]);
                expect(childContent.template).toBeUndefined();
                expect(childContent.previewTemplate).toBeUndefined();
                expect(childContent.backup).toBeUndefined();
                expect(await db.deploymentTargetLink.count({ where: { environmentId: child.id } })).toBe(1);
                expect(await db.deploymentEnvironment.count({ where: { previewCompanionOfEnvironmentId: child.id } })).toBe(0);
                const receiptArtifact = await artifacts.read(receipts[0]!.contentArtifactId);
                const receiptContent = DeploymentOwnServerContentV1Schema.parse(JSON.parse(receiptArtifact!.body!));
                expect(receiptContent.sourceIntent).toMatchObject({ kind: 'repository', sha: exactHead });
                if (remoteBuilder) {
                    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                        serverId: home.serverId, environmentId: child.id });
                    const release = resolveDeploymentSourcePathForHost({ ...identity, deploymentId: receipts[0]!.id });
                    expect((await readFile(join(release, 'compose.yaml'), 'utf8')).trim()).toBe(git('show', `${exactHead}:compose.yaml`));
                }
                if (retainedController) {
                    const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: configuration.happyHomeDir,
                        serverId: home.serverId, environmentId: child.id });
                    const release = resolveDeploymentSourcePathForHost({ ...identity, deploymentId: receipts[0]!.id });
                    const materializedRevision = (await readFile(join(release, 'reviewed-revision.txt'), 'utf8')).trim();
                    expect(materializedRevision).toBe(git('show', `${exactHead}:reviewed-revision.txt`));
                    expect(materializedRevision).not.toBe(git('show', `${previousHead}:reviewed-revision.txt`));
                }
                // Sync deploys the approved SHA without rewriting an existing authored ref.
                expect(childContent.definition).toMatchObject({ kind: 'repository', ref: retainedController ? previousHead : exactHead });
                expect((await docker.readInvocations()).filter(call => call.args.includes('up'))).toHaveLength(1);
                expect(await docker.readRunningImageConfig('app')).toBe(image.configDigest);
                expect(await docker.readVolumeNames()).toEqual([]);
                if (plannedDomain) {
                    expect(receiptContent.previewDomain).toEqual({ domainId: templateDomainId, url: 'https://pr-17-app.preview.test/app' });
                    expect(child).toMatchObject({ controllerMachineId: home.machineId, buildMachineId: buildHome.machineId });
                    expect(await docker.readRuntimeEnvironment('app')).toMatchObject({ PREVIEW_LABEL: 'reviewed-public-value',
                        PRIMARY_URL: 'https://pr-17-app.preview.test/app', DOMAIN_URL: 'https://pr-17-app.preview.test/app' });
                    expect(await docker.readRuntimeEnvironment('app')).not.toHaveProperty('PARENT_SECRET');
                    expect(await docker.readRuntimeEnvironment('app')).not.toHaveProperty('BLUEPRINT_SECRET');
                    const domain = await db.deploymentDomain.findFirstOrThrow({ where: { environmentId: child.id } });
                    expect(projectDeploymentDomainHeader(domain)).toMatchObject({ id: child.id, state: 'warning',
                        dnsHealth: { status: expect.stringMatching(/^(down|unknown)$/) } });
                    expect(caddyWrites.length).toBeGreaterThan(0);
                    // The reviewed Create owns this Domain child; standalone Domain routing must not mint a second root.
                    expect(dispatchObservations.filter(item => item.actionId === 'deployments.domains.add')).toEqual([]);
                    if (remoteBuilder) expect(secondIngress!.readReceivedMethods().some(method => method.endsWith(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD))).toBe(true);
                    expect(ingress!.readReceivedMethods().some(method => method.endsWith(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD))).toBe(true);
                    expect(receiptContent.machines).toEqual([home.machineId]);
                }
                if (retainedController) {
                    expect(ingress!.readReceivedMethods().filter(method => method.endsWith(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD))).toEqual([]);
                    expect(secondIngress!.readReceivedMethods().some(method => method.endsWith(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD))).toBe(true);
                    expect(receiptContent.machines).toEqual([targetHome.machineId]);
                }
                const afterApprovedNative = (await docker.readInvocations()).length;
                const nextHead = await executorFor(credentials).execute('deployments.environments.create', {
                    ...input, requestKey: randomUUID(), preview: { ...input.preview!, headSha: 'b'.repeat(40) },
                }, { ...context, actionRequestId: randomUUID() });
                expect(nextHead, JSON.stringify(nextHead)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                expect(nextHead).not.toMatchObject({ result: { artifactId: pending.result.artifactId } });
                expect(await docker.readInvocations()).toHaveLength(afterApprovedNative);
                expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: child.id } }))
                    .toMatchObject({ contentArtifactId: child.contentArtifactId, contentHeaderVersion: child.contentHeaderVersion,
                        contentBodyVersion: child.contentBodyVersion });
            });
        } finally {
            await secondIngress?.close();
            await ingress?.close();
            if (caddyServer) await new Promise<void>((resolve, reject) => caddyServer!.close(error => error ? reject(error) : resolve()));
            try {
                if (mounted) {
                    for (const handle of mounted.registry.projectManagedServices.listProjectServices()) await handle.dispose();
                    await mounted.dispose();
                }
            } finally { restoreMachineHome?.(); restoreLogger(); withdrawActiveProjectAccountRowsSnapshot(); await home.close(); vi.unstubAllEnvs(); }
        }
    });
    });
}, 300_000);
