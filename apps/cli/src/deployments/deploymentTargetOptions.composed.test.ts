import { resolve } from 'node:path';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, createActionExecutor, FeaturesResponseSchema, QualifiedConnectedAccountConfigurationSnapshotV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectInputOptionsDependencies } from '@happier-dev/protocol/inputs';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCommittedContributedActionSchemaReader, createRegistryInputTypeDeps, listRuntimeContributedActionDefinitions }
    from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import * as vercel from '../../../../packages/plugins/deploy-vercel/src/index';
import * as cloudflare from '../../../../packages/plugins/deploy-cloudflare/src/index';
import * as railway from '../../../../packages/plugins/deploy-railway/src/index';
import { PLUGIN_MANIFEST as railwayAccountManifest } from '../../../../packages/plugins/machine-railway/src/manifest';
import { PLUGIN_MANIFEST as accountManifest } from '../../../../packages/plugins/machine-vercel/src/manifest';

// Genuine HTTP boundary: Node's plugin adapter uses Undici's Fetch entry point.
// Keep its real Agent/TLS exports and route both Fetch APIs to the fixture handler.
vi.mock('undici', async importOriginal => ({
    ...await importOriginal<typeof import('undici')>(),
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['vercel', 'cloudflare', 'cloudflare-denied', 'railway'] as const)('resolves the initial UI %s platform draft through the authored Account Resource after runtime activation', async platform => {
    const railwayTarget = platform === 'railway';
    const selectedPlugin = railwayTarget ? railway : platform === 'vercel' ? vercel : cloudflare;
    const selectedAccountManifest = railwayTarget ? railwayAccountManifest : platform === 'vercel' ? accountManifest : cloudflare.manifest;
    const packageName = railwayTarget ? 'deploy-railway' : platform === 'vercel' ? 'deploy-vercel' : 'deploy-cloudflare';
    const accountId = 'options-owner', serverId = 'srv_ui_options_home', origin = 'https://options-home.test';
    const app = fastify();
    const features = registerAccountHomeHttp(app, { accountId, serverId });
    await registerAuthoredAccountActionRelease(app, accountId, { primary: { manifest: selectedPlugin.manifest,
        projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins', packageName),
        entryPath: resolve(import.meta.dirname, '../../../../packages/plugins', packageName, 'src/accountRuntime.ts'), manifestExport: null } });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const descriptor = selectedAccountManifest.contributes.connectedAccountDescriptors![0]!;
    const service = { pluginId: selectedAccountManifest.id, localId: descriptor.id };
    const account = { service, accountId: 'selected-account' };
    const revision = 'csr_abcdefghijklmnopqrstuv';
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
        authenticationModeId: descriptor.authentication.defaultModeId, revisionSemantics: 'revisioned', credentialRevision: revision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Selected Vercel', scopes: [] });
    let acquisitions = 0;
    const unexpected = async (): Promise<never> => { throw new Error('Options never select or persist credentials'); };
    const custody = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: accountId,
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected, resolveTarget: createPurposeTargetResolver({ available: true,
            resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
        resolveCredentialRevision: async () => revision, materializeAccount: async ({ credentialRevisionBasis, observeMaterializationPublicValues, request }) => {
            acquisitions++; credentialRevisionBasis?.captureCredentialRevision(revision);
            if (request.kind === 'environment') {
                if (railwayTarget) return { kind: 'environment', env: {} };
                observeMaterializationPublicValues?.(['team-selected']);
                return { kind: 'environment', env: { VERCEL_TEAM_ID: 'team-selected' } };
            }
            return { kind: 'httpHeaders', headers: { authorization: 'Bearer options-fixture-secret' } };
        }, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected });
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.origin === origin) return Response.json(features);
        expect(parsed.origin).toBe(railwayTarget ? 'https://backboard.railway.com' : platform === 'vercel' ? 'https://api.vercel.com' : 'https://api.cloudflare.com');
        expect(new Headers(init?.headers).get('authorization') === 'Bearer options-fixture-secret').toBe(true);
        requests.push(`${parsed.pathname}${parsed.search}`);
        if (railwayTarget && parsed.pathname === '/graphql/v2') {
            const { query, variables } = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
            const pageInfo = { endCursor: null, hasNextPage: false };
            if (query.includes('serviceInstances')) {
                expect(variables).toMatchObject({ projectId: 'project-selected', environmentId: 'environment-selected' });
                return Response.json({ data: { environment: { id: 'environment-selected', projectId: 'project-selected',
                    serviceInstances: { pageInfo, edges: [{ node: { serviceId: 'service-selected', serviceName: 'Backend', deletedAt: null } }] } } } });
            }
            if (query.includes('environments')) {
                expect(variables).toMatchObject({ projectId: 'project-selected' });
                return Response.json({ data: { project: { environments: { pageInfo,
                    edges: [{ node: { id: 'environment-selected', name: 'Production' } }] } } } });
            }
            if (query.includes('projects')) return Response.json({ data: { projects: { pageInfo,
                edges: [{ node: { id: 'project-selected', name: 'Selected project' } }] } } });
        }
        if (parsed.pathname === '/client/v4/accounts') return Response.json(platform === 'cloudflare-denied'
            ? { success: false, errors: [{ code: 10000, message: 'provider-private-detail' }], result: null }
            : { success: true, result: [{ id: 'account-selected', name: 'Selected Account' }] },
            { status: platform === 'cloudflare-denied' ? 403 : 200 });
        if (parsed.pathname === '/v2/user') return Response.json({ user: { id: 'user-selected', username: 'Selected user' } });
        if (parsed.pathname === '/v2/teams') return Response.json({ teams: [{ id: 'team-selected', name: 'Selected team' }], pagination: { next: null } });
        throw new Error('Unexpected provider endpoint');
    });
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const lifetime = new AbortController();
    const mounted = await createAuthoredAdmittedPluginRuntimeFixture({
        runtimeOptions: { connectedAccounts: custody, actionFormConnectedAccounts: custody,
            accountExecution: { credentials, serverUrl: origin, serverId, serverIdentityId: serverId,
                machineId: 'machine-options', isCurrent: async () => true }, resolveCurrentMachineId: () => 'machine-options' },
        plugins: (selectedAccountManifest.id === selectedPlugin.manifest.id ? [selectedPlugin.manifest]
            : [selectedPlugin.manifest, selectedAccountManifest]).map(manifest => ({ manifest,
            files: { [manifest.entrypoints.daemon]: 'export function activate() {}' },
            ...(manifest.id === selectedPlugin.manifest.id ? { instantiateCommittedModule: () => ({ activate: selectedPlugin.activate }) } : {}) })),
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    try {
        const list = (selection?: Parameters<typeof listRuntimeContributedActionDefinitions>[1]) => listRuntimeContributedActionDefinitions(mounted.registry, selection);
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createRegistryInputTypeDeps(mounted.registry),
            listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list) });
        const localId = 'targets-inspect-v1';
        const actionId = `${selectedPlugin.manifest.id}/actions/${localId}`;
        const purpose = selectedPlugin.manifest.contributes.actions?.find(action => action.id === localId)
            ?.connectedAccountPurposeBindings?.find(binding => binding.path === 'credentialRef')?.purpose;
        if (!purpose) throw new Error('Expected the Inspect Action to declare its Connected Account purpose');
        const draftInput = projectInputOptionsDependencies({ v: 1, serverId, environmentId: 'environment-options', expectedRevision: 1,
            credentialRef: account, credentialPrincipal: { kind: 'account', accountId,
                purpose: { consumer: { pluginId: selectedPlugin.manifest.id, localId }, purpose },
                target: { kind: 'account', account } },
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/project' },
            machineId: 'machine-options' }, undefined, actionId);
        const context = { surface: 'ui' as const, serverId, serverIdentityId: serverId, runtimeAccountId: accountId, signal: lifetime.signal };
        const request = { actionId, fieldPath: platform === 'vercel' || railwayTarget ? 'providerAccountId' : 'providerIdentity.providerAccountId', draftInput };
        const result = await executor.execute('action.options.resolve', request, context);
        if (railwayTarget) {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
                result: { options: [{ value: 'project-selected', label: 'Selected project' }] } });
            const project = { ...draftInput, providerAccountId: 'project-selected' };
            const environments = await executor.execute('action.options.resolve', {
                ...request, fieldPath: 'railwayEnvironmentId', draftInput: project,
            }, context);
            expect(environments, JSON.stringify(environments)).toMatchObject({ ok: true,
                result: { options: [{ value: 'environment-selected', label: 'Production' }] } });
            const services = await executor.execute('action.options.resolve', {
                ...request, fieldPath: 'providerEnvironment', draftInput: { ...project, railwayEnvironmentId: 'environment-selected' },
            }, context);
            expect(services, JSON.stringify(services)).toMatchObject({ ok: true,
                result: { options: [{ value: { kind: 'native', selection: { projectId: 'project-selected',
                    environmentId: 'environment-selected', serviceId: 'service-selected' } }, label: 'Backend' }] } });
            expect(requests).toEqual(['/graphql/v2', '/graphql/v2', '/graphql/v2']);
            return;
        }
        if (platform !== 'vercel') {
            expect(result, JSON.stringify(result)).toMatchObject(platform === 'cloudflare-denied'
                ? { ok: false, errorCode: 'deployment_access_denied' }
                : { ok: true, result: { options: [{ value: 'account-selected', label: 'Selected Account' }] } });
            expect(requests).toEqual(['/client/v4/accounts']);
            expect(acquisitions).toBe(1);
            expect(JSON.stringify(result)).not.toContain('options-fixture-secret');
            expect(JSON.stringify(result)).not.toContain('provider-private-detail');
            return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: [
            { value: 'team-selected', label: 'Selected Vercel' } ] } });
        expect(requests).toEqual([]);
        expect(acquisitions).toBe(1);
        expect(await executor.execute('action.options.resolve', { ...request, query: 'other-scope' }, context))
            .toMatchObject({ ok: true, result: { options: [] } });
        expect(requests).toEqual([]);
        expect(JSON.stringify(result).includes('options-fixture-secret')).toBe(false);
        const readsBeforeMissingCredential = requests.length;
        expect(await executor.execute('action.options.resolve', { ...request, draftInput: {} }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await executor.execute('action.options.resolve', { ...request, fieldPath: 'foreignField' }, context))
            .toMatchObject({ ok: false, errorCode: 'unavailable' });
        expect(requests).toHaveLength(readsBeforeMissingCredential);
    } finally { lifetime.abort(); await mounted.dispose(); restoreHttp(); await app.close(); }
});

