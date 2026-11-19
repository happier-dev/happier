import axios from 'axios';
import { readHomeRequestArtifactReference } from '../homeRequestBody.testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, DeploymentTemplateInstantiateInputV1Schema, FeaturesResponseSchema,
    type ApprovalRequestV2, type ActionExecutorContext } from '@happier-dev/protocol';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    ExternalActionExecutionAuthorizationV1Schema, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { admitRequesterAccountActionContext, prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization, resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { updateSettings } from '@/persistence';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { handleActionsCommand } from '@/cli/commands/actions';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; });

it('retains the signed allocated-Source refusal and partial creation through template approval and the CLI', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'template-source-refusal-' }, async () => {
        const endpoint = 'https://template-refusal.test';
        const serverId = 'home';
        const homeId = 'srv_template_refusal';
        const machineId = 'target';
        const installation = await readOrCreateInstallationIdentity();
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
        await updateSettings(settings => ({ ...settings, activeServerId: serverId, servers: { [serverId]: {
            id: serverId, name: 'Home', serverUrl: endpoint, webappUrl: endpoint, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1,
                homeServerIdentityId: homeId, canonicalServerUrl: endpoint, revision: 1, endpoints: [{ kind: 'https', url: endpoint }] }),
        } } }));
        vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0]) => Response.json(String(url).includes('/features')
            ? FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } }, capabilities: { serverIdentity: { serverIdentityId: homeId } } })
            : catalog));
        const registrySource: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
            url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
        const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
            document: 'services:\n  web:\n    image: nginx:1\n', profiles: [], services: ['web'] },
            variables: [], generatedSecrets: [], domains: [], volumes: [] });
        const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
        const registry = createRegistryHostV1({ host: 'node', readSources: async () => [registrySource], http: {
            getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
            getText: async () => { throw new Error('No text transport'); }, getBytes: async () => { throw new Error('No binary transport'); },
        } });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            sourceId: 'apps', kind: 'app', itemId: 'app' })).item;
        if (selected.payload.kind !== 'app') throw new Error('Expected app');
        const { origin: _origin, removable: _removable, ...sourceRow } = registrySource;
        const rows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
            key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
                value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
        })) });
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.serverId = homeId;
        environment.environment.owner = { kind: 'account', accountId: 'owner' };
        environment.environment.projectSourceId = 'allocated-source';
        const link = environment.targetLinks[0].targetLink;
        link.members = [{ machineId, installationId: installation.installationId, state: 'active' }]; link.machines = [machineId];
        const artifactRows = new Map<string, Record<string, unknown>>();
        const keys = { publicKey: Buffer.from(installation.publicKey, 'base64url'), secretKey: Buffer.from(installation.privateKey, 'base64url') };
        const target = { kind: 'machine' as const, machineId };
        const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: homeId, machineId,
            newProject: { name: 'App', requestKey: 'new-project', owner: { kind: 'account', accountId: 'owner' } },
            templateRef: { sourceId: 'apps', itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref },
            environment: { kind: 'create', name: 'App', requestKey: 'create-app', protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: machineId }, target: { kind: 'new', installationId: installation.installationId },
            destination: { kind: 'stored' }, bindings: [], deploy: { requestKey: 'deploy-app' } });
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'never-copy-proof', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            serverIdentityId: homeId, machineId, admittedMachineRole: 'manage', installationId: installation.installationId,
            actionId: 'deployments.templates.instantiate', requestId: 'template-request', requestEnvelopeDigest: 'A'.repeat(43), target,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input),
        } });
        let sourceReads = 0;
        const httpPaths: string[] = [];
        const httpRead = async (href: string) => {
            const path = new URL(href).pathname;
            httpPaths.push(path);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            const machine = { id: machineId, kind: 'persistent', active: true, installationId: installation.installationId,
                revokedAt: null, replacedByMachineId: null, access: { custodian: { accountId: 'owner', displayName: 'Owner' },
                    role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
            if (path === '/v1/machines') return { status: 200, data: [machine] };
            if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: rows };
            if (path.startsWith('/v1/artifacts/')) {
                const artifact = artifactRows.get(decodeURIComponent(path.split('/').at(-1)!));
                if (artifact) return { status: 200, data: artifact };
            }
            throw new Error(`Unexpected Home read ${path}`);
        };
        // Only Home HTTP/persistence and the registry catalog are substituted.
        // Account custody, Artifact codecs, template effects, approval and output remain real.
        vi.spyOn(axios, 'get').mockImplementation(url => httpRead(String(url)));
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            httpPaths.push(new URL(String(url)).pathname);
            if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (String(url).endsWith('/v1/plugins/availability/intents/list')) {
                const pluginIds = readRequestedIntentPluginIds(body);
                return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
                    pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({ pluginId, response: {
                        availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [],
                    } })) }) };
            }
            if (new URL(String(url)).pathname !== '/v1/artifacts') throw new Error('Unexpected Home POST');
            const stored: Record<string, unknown> = { ...(body as Record<string, unknown>), ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            artifactRows.set(String(stored.id), stored);
            return { status: 200, data: stored };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(String(request.url)).pathname;
            httpPaths.push(path);
            if (path === '/v1/projects/sources/allocated-source') {
                sourceReads++;
                expect(request.headers).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
                expect(request.headers).not.toHaveProperty('Authorization');
                expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: 'projects.sources.read', target, installationId: installation.installationId,
                    requestId: authorization.binding.requestId, method: 'GET', path: `${path}?serverId=${homeId}`,
                    signature: String(request.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: keys.publicKey })).toBe(true);
                return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'deployment_preparation' } };
            }
            if (path === '/v1/deployments/environments' && request.method === 'POST') {
                Object.assign(environment.environment, readHomeRequestArtifactReference(request.data));
                Object.assign(link, readHomeRequestArtifactReference(request.data, 'firstTargetLink'));
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 1 } };
            }
            if (path === `/v1/deployments/environments/${environment.environment.id}/bindings`) {
                Object.assign(environment.environment, { ...readHomeRequestArtifactReference(request.data), revision: 2 });
                return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 2 } };
            }
            if (path === `/v1/deployments/environments/${environment.environment.id}`) return { status: 200, data: {
                ok: true, environment: environment.environment, targetLinks: [link] } };
            return httpRead(String(request.url));
        });
        const currentness = await createRequesterCurrentnessSocketHarness();
        const admitted = await admitRequesterAccountActionContext({ authorization, credentials, serverId, serverIdentityId: homeId,
            serverHttpBaseUrl: endpoint, isCurrent: () => isServerProfileHomeIdentity(serverId, homeId) });
        try {
            if (!admitted) throw new Error('Requester admission unavailable');
            const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization, serverId,
                serverIdentityId: homeId, serverHttpBaseUrl: endpoint, target, installationId: installation.installationId,
                privateKey: keys.secretKey, isCurrent: admitted.isCurrent });
            if (!carrier) throw new Error('Requester projection unavailable');
            const daemon = createDaemonDeploymentActionDeps({ credentials, serverId: homeId, machineId, serverHttpBaseUrl: endpoint,
                savedSecretOperationContext: admitted.savedSecretOperationContext,
                resolveRequesterIdentity: async () => { throw new Error('Signed grant owns target identity'); },
                runtime: { acquire: async () => { throw new Error('Refused Source cannot acquire native runtime'); } } });
            let stored: ApprovalRequestV2 | null = null;
            const operations = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => 'owner' });
            let onApprovalRequested: Parameters<typeof createCliActionExecutorHarness>[0]['onApprovalRequested'];
            const { executor } = createCliActionExecutorHarness({ token: credentials.token, sessionId: '', mode: 'plain', ctx: null,
                serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, onApprovalRequested: (...args) => onApprovalRequested?.(...args) }, {
                ...createUnavailableActionTransportDeps(), ...daemon,
                runActionOperation: operations.runActionOperation,
                prepareApprovalExecutionAuthorization: createDaemonApprovalExecutionAuthorizationPreparer({ machineId, serverId,
                    serverBaseUrl: endpoint, requesterAccountContext: admitted, daemonWorkSignal: new AbortController().signal,
                    resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl: endpoint,
                        resolveCurrentMachineId: () => machineId, resolveCurrentServerIdentityId: () => homeId }),
                    prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request, purpose: { kind: 'external_action' },
                        machineId, installationId: installation.installationId, installationPrivateKey: keys.secretKey,
                        serverId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, ownCredentials: credentials,
                        isCurrent: async () => isServerProfileHomeIdentity(serverId, homeId), createExecutor: () => executor }),
                }),
                isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials, machineId, serverId, serverApiUrl: endpoint }),
                approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval' }; },
                approvalsGet: async () => stored,
                approvalsUpdate: async ({ request }) => {
                    if (!stored) throw new Error('Missing approval');
                    const transition = decideApprovalRequestTransition(stored, request);
                    if (!transition.ok) return transition;
                    stored = ApprovalRequestV2Schema.parse(request); return { ok: true };
                },
            });
            let output = '';
            vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
                output += String(chunk); const callback = args.find(argument => typeof argument === 'function');
                if (typeof callback === 'function') callback(); return true;
            });
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const context = { authority: resolveExternalActionRootInvocationAuthority(authorization), runtimeAccountId: 'owner', serverId,
                serverIdentityId: homeId, defaultSessionMachineId: machineId, externalActionTarget: target,
                actionsSettings: admitted.accountSettingsContext.settings.actionsSettingsV1,
                signExternalActionApprovalInput: (request: Parameters<NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>>[0]) =>
                    signExternalActionApprovalInputV1({ ...request, authorizationToken: request.authorization.token, privateKey: keys.secretKey }),
                actionCaller: { kind: 'host' as const } };
            await handleActionsCommand(['invoke', 'deployments.templates.instantiate', '--input-json', JSON.stringify(input), '--request-id', authorization.binding.requestId, '--yes', '--json'], {
                readCredentialsFn: async () => ({ ...credentials, credentialProvenance: 'stored_session' }),
                createExecutorFn: params => {
                    onApprovalRequested = params.onApprovalRequested;
                    return { execute: (id, args, ctx) => executor.execute(id, args, { ...ctx, ...context,
                        ...(id === 'deployments.templates.instantiate' ? { externalActionExecutionAuthorization: carrier }
                            : id === 'approval.request.decide' ? { authority: 'present_user' } : {}) }),
                        resolveSessionTarget: async () => { throw new Error('No Session lookup'); } };
                },
            });
            const error = 'action_forbidden (home_signed_authorization_rejected:deployment_preparation)';
            expect(sourceReads, JSON.stringify({ output, httpPaths })).toBe(1);
            expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'action_forbidden', message: error,
                effectAttempted: true, details: { kind: 'partial', phase: 'deploy', environmentId: environment.environment.id,
                    targetLinkId: link.id, definition: { kind: 'stored', contentRevision: 1 } } } });
            expect(await executor.execute('approval.request.get', { artifactId: 'approval' }, { surface: 'cli', ...context }))
                .toMatchObject({ ok: true, result: { request: { status: 'failed', execution: { error, effectAttempted: true,
                    details: { kind: 'partial', phase: 'deploy', environmentId: environment.environment.id, targetLinkId: link.id } } } } });
            expect(output).not.toContain('never-copy');
        } finally { await admitted?.dispose(); await currentness.close(); }
    });
});
