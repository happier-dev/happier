import axios from 'axios';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorContext, DeploymentTemplateInstantiateInputV1Schema,
    DeploymentActionInputSchemasV1, DeploymentDomainHeaderV1Schema, DeploymentDomainMachineTopologyV1Schema,
    DeploymentChildRpcV1Schema, ProjectDeploymentDefaultsOutputV1Schema, HomeConnectionDescriptorV1Schema,
    deploymentDomainObservationProofPayloadV1, signMachineInstallationProof, FeaturesResponseSchema,
    DeploymentDomainAddAdmissionInputV1Schema, ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol';
import { PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentPreparationAdmissionV1,
    EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, decodeReviewedActionChildHttpProofV1,
    verifyExternalActionMachineRequestV1, verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { doesDeploymentChildInputMatchRootV1 } from '@happier-dev/protocol/deployments/deploymentChildRpcV1';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentContentV1Schema, readDeploymentDomainArtifactV1 } from '@happier-dev/deployment-protocol';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { updateSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '../targets/ownServer/ownServerDeploymentHostRuntime';
import { createOwnServerDockerBoundary } from '../targets/ownServer/ownServerDeployment.testkit';
import { readEnvironmentSecretLaunchAdmissionForHost } from '../secrets/readEnvironmentSecretLaunchAdmissionForHost';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(['allowed', 'denied Domain', 'occupied Caddy port'] as const)('publishes a template Domain only through its admitted child: %s', async admission => {
    await withConfiguredDaemonTestHome({ prefix: 'template-domain-child-' }, async () => {
        const origin = 'https://template-domain.test', serverId = 'srv_template_domain', machineId = 'target';
        const identity = await readOrCreateInstallationIdentity();
        const credentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1 })).toString('base64url')}.s`, encryption: null };
        await updateSettings(settings => ({ ...settings, activeServerId: serverId, servers: { [serverId]: {
            id: serverId, name: 'Home', serverUrl: origin, webappUrl: origin, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1,
                homeServerIdentityId: serverId, canonicalServerUrl: origin, revision: 1, endpoints: [{ kind: 'https', url: origin }] }),
        } } }));
        const docker = await createOwnServerDockerBoundary(join(configuration.happyHomeDir, 'tools'));
        vi.stubEnv('PATH', `${join(configuration.happyHomeDir, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        const image = await docker.registerImage('web', 'one');
        const template = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
            document: JSON.stringify({ services: { web: { image: image.registryReference } } }), profiles: [], services: ['web'] },
            variables: [], generatedSecrets: [], volumes: [], domains: [{ key: 'web', service: 'web', containerPort: 80,
                protocol: 'https', required: true, healthCheck: { path: '/ready', expectStatus: 204 } }] });
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app: template }] };
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('No text catalog'); }, getBytes: async () => { throw new Error('No binary catalog'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: 'apps', kind: 'app', itemId: 'app' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app');
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        const environment = createDeploymentEnvironmentDetailV1();
        Object.assign(environment.environment, { serverId, owner: { kind: 'account', accountId: 'owner' }, projectSourceId: 'project',
            controllerMachineId: machineId, buildMachineId: machineId });
        const link = environment.targetLinks[0]!.targetLink;
        link.machines = [machineId]; link.members = [{ machineId, installationId: identity.installationId, state: 'active' }];
        delete link.activeDeploymentId;
        const artifacts = new Map<string, Record<string, unknown>>();
        const domainWrites: string[] = [];
        const trace: string[] = [];
        const httpPaths: string[] = [];
        let rootInput: ReturnType<typeof DeploymentTemplateInstantiateInputV1Schema.parse> | undefined;
        let rootAuthorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
        let domain: ReturnType<typeof DeploymentDomainHeaderV1Schema.parse> | undefined;
        const content = (id: string) => {
            const row = artifacts.get(id);
            if (!row) throw new Error('Missing acknowledged Artifact');
            const body = decodePlainArtifactStoredContent(String(row.body));
            if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Invalid Artifact body');
            return JSON.parse(body.body);
        };
        const machine = { id: machineId, kind: 'persistent', active: true, installationId: identity.installationId,
            revokedAt: null, replacedByMachineId: null,
            installationPublicKey: Buffer.from(identity.publicKey, 'base64url').toString('base64'),
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        vi.stubGlobal('fetch', async url => Response.json(String(url).includes('/features')
            ? FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: serverId } } }) : catalog));
        const read = async (url: string) => {
            const path = new URL(url).pathname;
            httpPaths.push(`GET ${path}`);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (path === '/v1/machines') return { status: 200, data: [machine] };
            if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine } };
            if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed',
                rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
                    content: key === 'registry-sources' ? { t: 'plain', v: { key, value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) } };
            if (path === '/v1/projects/sources/project') return { status: 200, data: { ok: true, canManage: true,
                source: { id: 'project', revision: 1, name: 'Project', createdByAccountId: 'owner', audience: [] } } };
            if (path === '/v1/projects/project/deployment-defaults') return { status: 200, data: ProjectDeploymentDefaultsOutputV1Schema.parse({
                ok: true, projectSourceId: 'project', sourceRevision: 1, revision: 0, content: null }) };
            if (path.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
            if (path === `/v1/deployments/environments/${environment.environment.id}`) return { status: 200, data: {
                ok: true, environment: environment.environment, secretScope: environment.secretScope, targetLinks: [link] } };
            if (path.startsWith('/v1/artifacts/')) {
                const row = artifacts.get(decodeURIComponent(path.split('/').at(-1)!));
                return { status: row ? 200 : 404, data: row ?? {} };
            }
            throw new Error(`Unexpected Home read ${path}`);
        };
        vi.spyOn(axios, 'get').mockImplementation(url => read(String(url)));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const path = new URL(String(url)).pathname;
            httpPaths.push(`POST ${path}`);
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path === '/v1/plugins/availability/intents/list') {
                const { knownPluginIds: pluginIds = [] } = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
                return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
                    pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: {
                        availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
                    } })) }) };
            }
            if (path.startsWith('/v1/artifacts/')) {
                const artifactId = decodeURIComponent(path.split('/').at(-1)!);
                const existing = artifacts.get(artifactId);
                if (!existing) return { status: 404, data: {} };
                const { expectedHeaderVersion, expectedBodyVersion, ...content } = ArtifactJsonUpdateHttpInputV1Schema.parse(body);
                if (existing.headerVersion !== expectedHeaderVersion || existing.bodyVersion !== expectedBodyVersion)
                    return { status: 200, data: { success: false, error: 'version-mismatch' } };
                const revision = { headerVersion: expectedHeaderVersion + 1, bodyVersion: expectedBodyVersion + 1 };
                artifacts.set(artifactId, { ...existing, ...content, ...revision });
                return { status: 200, data: { success: true, ...revision } };
            }
            if (path !== '/v1/artifacts') throw new Error(`Unexpected Home POST ${path}`);
            // Axios is the genuine HTTP boundary; its request body is untyped.
            const row: Record<string, unknown> = body;
            const header = decodePlainArtifactStoredContent(String(row.header));
            const kind = header && typeof header === 'object' && 'kind' in header ? header.kind : undefined;
            if (kind === 'deployment-domain.v1') {
                const proof = decodeReviewedActionChildHttpProofV1(String(config?.headers?.[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER] ?? ''));
                const signedDomainChild = proof && verifyExternalActionMachineRequestV1({ authorizationToken: 'signed-template-root',
                    effectActionId: 'deployments.domains.add', target: { kind: 'machine', machineId },
                    installationId: identity.installationId, requestId: 'template-domain-root', method: 'POST', path, body,
                    reviewedChild: proof, signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''),
                    publicKey: identity.publicKey });
                if (!signedDomainChild || admission === 'denied Domain') return { status: 401,
                    data: { error: 'invalid_token', authorizationRefusal: 'deployment_preparation' } };
                expect(trace).toContain('deployed');
                trace.push('admitted-domain-content'); domainWrites.push(String(row.id));
            }
            artifacts.set(String(row.id), { ...row, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: row.id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            httpPaths.push(`${request.method} ${path}`);
            if (request.method?.toUpperCase() === 'GET') return read(request.url!);
            if (path === '/v1/deployments/environments') {
                const input = DeploymentActionInputSchemasV1['deployments.environments.create'].parse(request.data);
                if (!('contentArtifactId' in input) || !input.firstTargetLink) throw new Error('Expected prepared Environment');
                Object.assign(environment.environment, { contentArtifactId: input.contentArtifactId,
                    contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion,
                    revision: 1, runtimeTargetLinkId: link.id });
                Object.assign(link, { contentArtifactId: input.firstTargetLink.contentArtifactId,
                    contentHeaderVersion: input.firstTargetLink.contentHeaderVersion, contentBodyVersion: input.firstTargetLink.contentBodyVersion });
                environment.content = DeploymentEnvironmentContentV1Schema.parse(content(input.contentArtifactId));
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 1 } };
            }
            if (path.endsWith('/bindings')) {
                Object.assign(environment.environment, { contentArtifactId: request.data.contentArtifactId,
                    contentHeaderVersion: request.data.contentHeaderVersion, contentBodyVersion: request.data.contentBodyVersion,
                    revision: environment.environment.revision + 1 });
                environment.content = DeploymentEnvironmentContentV1Schema.parse(content(request.data.contentArtifactId));
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
            }
            if (path.endsWith('/deploy')) {
                trace.push('deployed');
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, deploymentId: 'receipt',
                    revision: ++environment.environment.revision, deploymentRevision: 2, state: 'succeeded' } };
            }
            if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
            if (path.endsWith('/domains')) {
                const input = DeploymentDomainAddAdmissionInputV1Schema.parse(request.data);
                domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
                    targetLinkId: input.targetLinkId, revision: 1, state: 'pending', contentArtifactId: input.contentArtifactId,
                    contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
                    placements: input.placements?.map(placement => ({ desired: true, listener: placement.listener,
                        dockerEngineId: placement.dockerEngineId, content: { contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                        placement: { machineId: placement.machineId, installationId: placement.installationId,
                            nativeServer: placement.nativeServer, serverId, accountId: 'owner', environmentId: input.environmentId,
                            targetLinkId: input.targetLinkId, domainId: input.domainId,
                            requestId: input.requestId, actionOperationId: input.actionOperationId } })) });
                return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: ++environment.environment.revision, domain } };
            }
            if (path.endsWith('/transitions') && domain) {
                domain = { ...domain, revision: domain.revision + 1, state: 'active' };
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision, domain } };
            }
            throw new Error(`Unexpected Home mutation ${path}`);
        });
        const channel = await createRequesterCurrentnessSocketHarness();
        channel.server.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, async (call, acknowledge) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
            const job = DeploymentChildRpcV1Schema.parse(decoded.params);
            const execution = ExternalActionMachineRpcExecutionV1Schema.parse(call.externalActionExecution);
            const admitted = rootAuthorization && rootInput && verifyExternalActionMachineRpcRequestV1({ ...execution,
                authorizationToken: execution.authorization.token, requesterAccountContext: execution.authorization.requesterAccountContext,
                event: SOCKET_RPC_EVENTS.CALL, method: call.method, requestId: call.requestId, params: call.params,
                signature: execution.machineSignature, publicKey: identity.publicKey })
                && doesDeploymentChildInputMatchRootV1({ rootInput, rootActionId: rootAuthorization.binding.actionId,
                    rootBinding: rootAuthorization.binding, rootPreparationAdmission: rootAuthorization.binding.deploymentPreparationAdmission,
                    reviewedChild: execution.reviewedChild, child: job });
            if (!admitted) { acknowledge({ ok: false, error: 'action_forbidden' }); return; }
            if (job.kind === 'domainDiscover') {
                expect(domainWrites).toContain(job.input.contentArtifactId);
                if (admission === 'occupied Caddy port') {
                    acknowledge({ ok: true, result: { ok: false, errorCode: 'native_effect_failed', error: 'native_effect_failed',
                        details: DeploymentDomainFailureDetailsV1Schema.parse({ environmentId: job.input.environmentId,
                            domainId: job.input.domainId, step: 'native_execution', requiredFact: 'caddyAdminConfig',
                            remedy: 'Caddy cannot bind a public port. Use Tunnel ingress or stop the other proxy, then retry.',
                            failure: { kind: 'native_effect_failed', reason: 'native_effect_failed', requiredFact: 'caddyAdminConfig',
                                stepId: 'caddy-container-start', nativeCommand: { command: 'docker', phase: 'start', exitCode: 1 },
                                containerExitCode: 128, containerError: 'port_in_use' } }),
                        failureCause: { phase: 'deployment.domain.native_execution', errorClass: 'Error',
                            errorCode: 'native_effect_failed', httpStatus: null } } });
                    return;
                }

                acknowledge({ ok: true, result: DeploymentDomainMachineTopologyV1Schema.parse({ machineId, installationId: identity.installationId,
                    dockerEngineId: 'engine', privateNetworks: [], replicas: [], caddy: { status: 'ready', containerId: 'caddy',
                        containerName: 'caddy', adminSocketPath: '/run/caddy.sock', networkNames: [], servers: [{ serverId: 'public',
                            listen: [':443'], tls: true, automaticHttpsDisabled: false,
                            endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] },
                            { serverId: 'private', listen: [':8080'], tls: false, automaticHttpsDisabled: true, endpoints: [] }] } }) });
            } else if (job.kind === 'domain') {
                const observation = { capture: job.capture, state: 'active' as const };
                acknowledge({ ok: true, result: { ...observation, proof: signMachineInstallationProof({ privateKey: identity.privateKey,
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: job.expectedDomainRevision, observation }) }) } });
            } else throw new Error('Unexpected native child');
        }));
        const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        let requester: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
        try {
            const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId, machineId, projectSourceId: 'project',
                templateRef: { sourceId: 'apps', itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref },
                environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction', purpose: 'standard',
                    deployerMode: 'managers', controllerMachineId: machineId }, target: { kind: 'new', installationId: identity.installationId },
                destination: { kind: 'stored' }, bindings: [], domainBindings: [{ templateDomainId: 'web', hostname: 'app.example.test' }],
                deploy: { requestKey: 'deploy-app' } });
            const target = { kind: 'machine' as const, machineId };
            const envelope = { v: 1 as const, requestId: 'template-domain-root', target, input };
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-template-root', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                serverIdentityId: serverId, machineId, installationId: identity.installationId, admittedMachineRole: 'manage', target,
                actionId: 'deployments.templates.instantiate', requestId: envelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input) } });
            rootInput = input; rootAuthorization = authorization;
            const identityOwner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => serverId,
                resolveHostIdentity: async () => ({ machineId, installationId: identity.installationId, custodianAccountId: 'owner' }) });
            const resolveRequesterIdentity = async (context: ActionExecutorContext) => {
                const admitted = await identityOwner.resolveActionRequester!(context);
                try { return admitted.identity; } finally { await admitted.dispose(); }
            };
            requester = await prepareRequesterAccountActionContext({ authorization: sealExternalActionRequesterAccountContextV1({ authorization,
                purpose: { kind: 'external_action' }, credentials: { token: credentials.token, secret: null, encryption: null },
                installationPublicKey: Buffer.from(identity.publicKey, 'base64url'), randomBytes: size => new Uint8Array(size).fill(31) }),
                purpose: { kind: 'external_action' }, machineId, installationId: identity.installationId,
                installationPrivateKey: Buffer.from(identity.privateKey, 'base64url'), serverId, serverIdentityId: serverId,
                serverHttpBaseUrl: origin, ownCredentials: credentials, isCurrent: async () => true, createExecutor: admitted => {
                    const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: admitted.credentials, serverId, machineId, serverHttpBaseUrl: origin,
                        resolveRequesterIdentity, acquirePluginRuntimeRegistryLease: async () => mounted.lease,
                        readEnvironmentSecretLaunchAdmission: readEnvironmentSecretLaunchAdmissionForHost });
                    const deps = createDaemonDeploymentActionDeps({ credentials: admitted.credentials, serverId, machineId, serverHttpBaseUrl: origin,
                        savedSecretOperationContext: admitted.savedSecretOperationContext,
                        resolveRequesterIdentity, acquirePluginRuntimeRegistryLease: async () => mounted.lease, runtime });
                    return createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
                } });
            if (!requester) throw new Error('Expected original requester custody');
            const executor = requester.executor;
            const result = await executor.execute('deployments.templates.instantiate', input, { surface: 'ui', authority: 'present_user',
                runtimeAccountId: 'owner', serverId, serverIdentityId: serverId, actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable',
                actionsSettings: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined),
                    actionId: 'deployments.templates.instantiate', surface: 'ui', approvalRequired: false }),
                actionRequestId: envelope.requestId, executionRunTargetMachineId: machineId, externalActionTarget: target,
                presentUserConfirmation: { actionId: 'deployments.templates.instantiate',
                    inputDigest: computeActionInputApprovalDigestV1('deployments.templates.instantiate', input),
                    accountId: 'owner', serverId, requestId: envelope.requestId, target },
                originalActionEnvelope: envelope, externalActionExecutionAuthorization: requester.authorization,
                operationAcceptance: { operationId: 'template-operation', accept() {} } });
            expect(trace, JSON.stringify({ result, httpPaths })).toContain('deployed');
            if (admission === 'denied Domain') {
                expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden', failureCause: { httpStatus: 401 } });
                expect(domainWrites).toEqual([]); expect(domain).toBeUndefined();
            } else if (admission === 'occupied Caddy port') {
                expect(result).toMatchObject({ ok: false, errorCode: 'native_effect_failed', details: {
                    kind: 'partial', phase: 'domains', environmentId: environment.environment.id,
                    failure: { step: 'native_execution', failure: { containerError: 'port_in_use', containerExitCode: 128 } },
                } });
                if (result.ok) throw new Error('Expected retained Domain failure');
                expect(readDeploymentFailureRecoveryV1(result.errorCode, result.details)).toMatchObject({
                    requiredFact: 'caddyAdminConfig', nextAction: { destination: 'domains' },
                    remedy: readDeploymentFailureRecoveryV1('native_effect_failed', {
                        remedy: 'Caddy cannot bind a public port. Use Tunnel ingress or stop the other proxy, then retry.',
                    }).remedy,
                });
                expect(domain).toBeUndefined();
            } else {
                expect(result, JSON.stringify({ result, httpPaths, domainWrites })).toMatchObject({ ok: true, result: { kind: 'applied' } });
                expect(domain).toMatchObject({ state: 'active' });
                if (!domain) throw new Error('Expected active Domain');
                const document = await runWithServerHttpBaseUrl(origin, () => createCredentialedAccountArtifactStore(credentials)
                    .read(domain!.contentArtifactId, { prepareRecipients: false, includeSharedAudience: false }));
                expect(readDeploymentDomainArtifactV1(domain, document)).toMatchObject({ ok: true, content: {
                    hostname: 'app.example.test', target: { service: 'web', containerPort: 80 }, healthCheck: { path: '/ready', expectStatus: 204 } } });
            }
        } finally { await requester?.dispose(); await mounted.dispose(); await channel.close(); }
    });
});
