import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema, QualifiedConnectedAccountRefSchema, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { createManagedMachineAcquisitionDriver } from '@/machines/managed/acquire';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { resolveAccountExecutionRuntime } from './accountExecutionRuntime';
import { PLUGIN_MANIFEST as boatManifest } from '../../../../../packages/plugins/machine-boat/src/manifest';
import { PLUGIN_MANIFEST as agent37Manifest } from '../../../../../packages/plugins/machine-agent37/src/manifest';
import { PLUGIN_MANIFEST as vercelManifest } from '../../../../../packages/plugins/deploy-vercel/src/manifest';
import { openApiTypedRuntimeLog } from '../../../../../packages/plugins/deploy-vercel/src/platform/fixtures/runtimeLogResponse';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentPlatformContentV1Schema } from '@happier-dev/deployment-protocol';
import { encodePlainArtifactStoredContent, DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema,
    DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createDaemonHostResourceRead } from '@/rpc/handlers/daemonHostResourceRead';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from './invocation/actions/createCommittedContributedActionDeps';
import { createStablePluginUiResourceWatchOwner } from './invocation/services/uiResourceWatch';

const vendor = vi.hoisted(() => ({ request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>() }));
// test-policy-boundary: Undici is the third-party network transport; credential composition stays real.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(),
    fetch: (url: string, init?: RequestInit) => vendor.request(url, init),
}));
afterEach(() => { vi.restoreAllMocks(); });