it.each([false, true])('resolves the captured partial draft through Account placement with receiver Settings hydration=%s', async hydrateReceiver => {
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const machineId = 'c7911a7d-73f1-4657-a3ba-0e7d3f4d466b';
    const origin = 'https://r6-options-home.test';
    const app = fastify();
    const features = registerAccountHomeHttp(app, { accountId, serverId,
        qualifiedCredential: { read: () => credential, write: next => { credential = next; } } });
    const qualifiedFeatures = FeaturesResponseSchema.parse({ ...features,
        features: { ...features.features, connectedServices: { enabled: true } },
        capabilities: { ...features.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } });
    await registerAuthoredAccountActionRelease(app, accountId, { additional: [{ manifest: accountManifest,
        projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/machine-vercel'),
        entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/machine-vercel/src/manifest.ts'), manifestExport: 'PLUGIN_MANIFEST' }], primary: {
        manifest: vercel.manifest, projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/deploy-vercel'),
        entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/deploy-vercel/src/accountRuntime.ts'), manifestExport: null } });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    // External admission retains this private requester holder. Subsequent
    // calls must not borrow the receiving daemon's incumbent snapshot.
    const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: origin, isCurrent: async () => true });
    const account = { service: { pluginId: accountManifest.id, localId: 'vercel-account' }, accountId: 'e200efeb-bcd4-417b-bad1-9c600b4fb89f' };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const configurationRevision = 'r6-vercel-configuration';
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected', authenticationModeId: 'token',
        revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true, configurationRevision,
        kind: 'token', expiresAt: null, displayName: 'Selected Vercel', scopes: [] });
    const sentinel = 'r6-options-fixture-secret';
    let credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'token',
        revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision,
        content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
            payload: { v: 1, values: { token: sentinel } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } });
    const configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref: account },
        authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision,
        configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain',
            payload: { values: { teamId: 'team-r6' }, secretRefs: {} }, randomBytes: length => new Uint8Array(length) }) });
    let credentialReads = 0;
    app.get('/v4/connect/qualified/accounts', async () => ({ service: account.service, accounts: [profile] }));
    app.get('/v4/connect/qualified/configuration', async () => configuration);
    app.get('/v4/connect/qualified/credential', async request => {
        const selected = JSON.parse(new URL(request.url, origin).searchParams.get('ref') ?? 'null');
        expect(selected).toEqual(account);
        credentialReads++;
        // The receiving daemon's incumbent is separate from the admitted
        // requester's Account. Its first Settings hydration may settle while
        // that portable Account Resource is materializing its credential.
        if (hydrateReceiver && credentialReads === 1) setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'receiver-incumbent' });
        return credential;
    });
    const providerReads: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const parsed = new URL(String(url));
        if (parsed.origin === origin) return Response.json(qualifiedFeatures);
        providerReads.push(`${parsed.pathname}${parsed.search}`);
        expect(parsed.origin).toBe('https://api.vercel.com');
        expect(new Headers(init?.headers).get('authorization') === `Bearer ${sentinel}`).toBe(true);
        if (parsed.pathname === '/v2/user') return Response.json({ user: { id: 'user-r6', username: 'R6 user' } });
        if (parsed.pathname === '/v2/teams') return Response.json({ teams: [], pagination: { next: null } });
        throw new Error('Unexpected provider endpoint');
    });
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const mounted = await createAuthoredAdmittedPluginRuntimeFixture({
        runtimeOptions: { scopedActionRuntime: { credentials, savedSecretOperationContext: operationContext,
            actionsSettingsProvider: createActionSettingsProvider({ accountSettings: snapshot.settings, allowEnvironmentOverride: false }) },
            externalActionHomeBinding: { serverId, serverIdentityId: serverId }, resolveCurrentMachineId: () => machineId },
        plugins: [{ manifest: vercel.manifest, files: { [vercel.manifest.entrypoints.daemon]: 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: vercel.activate }) }],
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
    });
    try {
        const list = (selection?: Parameters<typeof listRuntimeContributedActionDefinitions>[1]) => listRuntimeContributedActionDefinitions(mounted.registry, selection);
        // Same current-process owner and committed daemon dependencies as the
        // receiving external Action factory; no Account registry is injected.
        const daemon = createCliActionExecutorFromCredentials({ credentials, happyHomeDir: mounted.happyHomeDir,
            serverId, serverIdentityId: serverId, serverApiUrl: origin,
            savedSecretOperationContext: operationContext,
            pluginActionExecutionOwner: 'current_process', machineId,
            listContributedActionDefinitions: list, inputTypeDeps: createRegistryInputTypeDeps(mounted.registry) });
        const input = { actionId: 'happier.deploy.vercel/actions/targets-inspect-v1', fieldPath: 'providerAccountId',
            draftInput: { v: 1, serverId, environmentId: 'cmw0iact500c1mcns7bm1uoo5', expectedRevision: 1,
                credentialRef: account, credentialPrincipal: { kind: 'account', accountId,
                    purpose: { consumer: { pluginId: vercel.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                    target: { kind: 'account', account } }, machineId } };
        // The receiving adapter restores the UI surface and stamps its admitted
        // Home identity; neither fact is supplied by the public options input.
        const context = { surface: 'ui' as const, serverId, serverIdentityId: serverId,
            externalActionTarget: { kind: 'machine' as const, machineId }, runtimeAccountId: accountId };
        const result = await daemon.execute('action.options.resolve', input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: [{ value: 'team-r6', label: 'Selected Vercel' }] } });
        expect(providerReads).toEqual([]);
        expect(credentialReads).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain(sentinel);
        // This fixture retains one daemon registry. A native Account change
        // retires that registry; a later real ingress acquires its replacement.
        // Keep filtering the configured scope on the unchanged receiver.
        if (!hydrateReceiver) {
            const prepared = await daemon.prepare('action.options.resolve', { ...input, query: 'other-scope' }, context);
            expect(prepared.kind).toBe('ready');
            expect(providerReads).toEqual([]);
            if (prepared.kind !== 'ready') throw new Error('Options preparation did not retain placement');
            const page = await prepared.invocation.run();
            expect(page, JSON.stringify(page)).toMatchObject({ ok: true, result: { options: [] } });
            expect(providerReads).toEqual([]);
        }
    } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
});
