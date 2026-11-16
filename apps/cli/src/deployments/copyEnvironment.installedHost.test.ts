import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, ActionsSettingsV1Schema, ProjectDeploymentDefaultsOutputV1Schema,
    decodePlainArtifactStoredContent, type QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentEnvironmentGetResultV1Schema, DeploymentTargetLinkInputV1Schema, DeploymentTargetLinkResultV1Schema,
    DeploymentTargetLinksListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentContentV1Schema, readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployment-protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { resultSchema as supabaseDataResultSchema } from '../../../../packages/plugins/deployment-supabase/src/data/schemas';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('copies through the installed data declaration and reviewed children without reprovisioning a retried Create', async () => {
    const pluginId = 'example.copy-data';
    const serverHttpBaseUrl = 'https://copy-home.test';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
    const account = { service: { pluginId, localId: 'service' }, accountId: 'fresh-account' };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    const connectedAccounts = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => bindings, update: async mutate => (bindings = mutate(bindings)), subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => { throw new Error('The author already selected a fresh account'); },
        resolveTarget: async target => target.kind === 'account' ? { displayName: 'Fresh account', account: target.account } : null,
        materializeAccount: async () => { throw new Error('This provider fixture uses no secret headers'); },
        materializeNative: async () => { throw new Error('This provider has no native credentials'); },
        projectTargetAccounts: async () => { throw new Error('No account enumeration'); },
        assertTargetAccountMaterializable: async () => {},
    });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
        })),
        runtimeOptions: { resolveCurrentMachineId: () => 'controller', connectedAccounts, actionFormConnectedAccounts: connectedAccounts,
            deploymentAccountExecution: { credentials, serverUrl: serverHttpBaseUrl, serverId: 'home', serverIdentityId: 'home',
                machineId: 'controller', isCurrent: async () => true } },
        plugins: [{ manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Copy data fixture',
            entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts',
                reason: 'Use the explicitly selected account', scope: { serviceRefs: ['service'], operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
            contributes: {
                connectedAccountDescriptors: [{ id: 'service', title: 'Provider', authentication: { defaultModeId: 'manual', modes: [{
                    id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                }] } }],
                actions: [{ id: 'provision', title: 'Create database', scopes: ['global'], surfaces: ['cli', 'plugin', 'ui'], placementBindings: [],
                    execution: { target: 'daemon' }, hostAccess: ['manage'], dangerLevel: 'writesRemote',
                    confirmation: { title: 'Create the selected database?' },
                    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }],
                    inputSchema: DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema,
                    resultSchema: supabaseDataResultSchema('projects-provision'),
                }],
                deploymentTargets: [{ id: 'database', role: 'data', title: 'Database', icon: 'database', targetKind: 'postgres',
                    targetSchema: { type: 'object', properties: {}, additionalProperties: false },
                    linkSchema: { type: 'object', properties: {}, additionalProperties: false }, dataV1: { projects: { provision: 'provision' } },
                }],
            },
        }, files: { 'daemon.mjs': `export function activate(api) {
            api.actions.register('provision', async input => {
                const response = await fetch('https://copy-provider.test/projects', { method: 'POST', body: JSON.stringify(input) });
                return await response.json();
            });
            api.connectedAccounts.register('service', {
                authentication: { modes: { manual: { kind: 'manual', async complete() { return { status: 'connected', displayName: 'Provider', scopes: [] }; } } } },
                async status() { return { status: 'connected', displayName: 'Provider', scopes: [] }; },
                async refresh() { return { status: 'connected', displayName: 'Provider', scopes: [] }; },
                async revoke() { return { status: 'remoteUnsupported' }; },
                async materialize() { throw new Error('No credential disclosure'); },
            });
        }` } }],
    });
    try {
        expect(runtime.registry.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
        const documents = new Map<string, Record<string, unknown>>();
        const homeRequests: string[] = [];
        const boundaryFailures: unknown[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            homeRequests.push(`GET ${path}`);
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const document = documents.get(decodeURIComponent(path.split('/').at(-1)!));
            if (!document) { boundaryFailures.push({ method: 'GET', path, error: 'missing_artifact' }); return { status: 404, data: { error: 'not_found' } }; }
            return { status: 200, data: document };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
            const path = new URL(String(url)).pathname;
            if (path !== '/v1/artifacts') { boundaryFailures.push({ method: 'POST', path, error: 'unexpected_path' }); return { status: 404, data: { error: 'not_found' } }; }
            let body: ReturnType<typeof readCarrierMutation>;
            try { body = readCarrierMutation(raw); } catch (error) {
                boundaryFailures.push({ method: 'POST', path, errorClass: error instanceof Error ? error.name : 'unknown' });
                return { status: 400, data: { error: 'invalid_parameters' } };
            }
            const id = String(body.id);
            documents.set(id, { ...body, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
        });
        const source = createDeploymentEnvironmentDetailV1();
        source.content.bindings = [];
        source.content.definition = await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services: {}', profiles: [], services: [] });
        source.content = DeploymentEnvironmentContentV1Schema.parse(source.content);
        const sourceArtifact = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createDeploymentArtifactForHost({
            artifacts: createCredentialedAccountArtifactStore(credentials), owner: { kind: 'account', accountId: 'owner' },
            async assertCurrent() {}, content: { header: { kind: 'deployment-environment.v1', title: 'Source' }, body: JSON.stringify(source.content) },
        }));
        Object.assign(source.environment, { id: 'source-env', projectSourceId: 'source', owner: { kind: 'account', accountId: 'owner' },
            contentArtifactId: sourceArtifact.artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 });
        delete source.environment.runtimeTargetLinkId;
        const openedSource = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createCredentialedAccountArtifactStore(credentials).read(sourceArtifact.artifactId));
        expect(readDeploymentEnvironmentArtifactV1(source.environment, openedSource), JSON.stringify(openedSource)).toMatchObject({ ok: true });
        const sourceData = createDeploymentTargetLinkHeaderV1({ id: 'source-data', environmentId: source.environment.id, role: 'data',
            source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } }, targetKind: 'postgres', machines: [], members: [] });
        const destination = { ...source.environment, id: 'created-env', revision: 1 };
        let environmentWrites = 0;
        const associated: ReturnType<typeof DeploymentTargetLinkInputV1Schema.parse>[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            homeRequests.push(`${request.method} ${path}`);
            if (request.method === 'GET' && path === '/v1/projects/sources/source') return { status: 200, data: { ok: true, canManage: true,
                source: { id: 'source', revision: 1, name: 'Project', owner: { kind: 'account', accountId: 'owner' },
                    audience: [], createdByAccountId: 'owner' } } satisfies ReturnType<typeof ProjectSourcesReadOutputV1Schema.parse> };
            if (request.method === 'GET' && path === '/v1/projects/source/deployment-defaults') return { status: 200,
                data: { ok: true, projectSourceId: 'source', sourceRevision: 1, revision: 0, content: null } satisfies ReturnType<typeof ProjectDeploymentDefaultsOutputV1Schema.parse> };
            if (request.method === 'GET' && path.startsWith('/v1/deployments/environments/')) return { status: 200,
                data: { ok: true, environment: path.endsWith('/source-env') ? source.environment : destination,
                    secretScope: source.secretScope, targetLinks: path.endsWith('/source-env') ? [sourceData] : [] } satisfies ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse> };
            if (request.method === 'POST' && path === '/v1/deployments/environments') {
                environmentWrites++;
                const parsed = DeploymentEnvironmentCreateStorageInputV1Schema.safeParse(request.data);
                if (!parsed.success) { boundaryFailures.push({ method: request.method, path, issues: parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })) }); return { status: 400, data: { error: 'invalid_parameters' } }; }
                const input = parsed.data;
                if (environmentWrites === 1) Object.assign(destination, { projectSourceId: input.projectSourceId,
                    protection: input.protection, purpose: input.purpose, deployerMode: input.deployerMode,
                    controllerMachineId: input.controllerMachineId, buildMachineId: input.buildMachineId, contentArtifactId: input.contentArtifactId,
                    contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion });
                return { status: 200, data: { ok: true, environmentId: destination.id, projectSourceId: 'source', revision: destination.revision,
                    replayed: environmentWrites > 1 } satisfies ReturnType<typeof DeploymentEnvironmentCreateResultV1Schema.parse> };
            }
            if (path === '/v1/deployments/targets/list') return { status: 200,
                data: { ok: true, items: [], coverage: 'complete', nextCursor: null } satisfies ReturnType<typeof DeploymentTargetLinksListResultV1Schema.parse> };
            if (request.method === 'POST' && path === '/v1/deployments/environments/created-env/targets') {
                const parsed = DeploymentTargetLinkInputV1Schema.safeParse(request.data);
                if (!parsed.success) { boundaryFailures.push({ method: request.method, path, issues: parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path })) }); return { status: 400, data: { error: 'invalid_parameters' } }; }
                const linked = parsed.data; associated.push(linked);
                destination.revision++;
                return { status: 200, data: { ok: true, environmentId: destination.id, revision: destination.revision,
                    targetLinkId: 'created-data', targetLinkRevision: 1 } satisfies ReturnType<typeof DeploymentTargetLinkResultV1Schema.parse> };
            }
            boundaryFailures.push({ method: request.method, path, error: 'unexpected_path' });
            return { status: 404, data: { error: 'not_found' } };
        });
        const providerRequests: Record<string, unknown>[] = [];
        // Home HTTP and third-party provider HTTP are the only substituted boundaries.
        vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
            const endpoint = new URL(url instanceof Request ? url.url : String(url));
            const method = init?.method ?? (url instanceof Request ? url.method : 'GET');
            if (endpoint.origin !== 'https://copy-provider.test' || endpoint.pathname !== '/projects' || method !== 'POST') {
                boundaryFailures.push({ method, path: endpoint.pathname, error: 'unexpected_fetch' });
                return new Response(null, { status: 404 });
            }
            try { providerRequests.push(JSON.parse(String(init?.body))); } catch (error) {
                boundaryFailures.push({ method: 'POST', path: '/projects', errorClass: error instanceof Error ? error.name : 'unknown' });
                return new Response(null, { status: 400 });
            }
            return new Response(JSON.stringify({ state: 'provisioned', status: 'ACTIVE', ready: true, engine: 'postgres', providerResourceOrigin: 'created',
                providerConsole: { url: 'https://copy-provider.test/projects/resource-1', label: 'Database' },
                providerIdentity: { providerAccountId: 'fresh-provider', providerResourceId: `resource-${providerRequests.length}`,
                    providerEnvironment: 'main' }, providerEnvironment: { kind: 'custom', id: 'main' } }),
            { status: 201, headers: { 'content-type': 'application/json' } });
        });
        const savedSecretOperationContext = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
            credentials, serverHttpBaseUrl, isCurrent: async () => true, snapshot: { source: 'network', settings: accountSettingsParse({}),
                settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] },
        }));
        const acquireLease = async () => runtime.controller.tryAcquireRuntimeRegistry() ?? (() => { throw new Error('Retired fixture'); })();
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl, machineId: 'controller', savedSecretOperationContext,
            acquirePluginRuntimeRegistryLease: acquireLease, resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { async acquire() { throw new Error('Data Create has no native runtime effect'); } },
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner' });
        const reviews: { actionId: string; input: unknown; preview: unknown }[] = [];
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps, runActionOperation: operations.runActionOperation,
            presentUserActionConfirmation: async request => {
                reviews.push({ actionId: request.actionId, input: request.input, preview: request.preview });
                return true;
            },
            listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
            invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease }),
        });
        const action = { pluginId, localId: 'provision' };
        const principal = { kind: 'account', accountId: 'owner', purpose: { consumer: action, purpose: 'manage' }, target: { kind: 'account', account } };
        const context: ActionExecutorContext & RpcActionExecutorContext = { authority: 'present_user', actionCaller: { kind: 'host' }, surface: 'ui', serverId: 'home',
            serverIdentityId: 'home', runtimeAccountId: 'owner', actionRequestId: 'copy-request', signal: new AbortController().signal,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'deployments.environments.create': { approvalRequiredSurfaces: ['ui'] } } }),
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'controller', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true,
        };
        const authoredIntent = DeploymentEnvironmentCreateIntentInputV1Schema.parse({
            serverId: 'home', projectSourceId: 'source', requestKey: 'stable-copy', name: 'Copied environment', controllerMachineId: 'controller', retainPreviousDeployments: 0,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', copyFrom: { environmentId: source.environment.id,
                expectedRevision: source.environment.revision, choices: { secrets: [], values: [], data: [{ targetLinkId: sourceData.id,
                    kind: 'createEmpty', provision: { action, input: { v: 1, serverId: 'home', credentialRef: account,
                        credentialPrincipal: principal, providerAccountId: 'fresh-provider', providerEnvironment: { kind: 'custom', id: 'main' } } } }] } },
        });
        const prepared = await deps.prepareDeploymentEnvironmentCreate!({ context, input: authoredIntent });
        expect(prepared, JSON.stringify({ prepared, homeRequests })).not.toHaveProperty('errorCode');
        if ('errorCode' in prepared) throw new Error(JSON.stringify(prepared));
        const first = await executor.execute('deployments.environments.create', prepared.input, context);
        expect(boundaryFailures, JSON.stringify({ first, homeRequests, providerWrites: providerRequests.length, reviewedActionIds: reviews.map(value => value.actionId) })).toEqual([]);
        expect(first, JSON.stringify({ first, homeRequests, providerWrites: providerRequests.length, reviewedActionIds: reviews.map(value => value.actionId) })).toMatchObject({ ok: true, result: { ok: true, environmentId: destination.id,
            projectSourceId: 'source', replayed: false, revision: 2 } });
        expect(providerRequests).toHaveLength(1);
        expect(providerRequests[0]).toMatchObject({ environmentId: destination.id, expectedRevision: 1, credentialPrincipal: principal });
        expect(associated).toHaveLength(1);
        const dataLinkArtifact = documents.get(associated[0]!.contentArtifactId)!;
        const dataLinkBody = decodePlainArtifactStoredContent(String(dataLinkArtifact.body));
        if (!dataLinkBody || typeof dataLinkBody !== 'object' || !('body' in dataLinkBody) || typeof dataLinkBody.body !== 'string')
            throw new Error('Expected stored target-link content');
        expect(JSON.parse(dataLinkBody.body)).toMatchObject({ providerResourceOrigin: 'created' });
        const replay = await executor.execute('deployments.environments.create', prepared.input, context);
        expect(replay).toMatchObject({ ok: false, errorCode: 'deployment_conflict', details: {
            kind: 'partial', phase: 'environment', environmentId: destination.id, revision: 2,
            requiredFact: 'data:source-data:createEmpty', remedy: expect.any(String),
        } });
        expect(providerRequests).toHaveLength(1);
        const retryContext = { ...context, actionRequestId: 'copy-request-from-new-session' };
        const retryPrepared = await deps.prepareDeploymentEnvironmentCreate!({ context: retryContext, input: authoredIntent });
        expect(retryPrepared, JSON.stringify(retryPrepared)).not.toHaveProperty('errorCode');
        if ('errorCode' in retryPrepared) throw new Error(JSON.stringify(retryPrepared));
        const retried = await executor.execute('deployments.environments.create', retryPrepared.input, retryContext);
        expect(retried).toMatchObject({ ok: false, errorCode: 'deployment_conflict', details: {
            kind: 'partial', phase: 'environment', environmentId: destination.id, revision: 2,
        } });
        expect(environmentWrites).toBeGreaterThanOrEqual(1);
        expect(providerRequests, 'The same Create requestKey must not repeat provision in another Action operation').toHaveLength(1);
        const diagnostic = JSON.stringify({ first, homeRequests, providerWrites: providerRequests.length, reviewedActionIds: reviews.map(value => value.actionId) });
        const review = reviews.find(value => value.actionId === 'deployments.environments.create');
        expect(review?.input, diagnostic).toMatchObject({ copyPlan: { data: [{ contribution: { pluginId, localId: 'database' },
                    provision: { action: { pluginId, localId: 'provision' } } }] } });
        expect(review?.preview, diagnostic).toMatchObject({ hostReviewedChildren: { children: expect.arrayContaining([
                    expect.objectContaining({ action: { pluginId, localId: 'provision' }, role: 'copy-data-provision:source-data' }),
                    expect.objectContaining({ action: 'deployments.targets.link', role: 'copy-data-link:source-data' }),
                ]) } });

    } finally { await runtime.dispose(); }
});