it.each([
    { name: 'Boat native-only credentials on the held Machine registry', borrowNativeRegistry: true, manifest: boatManifest, directory: 'machine-boat', serviceId: 'boat-account', provisionerId: 'boat', origin: 'https://boat.dev' },
    { name: 'Agent37 portable credentials on the held Machine registry', borrowNativeRegistry: true, manifest: agent37Manifest, directory: 'machine-agent37', serviceId: 'agent37-account', provisionerId: 'agent37', origin: 'https://api.agent37.com' },
    { name: 'Agent37 portable credentials on the default Account registry', borrowNativeRegistry: false, manifest: agent37Manifest, directory: 'machine-agent37', serviceId: 'agent37-account', provisionerId: 'agent37', origin: 'https://api.agent37.com' },
])('runs controller-bound Account checks with the selected $name', async fixture => {
    const directory = await mkdtemp(join(tmpdir(), 'account-role-credentials-'));
    const app = fastify();
    const home = 'https://account-role-credentials.test';
    const accountId = 'requester';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const account = { service: { pluginId: fixture.manifest.id, localId: fixture.serviceId }, accountId: 'selected-cloud' };
    const settings = accountSettingsParse({});
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId: 'srv_role_credentials', settings,
        qualifiedCredential: { read: () => credential, write: next => { credential = next; } } });
    const features = FeaturesResponseSchema.parse({ ...homeFeatures, capabilities: {
        ...homeFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
    } });
    const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugins', fixture.directory);
    await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        // Both packages export their Account artifact from manifest.ts; index.ts is their daemon entry.
        manifest: fixture.manifest, projectRoot, entryPath: join(projectRoot, 'src/manifest.ts'), manifestExport: null,
    } });
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, metadata: { scopes: [] },
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { token: 'selected-private-key' } }, randomBytes: length => new Uint8Array(length) }),
        });
    app.get<{ Querystring: { ref: string } }>('/v4/connect/qualified/credential', request => {
        expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        const ref = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, request.query.ref);
        expect(ref).toEqual(account);
        return credential;
    });
    app.get('/v4/connect/qualified/configuration', async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
    app.get('/v4/connect/qualified/accounts', () => QualifiedConnectedAccountListResponseV4Schema.parse({ service: account.service,
        accounts: [{ ref: account, authenticationModeId: 'token', status: 'connected', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationRevision: null, configurationReady: true, scopes: [] }],
    }));
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: home });
    let native: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    let runtime: Awaited<ReturnType<typeof resolveAccountExecutionRuntime>> | undefined;
    let current = true;
    vendor.request.mockReset();
    vendor.request.mockImplementation(async (url, init) => {
        expect(new URL(url).origin).toBe(fixture.origin);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-private-key');
        return Response.json(fixture.directory === 'machine-boat' ? { ok: true, type: 'limits.info' } : { data: [] });
    });
    try {
        await runWithServerHttpBaseUrl(home, async () => {
            await ensureCliActionPolicySettings(credentials, home);
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected requester Account settings');
            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
                serverHttpBaseUrl: home, isCurrent: async () => current });
            native = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: directory, pluginIds: [fixture.manifest.id],
                resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
                    registeredRootId: `credential-fixture:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
            });
            expect(await native.resolveConnectedAccountRuntime?.(account.service)).toBeTruthy();
            const input = { happyHomeDir: directory,
                ...(fixture.borrowNativeRegistry ? { credentialRuntimeRegistry: native } : {}),
                resolveServerFeaturesSnapshot: () => ({ status: 'ready' as const, features }),
                accountExecution: { credentials, serverUrl: home, machineId: 'controller', explicitMachineId: 'controller',
                    savedSecretOperationContext, isCurrent: () => current },
            };
            runtime = await resolveAccountExecutionRuntime(input);
            if (!runtime.purposeRuntime) throw new Error('Expected the requester purpose owner');
            const authority = createManagedProviderOperationAuthority({ materializationBaseDir: directory,
                purposeBindingOwner: runtime.purposeRuntime.purposes, requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
                resolveRequestAuthHttpPort: () => 43123, createRedactionLease: () => ({ add() {}, close() {} }),
            });
            const controller = { machineId: 'controller', installationId: 'installation' };
            const contribution = { pluginId: fixture.manifest.id, localId: fixture.provisionerId };
            const accountHost = runtime;
            const driver = createManagedMachineAcquisitionDriver({ token: credentials.token, credentials, serverUrl: home,
                homeId: 'srv_role_credentials', controller, runtimeRegistry: native, managedProviderOperationAuthority: authority,
                homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_role_credentials',
                    canonicalServerUrl: home, revision: 1, endpoints: [{ kind: 'https', url: home }] }, authority: 'current_connection' }),
                resolveAccountRuntime: async () => ({ runtimeRegistry: accountHost.registry, managedProviderOperationAuthority: authority }),
            });
            const checked = await driver.execute('machines.provisioners.check', { homeId: 'srv_role_credentials', controller, contribution,
                credentials: [{ purpose: { consumer: contribution, purpose: 'cloud-api' }, account }],
            }, { requestId: 'controller-check' });
            expect(checked, JSON.stringify(checked)).toMatchObject({ available: true });
            expect(vendor.request).toHaveBeenCalled();
            current = false;
            await expect(runtime.purposeRuntime.established.invokeWithReceipt({ account,
                operation: { kind: 'materialize', request: { kind: 'httpHeaders', origin: fixture.origin, headerNames: ['authorization'] } },
            })).rejects.toThrow();
        });
    } finally {
        await runtime?.registry.dispose();
        await native?.dispose();
        restoreHttp();
        await app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

it('follows real Vercel Account runtime frames through the canonical deployment Action and pages watch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'account-vercel-runtime-'));
    // Existing scripted, schema-backed Home fixture over loopback; CLI admission and custody stay real.
    const app = fastify();
    const accountId = 'requester';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'selected-vercel' };
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId: 'home', settings: accountSettingsParse({}),
        qualifiedCredential: { read: () => credential, write: next => { credential = next; } } });
    const features = FeaturesResponseSchema.parse({ ...homeFeatures, capabilities: {
        ...homeFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
    } });
    app.get('/v1/features', () => features);
    app.get('/v1/features/authenticated', () => features);
    const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugins/deploy-vercel');
    const release = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest: vercelManifest, projectRoot, entryPath: join(projectRoot, 'src/accountRuntime.ts'), manifestExport: null,
    } });
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.owner = { kind: 'account', accountId };
    delete environment.environment.buildMachineId;
    const link = environment.targetLinks[0]!;
    Object.assign(link.targetLink, { source: { kind: 'plugin', contribution: { pluginId: vercelManifest.id, localId: 'runtime' } },
        targetKind: 'vercel', machines: [], members: [], createdByAccountId: accountId });
    const preparation = { credentialPrincipal: { kind: 'account', accountId,
        purpose: { consumer: { pluginId: vercelManifest.id, localId: 'project-link' }, purpose: 'deploy.manage' },
        target: { kind: 'account', account } },
        providerIdentity: { providerAccountId: 'team_selected', providerResourceId: 'project_selected', providerEnvironment: 'production' },
        providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'selected-project' } };
    const receipt = createDeploymentReceiptHeaderV1({ requestedByAccountId: accountId, state: 'running',
        acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' } } });
    const receiptContent = DeploymentPlatformContentV1Schema.parse({ sourceIntent: { kind: 'repository',
        projectSourceId: 'source-app', sourceRevision: 1, sha: 'a'.repeat(40) }, sourceMethod: 'upload',
        machines: [], images: [], machineResults: [], steps: [], platform: { ...preparation,
            targetLinkRevision: link.targetLink.revision,
            observation: { v: 1, state: 'running', providerDeploymentId: 'deployment_selected', observedAtMs: 1 } } });
    const seed = (id: string, kind: string, body: unknown) => release.artifacts.seed(id,
        encodePlainArtifactStoredContent({ kind, title: 'Selected deployment' }),
        encodePlainArtifactStoredContent({ body: JSON.stringify(body) }));
    seed(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
    seed(link.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, preparation);
    seed(receipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receiptContent);
    app.get(`/v1/deployments/environments/${environment.environment.id}`, () => DeploymentEnvironmentGetResultV1Schema.parse({
        ok: true, environment: environment.environment, secretScope: environment.secretScope, targetLinks: [link.targetLink] }));
    app.get(`/v1/deployments/receipts/${receipt.id}`, () =>
        DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt }));
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    let credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: 'configuration-1', metadata: { scopes: [] },
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { token: 'selected-vercel-token' } }, randomBytes: length => new Uint8Array(length) }) });
    app.get<{ Querystring: { ref: string } }>('/v4/connect/qualified/credential', request => {
        expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        const ref = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, request.query.ref);
        expect(ref).toEqual(account);
        return credential;
    });
    app.get('/v4/connect/qualified/configuration', () => QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
        target: { kind: 'account', ref: account }, authenticationModeId: 'token', revisionSemantics: 'revisioned',
        credentialRevision: revision, configurationRevision: 'configuration-1',
        configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain',
            payload: { values: { teamId: 'team_selected', projectId: 'project_selected' }, secretRefs: {} }, randomBytes: length => new Uint8Array(length) }),
    }));
    app.get('/v4/connect/qualified/accounts', () => QualifiedConnectedAccountListResponseV4Schema.parse({ service: account.service,
        accounts: [{ ref: account, authenticationModeId: 'token', status: 'connected', revisionSemantics: 'revisioned',
            credentialRevision: revision, configurationRevision: 'configuration-1', configurationReady: true, scopes: [] }] }));
    const home = await app.listen({ port: 0, host: '127.0.0.1' });
    let native: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    let runtime: Awaited<ReturnType<typeof resolveAccountExecutionRuntime>> | undefined;
    const watches = createStablePluginUiResourceWatchOwner({ isPluginConsumerCurrent: () => false, readPluginOccurrenceId: () => null });
    const cancelled: number[] = [];
    let runtimeRequests = 0;
    let followController: ReadableStreamDefaultController<Uint8Array> | undefined;
    // Replay the typed derivative of the recorded documentation example; the second frame is a further mutation.
    const frames = [openApiTypedRuntimeLog, { ...openApiTypedRuntimeLog, rowId: 'second-provider-row',
        message: 'request completed', level: 'info', source: 'request', requestMethod: 'GET', requestPath: '/ready', responseStatusCode: 200 }] as const;
    vendor.request.mockReset();
    vendor.request.mockImplementation(async (url, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-vercel-token');
        if (new URL(url).pathname === '/v9/projects/project_selected/custom-environments') {
            expect(new URL(url).searchParams.get('teamId')).toBe('team_selected');
            // Derived empty page from the official 200 schema (2026-11-12), not tenant traffic:
            // https://vercel.com/docs/rest-api/environment/retrieve-custom-environments
            return Response.json({ accountLimit: { total: 123 }, environments: [] });
        }
        expect(new URL(url).href).toBe('https://api.vercel.com/v1/projects/project_selected/deployments/deployment_selected/runtime-logs?teamId=team_selected&format=lines');
        const requestNumber = ++runtimeRequests;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            if (requestNumber === 2) followController = controller;
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frames[0])}\n`));
        }, cancel() { cancelled.push(requestNumber); } }), { headers: { 'content-type': 'application/stream+json' } });
    });
    try {
        await runWithServerHttpBaseUrl(home, async () => {
            await ensureCliActionPolicySettings(credentials, home);
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Expected Account settings');
            const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
                serverHttpBaseUrl: home, isCurrent: async () => true });
            native = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: directory, pluginIds: [account.service.pluginId],
                resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development',
                    registeredRootId: `runtime-fixture:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }) });
            runtime = await resolveAccountExecutionRuntime({ happyHomeDir: directory, credentialRuntimeRegistry: native,
                resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
                accountExecution: { credentials, serverUrl: home, serverId: 'home', serverIdentityId: 'home',
                    machineId: 'machine-a', explicitMachineId: 'machine-a',
                    savedSecretOperationContext, isCurrent: () => true } });
            const registry = runtime.registry;
            const acquireLease = async () => ({ registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} });
            const requester = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
                resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: accountId }) });
            const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: home,
                machineId: 'machine-a', acquirePluginRuntimeRegistryLease: acquireLease,
                resolveRequesterIdentity: async context => {
                    const admission = await requester.resolveActionRequester!(context);
                    try { return admission.identity; } finally { await admission.dispose(); }
                }, runtime: { async acquire() { throw new Error('A platform log read must not acquire native execution'); } } });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(registry, selection),
                invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease }) });
            const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: 'home', serverIdentityId: 'home',
                actionRequestId: 'vercel-runtime-read', actionsSettings: snapshot.settings.actionsSettingsV1,
                runtimeAccountId: accountId, actionCaller: { kind: 'host' }, signal: new AbortController().signal,
                machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: 'machine-a',
                    installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
            const input = { serverId: 'home', environmentId: environment.environment.id, deploymentId: receipt.id,
                targetLinkId: link.targetLink.id, machineId: 'machine-a', installationId: 'installation-a', kind: 'runtime' as const };
            const initial = await executor.execute('deployments.logs.read', input, context);
            expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true, result: { ok: true, logs: { kind: 'page',
                page: { sourceRevision: 'deployment_selected', rowId: frames[0].rowId, text: expect.any(String), nextCursor: null, truncated: true } } } });
            if (!initial.ok) throw new Error(JSON.stringify(initial));
            const initialResult = DeploymentActionOutputSchemasV1['deployments.logs.read'].parse(initial.result);
            if (!initialResult.ok || initialResult.logs.kind !== 'page') throw new Error('Expected the finite initial provider page');
            const initialLogs = initialResult.logs;
            expect(JSON.parse(initialLogs.page.text)).toEqual(frames[0]);
            expect(cancelled).toEqual([1]);
            const hostRead = createDaemonHostResourceRead({ readAccountId: () => accountId, resolveActionExecutor: async () => executor });
            const resource = { hostRead: 'deployments.logs' as const, sourceRevision: 'deployment_selected', input };
            const resourceContext = { signal: context.signal!, localActionContext: context };
            const subscription = { hostAccountId: accountId, subscriptionId: 'real-vercel-follow', resource };
            await watches.openHost({ accountId, subscriptionId: subscription.subscriptionId, resource,
                bind: (signal, emit, end) => hostRead.observe(resource, 'machine-a', resourceContext, signal, emit, end) });
            for (const [index, frame] of frames.entries()) {
                if (index === 1) {
                    if (!followController) throw new Error('Expected demanded provider stream');
                    followController.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
                }
                const next = await watches.next(subscription);
                expect(next).toMatchObject({ status: 'event', event: { kind: 'pages' } });
                if (next.status !== 'event' || next.event.kind !== 'pages') throw new Error('Expected finite pushed pages');
                const page = JSON.parse(Buffer.from(next.event.pages[0]!.bytesBase64, 'base64').toString('utf8'));
                expect(page).toEqual({ kind: 'page', page: { sourceRevision: 'deployment_selected', rowId: frame.rowId,
                    text: expect.any(String), nextCursor: null, truncated: true } });
                expect(JSON.parse(page.page.text)).toEqual(frame);
            }
            expect(runtimeRequests).toBe(2); // One finite read and one demand; no per-page rerun/history request.
            expect(await watches.close(subscription)).toBe(true);
            expect(cancelled).toEqual([1, 2]);
        });
    } finally {
        watches.retire();
        await runtime?.registry.dispose();
        await native?.dispose();
        await app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
