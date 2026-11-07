import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import * as persistence from '@/persistence';
import { configuration } from '@/configuration';
import type { ServerProfile } from '@/server/serverProfiles';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createDeploymentTemplateInstantiationForHost } from '@/deployments/templates/instantiate';
import { readDeploymentCreationDefaultInputsForHost } from '@/deployments/readCreationDefaultsForHost';
import { createOwnServerDomainActions } from '@/deployments/targets/ownServer/ownServerDomainActions';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readEnvironmentSecretLaunchAdmissionForHost } from '@/deployments/secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createActionExecutor, type ActionExecutorDeps, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { accountSettingsParse, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentTemplateInstantiateInputV1Schema,
    DeploymentActionInputSchemasV1, DeploymentReceiptResultV1Schema, ProjectDeploymentDefaultsOutputV1Schema,
    HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ExternalActionExecutionAuthorizationV1Schema, projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { DeploymentDomainHeaderV1Schema, DeploymentDomainMachineTopologyV1Schema,
    DeploymentDomainTransitionInputV1Schema, deploymentDomainObservationProofPayloadV1,
    type DeploymentDomainHeaderV1, type DeploymentDomainObservationBodyV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { DeploymentEnvironmentContentV1Schema, DeploymentDomainContentV1Schema,
    DeploymentEnvironmentTemplateSetInputV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Persistence/Artifact and native transport are the boundaries. Catalog admission,
// reviewed-child issuance, template apply and Domain placement/settlement stay real.
it.each(['active', 'warning', 'failed', 'nativeFailure', 'discoveryFailure', 'optionalOnly', 'firstInstall', 'deployRetry', 'newProject', 'noProbe'] as const)('spends one Catalog create review on the real Domain owner: %s', async outcome => {
    const state = outcome === 'active' || outcome === 'warning' ? outcome : outcome === 'firstInstall' || outcome === 'deployRetry' || outcome === 'newProject' || outcome === 'noProbe' ? 'active' : 'failed';
    const fixture = await createSavedSecretsCliHttpFixture({ serverIdentityId: 'srv_template_home' });
    const socket = await createRequesterCurrentnessSocketHarness();
    const nativeRoot = await mkdtemp(join(tmpdir(), 'happier-template-domain-'));
    const originalHome = configuration.happyHomeDir;
    const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    try { await fixture.inHome(async () => {
        const credentials = await fixture.deps.readCredentialsFn?.();
        if (!credentials) throw new Error('Missing fixture credentials');
        const currentness = await axios.get(`${fixture.origin}/v1/account/encryption/currentness`);
        const settings = await axios.get(`${fixture.origin}/v2/account/settings`);
        const identity = await readOrCreateInstallationIdentity();
        const settingsState = await persistence.readSettings();
        const profile: ServerProfile = { id: 'srv_template_home', name: 'Home', serverUrl: fixture.origin, webappUrl: fixture.origin,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_template_home',
                canonicalServerUrl: fixture.origin, revision: 1, endpoints: [{ kind: 'https', url: fixture.origin }] }) };
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settingsState, servers: { [profile.id]: profile } });
        Reflect.set(configuration, 'happyHomeDir', nativeRoot);
        const accountId = 'account-cli-fixture';
        const docker = await createOwnServerDockerBoundary(join(nativeRoot, 'tools'));
        vi.stubEnv('PATH', `${join(nativeRoot, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        const image = await docker.registerImage('web', 'one');
        const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
            document: JSON.stringify({ services: { web: { image: image.registryReference } } }), profiles: [], services: ['web'] },
            variables: [], generatedSecrets: [], volumes: [], domains: [{ key: 'web', service: 'web',
                containerPort: 80, protocol: 'https', required: outcome !== 'optionalOnly', path: '/app',
                ...(outcome === 'noProbe' ? {} : { healthCheck: { path: '/ready', expectStatus: 204 } }) }] });
        const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('Unexpected text read'); }, getBytes: async () => { throw new Error('Unexpected binary read'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute(
            'registries.items.read', { kind: 'app', sourceId: source.id, itemId: 'app' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app');
        const templateRef = { sourceId: source.id, itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref };
        const { origin: _origin, removable: _removable, ...sourceRow } = source;
        const originalGet = axios.get.bind(axios), originalRequest = axios.request.bind(axios), originalPost = axios.post.bind(axios);
        const artifactRows = new Map<string, Record<string, unknown>>();
        const unhandledRequests: string[] = [];
        const recordUnhandled = (method: string, url: string) => { unhandledRequests.push(`${method} ${new URL(url).pathname}`); };
        vi.spyOn(globalThis, 'fetch').mockImplementation(async url => Response.json(String(url).includes('/v1/features')
            ? { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_template_home' } } } : catalog));
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => url.endsWith('/v1/account/profile')
            ? { status: 200, data: AccountProfileResponseSchema.parse({ id: accountId }) }
            : url.endsWith('/v1/account/encryption/currentness') ? currentness
            : url.endsWith('/v2/account/settings') ? settings
            : url.endsWith('/v1/account/encryption') ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : url.includes('/v1/features') ? { status: 200, data: { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_template_home' } } } }
            : url.endsWith('/v1/account/entity-rows/prompt-library')
            ? { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
                revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key, value: {
                    v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null })) } }
            : new URL(url).pathname.startsWith('/v1/artifacts/') ? (() => {
                const row = artifactRows.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
                return row ? { status: 200, data: row } : { status: 404, data: { error: 'Artifact not found' } };
            })()
            : (recordUnhandled('GET', url), originalGet(url, config)));
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.owner = { kind: 'account', accountId };
        environment.environment.projectSourceId = 'project';
        environment.environment.controllerMachineId = 'target'; environment.environment.buildMachineId = 'target';
        const linkedTarget = environment.targetLinks[0]!;
        const link = linkedTarget.targetLink;
        delete link.activeDeploymentId;
        link.machines = ['target']; link.members = [{ machineId: 'target', installationId: identity.installationId, state: 'active' }];
        environment.targetLinks = [];
        delete environment.environment.runtimeTargetLinkId;
        const contents = new Map<string, unknown>();
        const writes: string[] = [];
        let sourceReads = 0;
        let sourceCanManage = true;
        let deployAttempts = 0;
        let domain: DeploymentDomainHeaderV1 | undefined;
        let nativeEffects = 0;
        const put = (id: string, kind: string, content: unknown) => artifactRows.set(id, { id, ownerAccountId: accountId,
            access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Catalog content' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        put(link.contentArtifactId, 'deployment-target-link.v1', linkedTarget.content);
        vi.spyOn(axios, 'post').mockImplementation(async (url, value, config) => {
            if (url.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
            if (url.endsWith('/v1/artifacts')) {
                const mutation = readCarrierMutation(value); const id = String(mutation.id);
                const header = decodePlainArtifactStoredContent(String(mutation.header));
                if (header && typeof header === 'object' && 'kind' in header && header.kind === DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1) {
                    const body = decodePlainArtifactStoredContent(String(mutation.body));
                    if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Invalid Domain Artifact body');
                    contents.set(id, DeploymentDomainContentV1Schema.parse(JSON.parse(body.body)));
                }
                artifactRows.set(id, { ...mutation, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
                    encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
            }
            const match = /^\/v1\/artifacts\/([^/]+)$/.exec(new URL(url).pathname);
            if (match) {
                const id = decodeURIComponent(match[1]!); const row = artifactRows.get(id)!;
                const mutation = readCarrierMutation(value);
                Object.assign(row, mutation, { headerVersion: Number(row.headerVersion) + Number(mutation.header !== undefined),
                    bodyVersion: Number(row.bodyVersion) + Number(mutation.body !== undefined) });
                return { status: 200, data: { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
            }
            recordUnhandled('POST', url);
            return originalPost(url, value, config);
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method === 'GET' && request.url && new URL(request.url).pathname === '/v1/projects/project/deployment-defaults') {
                return { status: 200, data: ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: 'project',
                    sourceRevision: 1, revision: 0, content: null }) };
            }
            if (request.method === 'GET' && request.url && new URL(request.url).pathname === '/v1/projects/sources/project') {
                sourceReads++;
                return { status: 200, data: { ok: true, canManage: sourceCanManage, source: { id: 'project', revision: 1,
                    name: 'Project', createdByAccountId: accountId, audience: [] } } };
            }
            if (request.method === 'GET' && request.url?.includes('/environments/')) {
                if (new URL(request.url).pathname.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
                return { status: 200, data: { ok: true, environment: environment.environment,
                    targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            }
            if (request.url?.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
            if (request.url?.endsWith('/deploy')) {
                writes.push('deployments.deploy'); environment.environment.revision++;
                deployAttempts++;
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, deploymentId: 'receipt',
                    revision: environment.environment.revision, deploymentRevision: 2,
                    state: outcome === 'deployRetry' && deployAttempts === 1 ? 'failed' : 'succeeded' } };
            }
            if (request.url?.endsWith('/template')) {
                const body = DeploymentEnvironmentTemplateSetInputV1Schema.parse(request.data);
                environment.content = DeploymentEnvironmentContentV1Schema.parse(contents.get(body.contentArtifactId));
                Object.assign(environment.environment, { contentArtifactId: body.contentArtifactId,
                    contentHeaderVersion: body.contentHeaderVersion, contentBodyVersion: body.contentBodyVersion });
                environment.environment.revision++;
                writes.push('template.set');
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
            }
            if (request.url?.endsWith('/transitions')) {
                const transition = DeploymentDomainTransitionInputV1Schema.parse(request.data);
                expect(transition.observations.map(item => item.state)).toEqual([state, state]);
                if (!domain) throw new Error('Missing persisted Domain');
                domain = { ...domain, state, revision: domain.revision + 1 };
                writes.push('domain.transition');
                return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                    revision: environment.environment.revision, domain } };
            }
            recordUnhandled(request.method ?? 'GET', request.url ?? fixture.origin);
            return originalRequest(request);
        });
        const storage: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, raw, context) => {
            writes.push(actionId);
            if (actionId === 'deployments.environments.create') {
                const input = DeploymentActionInputSchemasV1[actionId].parse(raw);
                if (!('contentArtifactId' in input) || !input.firstTargetLink) throw new Error('Expected allocated content');
                environment.content = DeploymentEnvironmentContentV1Schema.parse(contents.get(input.contentArtifactId));
                Object.assign(environment.environment, { contentArtifactId: input.contentArtifactId,
                    contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion,
                    runtimeTargetLinkId: link.id });
                environment.targetLinks = [linkedTarget];
                Object.assign(link, { contentArtifactId: input.firstTargetLink.contentArtifactId,
                    contentHeaderVersion: input.firstTargetLink.contentHeaderVersion, contentBodyVersion: input.firstTargetLink.contentBodyVersion });
                environment.environment.revision++;
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision };
            }
            if (actionId === 'deployments.bindings.set' || actionId === 'deployments.environments.update') {
                const input = DeploymentActionInputSchemasV1[actionId].parse(raw);
                if (!('contentArtifactId' in input)) throw new Error('Expected prepared bindings');
                environment.content = DeploymentEnvironmentContentV1Schema.parse(contents.get(input.contentArtifactId));
                Object.assign(environment.environment, { contentArtifactId: input.contentArtifactId,
                    contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion });
                environment.environment.revision++;
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision };
            }
            if (actionId === 'deployments.domains.add') {
                const input = DeploymentActionInputSchemasV1[actionId].parse(raw);
                if (!('contentArtifactId' in input)) throw new Error('Expected a prepared Domain operand');
                expect(input).toMatchObject({ environmentId: environment.environment.id, targetLinkId: link.id,
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision });
                expect(DeploymentDomainContentV1Schema.parse(contents.get(input.contentArtifactId))).toEqual({
                    hostname: 'app.example.test', target: { service: 'web', containerPort: 80, path: '/app' },
                    ...(outcome === 'noProbe' ? {} : { healthCheck: { path: '/ready', expectStatus: 204 } }) });
                environment.environment.revision++;
                domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
                    targetLinkId: input.targetLinkId, revision: 1, state: 'pending', contentArtifactId: input.contentArtifactId,
                    contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion,
                    createdByAccountId: accountId, createdAtMs: 1, updatedAtMs: 1,
                    placements: input.placements!.map(placement => ({ desired: true, listener: placement.listener,
                        dockerEngineId: placement.dockerEngineId,
                        content: { contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                        placement: { serverId: 'srv_template_home', accountId, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
                            domainId: input.domainId, machineId: placement.machineId, installationId: placement.installationId,
                            nativeServer: placement.nativeServer, requestId: context.actionRequestId!,
                            actionOperationId: context.operationAcceptance!.operationId } })) });
                return { ok: true, environmentId: input.environmentId, revision: environment.environment.revision, domain };
            }
            throw new Error(`Unexpected storage action ${actionId}`);
        };
        const accountSettings = accountSettingsParse({});
        const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: fixture.origin,
            snapshot: { source: 'network', settings: accountSettings, settingsVersion: 1, loadedAtMs: 1,
                scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const templates = createDeploymentTemplateInstantiationForHost({ credentials, serverId: 'srv_template_home', machineId: 'target',
            readInstallation: async () => identity.installationId,
            serverHttpBaseUrl: fixture.origin, savedSecretOperationContext: operation, assertCurrent: async () => {},
            headers: async () => ({}), storage, readEnvironment: async () => environment,
            readCreationDefaultInputs: request => readDeploymentCreationDefaultInputsForHost(request, { serverId: 'srv_template_home',
                serverHttpBaseUrl: fixture.origin, accountId, expectedScopeKey: resolveAccountSettingsScopeKey(credentials),
                assertCurrent: async () => {}, headers: async () => ({}),
                open: async () => { throw new Error('No Project defaults content'); }, readAccountSnapshot: operation.readSnapshot }),
            createContent: async (content, kind, _context, authority) => { await authority.assertCurrent();
                const contentArtifactId = `content-${contents.size}`; contents.set(contentArtifactId, content);
                put(contentArtifactId, kind, content); return { contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 }; },
            async deploy(input, context, admittedTemplateSource) {
                const prepared = await installed.prepareDeploymentAction({ actionId: 'deployments.deploy', input, context, admittedTemplateSource });
                if ('errorCode' in prepared) return prepared;
                if ('observePendingOperation' in prepared) throw new Error('No pending deploy');
                if (!context.hostReviewedChild) throw new Error('Missing reviewed child issuer');
                const result = await context.hostReviewedChild.invoke({ action: 'deployments.deploy', role: 'template.deploy',
                    input: normalizeStrictJsonValue(prepared.input) });
                return result.ok ? DeploymentReceiptResultV1Schema.parse(result.result) : result;
            } });
        const domainActions = createOwnServerDomainActions({ credentials, serverId: 'srv_template_home', machineId: 'target',
            serverHttpBaseUrl: fixture.origin, storage, headers: async () => ({}), readEnvironment: async () => environment,
            readInstallation: async () => identity.installationId, open: async () => { throw new Error('No tunnel content read'); },
            persistPreparedContent: async () => { throw new Error('No tunnel rewrite'); },
            createContent: async (content, _owner, context) => {
                const created = await runWithServerHttpBaseUrl(fixture.origin, () => createCredentialedAccountArtifactStore(credentials)
                    .create({ header: { kind: DEPLOYMENT_DOMAIN_ARTIFACT_KIND_V1, title: 'Domain' },
                        body: JSON.stringify(content), signal: context.signal }));
                return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                    contentBodyVersion: created.revision.bodyVersion };
            },
            dispatch: async job => {
                if (job.kind === 'domainDiscover' && outcome === 'discoveryFailure') return { ok: false, errorCode: 'service_unavailable' };
                if (job.kind === 'domainDiscover') return DeploymentDomainMachineTopologyV1Schema.parse({ machineId: 'target',
                    installationId: identity.installationId, dockerEngineId: 'engine', privateNetworks: [], replicas: [],
                    caddy: { status: 'ready', containerId: 'caddy', containerName: 'owned-caddy', adminSocketPath: '/run/caddy.sock',
                        networkNames: ['app'], servers: [
                            { serverId: 'private_app', listen: [':8080'], tls: false, automaticHttpsDisabled: true, endpoints: [] },
                            { serverId: 'public_app', listen: [':443'], tls: true, automaticHttpsDisabled: false,
                                endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] },
                        ] } });
                nativeEffects++;
                if (outcome === 'nativeFailure') return { ok: false, errorCode: 'service_unavailable' };
                const observation = { capture: job.capture, state } satisfies DeploymentDomainObservationBodyV1;
                return { ...observation, proof: signMachineInstallationProof({ privateKey: identity.privateKey,
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: job.expectedDomainRevision, observation }) }) };
            } });
        const ownerIdentity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'srv_template_home',
            resolveHostIdentity: async () => ({ machineId: 'target', installationId: identity.installationId, custodianAccountId: accountId }) });
        const resolveRequesterIdentity = async (context: ActionExecutorContext) => {
            const requester = await ownerIdentity.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        };
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'srv_template_home', machineId: 'target',
                serverHttpBaseUrl: fixture.origin, resolveRequesterIdentity,
                acquirePluginRuntimeRegistryLease: async () => mounted.lease,
                readEnvironmentSecretLaunchAdmission: readEnvironmentSecretLaunchAdmissionForHost });
        const installed = createDaemonDeploymentActionDeps({ credentials, serverId: 'srv_template_home', machineId: 'target', resolveRequesterIdentity,
            serverHttpBaseUrl: fixture.origin, savedSecretOperationContext: operation,
            runtime });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            prepareHostReviewedChildren: installed.prepareHostReviewedChildren,
            resolveEnvironmentApprovalScope: installed.resolveEnvironmentApprovalScope,
            prepareDeploymentEnvironmentCreate: ({ input, context, creationReview }) => templates.prepareCreate(input, context, creationReview),
            prepareDeploymentTemplateInstantiation: ({ input, context }) => templates.prepare(input, context),
            deploymentTemplateInstantiate: templates.instantiate,
            deploymentAction: async (actionId, input, context, review) => actionId === 'deployments.environments.create'
                ? templates.instantiateCreate(DeploymentEnvironmentCreateIntentInputV1Schema.parse(input), context, review)
                : actionId === 'deployments.deploy' ? installed.deploymentAction(actionId, input, context)
                : domainActions(actionId, input, context),
        });
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ mode: 'apply', serverId: 'srv_template_home',
            ...(outcome === 'newProject' ? { newProject: { name: 'Project', requestKey: 'new-project', owner: { kind: 'account', accountId } } }
                : { projectSourceId: 'project' }),
            name: 'App', requestKey: 'create-domain', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'target', definition: { from: 'catalogApp', templateRef },
            firstTargetLink: { machines: [{ machineId: 'target', installationId: identity.installationId }] },
            domainBindings: [{ templateDomainId: 'web', hostname: 'app.example.test' }] });
        if (outcome === 'optionalOnly') {
            const context = { runtimeAccountId: accountId, actionRequestId: 'catalog-root' };
            expect(await templates.prepareCreate(input, context)).toMatchObject({ ok: false, errorCode: 'template_domain_route_required' });
            const unselected = await templates.prepareCreate({ ...input, domainBindings: undefined }, context);
            expect(unselected).toHaveProperty('input');
            if ('preview' in unselected) expect(unselected.preview).toMatchObject({ template: { domains: [] } });
            expect(writes).toEqual([]);
            return;
        }
        expect(await templates.prepareCreate({ ...input, domainBindings: undefined }, { runtimeAccountId: accountId }))
            .toMatchObject({ ok: false, errorCode: 'template_domain_required' });
        expect(writes).toEqual([]); expect(contents.size).toBe(0);
        // Store's first install and retained retry share the instantiate Action root.
        const templateRoot = outcome === 'firstInstall' || outcome === 'deployRetry';
        if (!templateRoot) expect(await templates.prepareCreate(input, { runtimeAccountId: accountId, actionRequestId: 'catalog-root' }))
            .toMatchObject({ input: { requestKey: input.requestKey }, preview: { template: { deploy: { requestKey: input.requestKey } } } });
        const rootAction = templateRoot ? 'deployments.templates.instantiate' as const : 'deployments.environments.create' as const;
        let rootInput = templateRoot ? DeploymentTemplateInstantiateInputV1Schema.parse({
            mode: 'apply', serverId: input.serverId, machineId: 'target', projectSourceId: input.projectSourceId, templateRef,
            environment: { kind: 'create', name: input.name, requestKey: input.requestKey, protection: input.protection,
                purpose: input.purpose, deployerMode: input.deployerMode, controllerMachineId: 'target' },
            target: { kind: 'new', installationId: identity.installationId }, destination: { kind: 'stored' }, bindings: [],
            domainBindings: input.domainBindings,
        }) : input;
        if (templateRoot) {
            const preview = await executor.execute('deployments.templates.instantiate', { ...rootInput, mode: 'preview' }, {
                surface: 'agent', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: accountId,
                serverId: input.serverId, actionRequestId: 'catalog-preview', executionRunTargetMachineId: 'target',
            });
            expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true,
                result: { kind: 'preview', review: { deploy: { requestKey: input.requestKey } } } });
            const normalized = await templates.prepare(DeploymentTemplateInstantiateInputV1Schema.parse(rootInput),
                { runtimeAccountId: accountId, actionRequestId: 'catalog-admission' });
            expect(normalized).toMatchObject({ input: { deploy: { requestKey: input.requestKey } },
                preview: { deploy: { requestKey: input.requestKey } } });
            if (!('input' in normalized)) throw new Error('Expected canonical install preparation');
            rootInput = normalized.input;
            if (outcome === 'firstInstall') {
                // Home records this person's agent allowance for the reviewed root and children.
                // Default Ask and retained-review freshness stay covered by approval controls.
                const document = AccountSettingsV2GetResponseSchema.parse(settings.data);
                if (document.content?.t !== 'plain') throw new Error('Expected plain fixture Settings');
                let actionsSettingsV1 = setActionApprovalOverride({ settings: accountSettingsParse(document.content.v).actionsSettingsV1,
                    actionId: rootAction, surface: 'agent', approvalRequired: false });
                for (const child of normalized.hostReviewedChildren.children) actionsSettingsV1 = setActionApprovalOverride({
                    settings: actionsSettingsV1, actionId: child.action, surface: 'agent', approvalRequired: false });
                settings.data = { ...document, content: { t: 'plain', v: { ...document.content.v, actionsSettingsV1 } } };
            }
        }
        sourceReads = 0;
        const target = { kind: 'machine' as const, machineId: 'target' };
        const envelope = { v: 1 as const, requestId: 'catalog-root', target, input: rootInput };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'boundary-issued-catalog-root', binding: {
            serverIdentityId: 'srv_template_home', accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 7 },
            machineId: 'target', installationId: identity.installationId, actionId: rootAction,
            requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
            admittedMachineRole: 'manage', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId: rootAction, envelope }) } });
        const requester = await prepareRequesterAccountActionContext({ authorization: sealExternalActionRequesterAccountContextV1({ authorization,
            purpose: { kind: 'external_action' }, credentials: { token: credentials.token, secret: null, encryption: null },
            installationPublicKey: Buffer.from(identity.publicKey, 'base64url'), randomBytes: size => new Uint8Array(randomBytes(size)) }),
            purpose: { kind: 'external_action' }, machineId: 'target', installationId: identity.installationId,
            installationPrivateKey: Buffer.from(identity.privateKey, 'base64url'), serverId: 'srv_template_home', serverIdentityId: 'srv_template_home',
            serverHttpBaseUrl: fixture.origin, ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => executor });
        if (!requester) throw new Error('Expected requester content custody');
        onTestFinished(() => requester.dispose());
        const prepared = await executor.prepare(rootAction, rootInput, { surface: outcome === 'firstInstall' ? 'agent' : 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, runtimeAccountId: accountId, serverId: 'srv_template_home', serverIdentityId: 'srv_template_home',
            actionsSettings: requester.actionsSettings,
            actionRequestId: envelope.requestId, executionRunTargetMachineId: 'target',
            externalActionTarget: target, originalActionEnvelope: envelope, externalActionExecutionAuthorization: requester.authorization,
            operationAcceptance: { operationId: 'catalog-operation', accept() {} } });
        expect(prepared.kind === 'settled' ? prepared.result : prepared).toMatchObject({ kind: 'ready' });
        if (prepared.kind !== 'ready') throw new Error('Expected one root review');
        expect(writes).toEqual([]);
        expect(sourceReads).toBe(outcome === 'newProject' ? 0 : 1);
        sourceCanManage = false;
        const result = await prepared.invocation.run();
        if (outcome === 'deployRetry') {
            expect(result).toMatchObject({ ok: false, errorCode: 'deployment_failed', details: { kind: 'partial', phase: 'deploy',
                environmentId: environment.environment.id, targetLinkId: link.id,
                deployment: { ok: true, deploymentId: 'receipt', state: 'failed' } } });
            expect(domain).toBeUndefined();
            expect(sourceReads).toBe(1);
            expect(writes).toEqual(['deployments.environments.create', 'deployments.bindings.set', 'deployments.deploy']);
            const definition = environment.content.definition;
            if (definition.kind !== 'stored') throw new Error('Expected acknowledged stored definition');
            const retry = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'srv_template_home', machineId: 'target',
                projectSourceId: 'project', templateRef, environment: { kind: 'existing', environmentId: environment.environment.id,
                    expectedRevision: environment.environment.revision }, target: { kind: 'existing', targetLinkId: link.id,
                    expectedRevision: link.revision, installationId: identity.installationId }, destination: { kind: 'stored',
                    contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
                bindings: [], domainBindings: input.domainBindings, deploy: { requestKey: 'retry-deploy' } });
            const retryEnvelope = { ...envelope, requestId: 'retry-root', input: retry };
            const retryAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: { ...authorization.binding,
                actionId: 'deployments.templates.instantiate', requestId: retryEnvelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(retryEnvelope),
                deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({
                    actionId: 'deployments.templates.instantiate', envelope: retryEnvelope }) } });
            const retryRequester = await prepareRequesterAccountActionContext({ authorization: sealExternalActionRequesterAccountContextV1({
                authorization: retryAuthorization, purpose: { kind: 'external_action' },
                credentials: { token: credentials.token, secret: null, encryption: null },
                installationPublicKey: Buffer.from(identity.publicKey, 'base64url'), randomBytes: size => new Uint8Array(randomBytes(size)) }),
                purpose: { kind: 'external_action' }, machineId: 'target', installationId: identity.installationId,
                installationPrivateKey: Buffer.from(identity.privateKey, 'base64url'), serverId: 'srv_template_home', serverIdentityId: 'srv_template_home',
                serverHttpBaseUrl: fixture.origin, ownCredentials: credentials, isCurrent: async () => true, createExecutor: () => executor });
            if (!retryRequester) throw new Error('Expected retry requester custody');
            onTestFinished(() => retryRequester.dispose());
            sourceCanManage = true; sourceReads = 0;
            const resumed = await executor.prepare('deployments.templates.instantiate', retry, { surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, runtimeAccountId: accountId, serverId: 'srv_template_home', serverIdentityId: 'srv_template_home',
                actionsSettings: accountSettings.actionsSettingsV1,
                actionRequestId: retryEnvelope.requestId, executionRunTargetMachineId: 'target', externalActionTarget: target,
                originalActionEnvelope: retryEnvelope, externalActionExecutionAuthorization: retryRequester.authorization,
                operationAcceptance: { operationId: 'retry-operation', accept() {} } });
            expect(resumed).toMatchObject({ kind: 'ready' });
            if (resumed.kind !== 'ready') throw new Error('Expected retained Environment review');
            sourceCanManage = false;
            expect(await resumed.invocation.run()).toMatchObject({ ok: true, result: { kind: 'applied', environmentId: environment.environment.id,
                deployment: { ok: true, deploymentId: 'receipt', state: 'succeeded' } } });
            expect(sourceReads).toBe(1);
            expect(domain).toMatchObject({ state: 'active' });
            expect(writes).toEqual(['deployments.environments.create', 'deployments.bindings.set', 'deployments.deploy',
                'deployments.environments.update', 'deployments.bindings.set', 'template.set', 'deployments.deploy',
                'deployments.domains.add', 'domain.transition']);
            return;
        }
        const unavailable = outcome === 'nativeFailure' || outcome === 'discoveryFailure';
        const failureCode = unavailable ? 'service_unavailable' : 'native_route_unavailable';
        if (state !== 'failed') expect(result.ok ? undefined : result, JSON.stringify({ unhandledRequests, writes })).toBeUndefined();
        expect(result).toMatchObject(state === 'failed'
            ? { ok: false, errorCode: failureCode, details: { kind: 'partial', phase: 'domains',
                environmentId: environment.environment.id, errorCode: failureCode } }
            : outcome === 'firstInstall' ? { ok: true, result: { kind: 'applied', environmentId: environment.environment.id,
                deployment: { ok: true, deploymentId: 'receipt', state: 'succeeded' } } }
                : { ok: true, result: { ok: true, environmentId: environment.environment.id } });
        if (outcome === 'discoveryFailure') expect(domain).toBeUndefined();
        else expect(domain).toMatchObject({ state: outcome === 'nativeFailure' ? 'pending' : state,
            environmentId: environment.environment.id, targetLinkId: link.id });
        expect(environment.content.definition).toMatchObject({ kind: 'stored' });
        expect(sourceReads).toBe(1);
        expect(nativeEffects).toBe(outcome === 'discoveryFailure' ? 0 : outcome === 'nativeFailure' ? 1 : 2);
        expect(writes).toEqual(['deployments.environments.create', 'deployments.bindings.set', 'deployments.deploy',
            ...(outcome === 'discoveryFailure' ? [] : ['deployments.domains.add']),
            ...(unavailable ? [] : ['domain.transition'])]);
    }); } finally { Reflect.set(configuration, 'happyHomeDir', originalHome); await mounted.dispose(); await socket.close(); await rm(nativeRoot, { recursive: true, force: true }); await fixture.close(); }
});
