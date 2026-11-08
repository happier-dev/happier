import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/registries';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { StoreAppListingState, StoreAppCreateChoices } from './useStoreAppListing';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ACTION_OPERATION_RPC_METHODS_V2, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readDeploymentTemplateCreationOperationRequestIdV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storage');
const { useStoreAppListing } = await import('./useStoreAppListing');
const { useRegistrySourceMutations } = await import('@/registries/useRegistrySourceMutations');
beforeEach(() => homes.reset());
afterEach(standardCleanup);

let fixtureSequence = 0;
async function createFixture(requiredDomain = false, withOtherSource = false, domainFailure = false) {
    const serverUrl = `https://store-app-listing-${++fixtureSequence}.test`;
    const catalogUrl = `${serverUrl}/apps.json`;
    const sourceId = deriveMarketplaceSourceId(catalogUrl);
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: {
        v: 2, sources: [{ id: sourceId, title: 'Apps', url: catalogUrl, format: 'happier-catalog',
            kinds: ['app'], enabled: true, addedAt: 1 }, ...(withOtherSource ? [{ id: 'other-source', title: 'Other apps',
                url: `${serverUrl}/other-apps.json`, format: 'happier-catalog' as const,
                kinds: ['app' as const], enabled: true, addedAt: 1 }] : [])], disabledSourceIds: [],
    } }] });
    const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'Uptime Kuma',
        compose: { document: 'services:\n  kuma:\n    image: louislam/uptime-kuma:2\n', profiles: [], services: ['kuma'] },
        variables: [], generatedSecrets: [], domains: requiredDomain ? [{ key: 'web', service: 'kuma', containerPort: 3001,
            protocol: 'https', required: true, healthCheck: { path: '/api/entry-page', expectStatus: 200 } }] : [], volumes: [], firstRunSetup: true });
    const catalogReads: string[] = [];
    const preparations: ReturnType<typeof DeploymentPublishPrepareInputV1Schema.parse>[] = [];
    const creations: ReturnType<typeof DeploymentTemplateInstantiateInputV1Schema.parse>[] = [];
    const mode = { value: 'prepared' as 'prepared' | 'refused' | 'approval' };
    const createMode = { value: 'created' as 'created' | 'refused' | 'approval' | 'deployFailed' | 'replyLost' };
    const retries: ReturnType<typeof DeploymentTemplateInstantiateInputV1Schema.parse>[] = [];
    const retryMode = { value: 'failed' as 'failed' | 'applied' };
    const partial = { kind: 'partial', phase: domainFailure ? 'domains' : 'deploy', errorCode: domainFailure ? 'action_forbidden' : 'deployment_failed',
        ...(domainFailure ? { deployment: { ok: true, environmentId: 'environment/created', revision: 5, deploymentId: 'deployed', deploymentRevision: 11, state: 'succeeded' } } : {}),
        environmentId: 'environment/created', revision: 5, targetLinkId: 'target-link', savedSecrets: [],
        definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` } } satisfies ReturnType<typeof DeploymentTemplateInstantiationPartialV1Schema.parse>;
    const machine = { id: 'target' };
    const controller = { id: 'controller' };
    const serverId = await homes.addHome({ name: 'App Home', serverUrl, accountId: 'owner', currentAccount: true,
        serverIdentityId: `srv_${'c'.repeat(32)}` });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
        homes.answer(serverId, path, { select: async () => ({ body: await (await catalog.handle(path))!.json() }) });
    }
    const sourcesPath = '/v1/account/entity-rows/prompt-library/registry-sources';
    homes.answer(serverId, `POST ${sourcesPath}`, { select: async body => ({
        body: await (await catalog.handle(sourcesPath, { method: 'POST', body: JSON.stringify(body) }))!.json(),
    }) });
    homes.answer(serverId, '/apps.json', { select: () => {
                catalogReads.push('/apps.json');
                return { body: { schemaVersion: 1, apps: [
                    { itemId: 'uptime-kuma', app },
                    { itemId: 'needs-review', app, unsupported: true },
                    ...Array.from({ length: 100 }, (_, index) => ({ itemId: `other-${index}`, app })),
                ] } };
    } });
    const actionFailure = (result: unknown) => {
        const failure = ActionExecuteFailureSchema.safeParse(result);
        return failure.success ? failure.data : null;
    };
    await answerExternalActionAccountForHome(homes, serverId, {
        machineId: machine.id, installationId: 'installed', additionalMachines: [{ machineId: controller.id }],
        actionId: 'deployments.publish.prepare', tokenEpoch: 0, requesterInvocation: 'required', failure: actionFailure,
        execute: operand => {
                const input = DeploymentPublishPrepareInputV1Schema.parse(operand);
                preparations.push(input);
                const result = DeploymentPublishPrepareResultV1Schema.parse({ kind: 'prepared', templateRef: input.templateRef,
                    project: { projectSourceId: input.projectSourceId, sourceRevision: input.sourceRevision,
                        newProject: input.newProject,
                        owner: { kind: 'account', accountId: 'owner' } },
                    machine: { machineId: input.machineId, installationId: input.installationId }, template: app,
                    creationDefaults: { values: { controllerMachineId: 'controller', buildMachineId: 'builder', retainPreviousDeployments: 1 },
                        sources: { controllerMachineId: 'account', buildMachineId: 'account', retainPreviousDeployments: 'builtin' } },
                    ...(input.projectSourceId ? { creationDefaultsBasis: { projectSourceId: input.projectSourceId,
                        sourceRevision: input.sourceRevision, projectDefaultsRevision: 0, content: null } } : {}) });
                return mode.value === 'refused' ? { ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable' }
                    : mode.value === 'approval'
                        ? { kind: 'approval_request_created', artifactId: 'prepare-approval', actionId: 'deployments.publish.prepare' } : result;
        },
    });
    homes.answer(serverId, `/v1/deployments/environments/${encodeURIComponent(partial.environmentId)}`, { body: { ok: true,
        environment: createDeploymentEnvironmentHeaderV1({ id: partial.environmentId, serverId, owner: { kind: 'account', accountId: 'owner' },
            projectSourceId: 'source-retained', revision: partial.revision, controllerMachineId: controller.id }),
        targetLinks: [createDeploymentTargetLinkHeaderV1({ id: partial.targetLinkId,
            environmentId: partial.environmentId, revision: 2, machines: ['target'],
            members: [{ machineId: 'target', installationId: 'installed', state: 'active' }] })] } });
    const instantiateBoundary = await answerExternalActionAccountForHome(homes, serverId, {
        machineId: controller.id, additionalMachines: [{ machineId: machine.id, installationId: 'installed' }],
        actionId: 'deployments.templates.instantiate', tokenEpoch: 0, requesterInvocation: 'required', failure: actionFailure,
        execute: (operand, context) => {
        const input = DeploymentTemplateInstantiateInputV1Schema.parse(operand);
        expect(context.target).toEqual({ kind: 'machine', machineId: controller.id });
        expect(input.machineId).toBe(machine.id);
        const creating = input.environment.kind === 'create';
        if (input.mode === 'apply') (creating ? creations : retries).push(input);
        const creationDefaults = { values: { controllerMachineId: 'controller', buildMachineId: 'builder', retainPreviousDeployments: 1 },
            sources: { controllerMachineId: 'account', buildMachineId: 'account', retainPreviousDeployments: 'builtin' } };
        const creationDefaultsBasis = { projectSourceId: input.projectSourceId, sourceRevision: 1, projectDefaultsRevision: 0, content: null };
        return input.mode === 'preview'
                ? { kind: 'preview', review: { templateRef: input.templateRef,
                    profiles: app.compose.profiles, services: app.compose.services, bindings: [], generatedSecrets: [],
                    domains: [], ...(input.deploy ? { deploy: input.deploy } : creating && requiredDomain
                        ? { deploy: { requestKey: input.environment.kind === 'create' ? input.environment.requestKey : 'unreachable' } } : {}),
                    ...(creating ? { creationDefaults, ...(input.projectSourceId ? { creationDefaultsBasis } : {}) } : {}) } }
                : creating && createMode.value === 'refused'
                    ? { ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable', details: { machineId: 'target' } }
                    : creating && createMode.value === 'approval'
                        ? { kind: 'approval_request_created', artifactId: 'create-approval', actionId: 'deployments.templates.instantiate' }
                        : creating && (createMode.value === 'deployFailed' || createMode.value === 'replyLost') || !creating && retryMode.value === 'failed'
                            ? partial
                            : { kind: 'applied', environmentId: partial.environmentId, revision: 8,
                                targetLinkId: partial.targetLinkId, definition: partial.definition, savedSecrets: [] };
        },
    });
    homes.answer(serverId, 'POST /v1/actions/deployments.templates.instantiate', { select: async (body, request) => {
        const response = await instantiateBoundary.handle(new URL(request.url), request.init);
        if (!response) throw new Error('Expected template Action boundary');
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(ExternalActionExecutionAuthorizationRequestV1Schema.parse(body).envelope);
        const input = DeploymentTemplateInstantiateInputV1Schema.parse(envelope.input);
        if (input.mode === 'apply' && input.environment.kind === 'create' && createMode.value === 'replyLost') return { dispatchThenFail: true };
        return { status: response.status, body: await response.json() };
    } });
    const account = await captureLazyActionAccountContext(serverId);
    storage.setState({ settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
    return { home: { id: serverId }, requests: homes.requests, boundary: homes.artifacts(serverId),
        sourceId, account, app, catalogReads, preparations, creations, mode, createMode, retries, retryMode, partial, dispose: () => account.dispose() };
}

it.each(['unavailable', 'wrong-environment'] as const)('retains an acknowledged new-Project install when its Source lookup is %s and retries only the read', async lookupFailure => {
    const fixture = await createFixture();
    const path = `/v1/deployments/environments/${encodeURIComponent(fixture.partial.environmentId)}`;
    const detail = (id: string) => ({ ok: true, environment: createDeploymentEnvironmentHeaderV1({
        id, serverId: fixture.home.id, owner: { kind: 'account', accountId: 'owner' },
        projectSourceId: 'source-retained', revision: 8, controllerMachineId: 'controller',
    }), targetLinks: [] });
    homes.answer(fixture.home.id, path, lookupFailure === 'unavailable'
        ? { status: 503, body: { error: 'service_unavailable' } }
        : { body: detail('another-environment') });
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe('ready'));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error('Expected ready App');
        const prepared = await ready.prepare({ machineId: 'target', installationId: 'installed',
            newProject: { requestKey: 'store-new-project', name: 'New project', owner: { kind: 'account', accountId: 'owner' } } });
        if (!('kind' in prepared) || prepared.kind !== 'prepared') throw new Error('Expected prepared new Project');
        const choices = { name: 'Kuma', protection: 'nonProduction', deployerMode: 'managers' } as const;
        const outcome = await ready.create(prepared, choices);
        expect(outcome).toMatchObject({ ok: false, created: {
            kind: 'applied', environmentId: fixture.partial.environmentId, revision: 8,
            targetLinkId: fixture.partial.targetLinkId, definition: fixture.partial.definition, savedSecrets: [],
        } });
        expect(outcome).not.toHaveProperty('progress');
        expect(outcome).not.toHaveProperty('environmentId');
        expect(fixture.creations).toHaveLength(1);
        homes.answer(fixture.home.id, path, { body: detail(fixture.partial.environmentId) });
        expect(await ready.create(prepared, choices)).toEqual({
            projectSourceId: 'source-retained', environmentId: fixture.partial.environmentId,
        });
        expect(fixture.creations).toHaveLength(1);
        expect(fixture.retries).toHaveLength(0);
    } finally { await hook.unmount(); await fixture.dispose(); }
});

it.each(['failed', 'succeeded'] as const)('recovers the created Environment from its %s retained install receipt after losing the HTTP reply without replaying create', async state => {
    const fixture = await createFixture(true);
    fixture.createMode.value = 'replyLost';
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://store-app-listing-' + fixtureSequence + '.test', { serverId: fixture.home.id });
    if (!credentials) throw new Error('Expected Store Home credentials');
    const partial = { ...fixture.partial, errorCode: 'action_forbidden' };
    const receiptReads: string[] = [];
    const socket = installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
                || !('method' in payload) || !('params' in payload)) throw new Error('Unexpected install receipt request');
            const created = fixture.creations[0];
            if (!created) throw new Error('Expected issued install');
            const requestId = readDeploymentTemplateCreationOperationRequestIdV1(created);
            const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'retained-install', revision: 2,
                actionId: 'deployments.templates.instantiate', requestId, state,
                scope: { accountId: 'owner', machineId: 'controller' }, title: 'Install app',
                createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'unsupported',
                ...(state === 'failed'
                    ? { error: { errorCode: partial.errorCode, error: partial.errorCode, effectAttempted: true, details: partial } }
                    : { result: { kind: 'applied', environmentId: partial.environmentId, revision: partial.revision,
                        targetLinkId: partial.targetLinkId, definition: partial.definition, savedSecrets: [] } }) };
            receiptReads.push(String(payload.method));
            if (payload.method === `controller:${ACTION_OPERATION_RPC_METHODS_V2.list}`) {
                expect(payload.params).toMatchObject({ requestIdentity: { actionId: operation.actionId, requestId } });
                return { ok: true, result: { items: [operation], nextCursor: null } };
            }
            expect(payload.method).toBe(`controller:${ACTION_OPERATION_RPC_METHODS_V2.get}`);
            expect(payload.params).toMatchObject({ operationId: operation.operationId, waitForTerminal: true });
            return { ok: true, result: { kind: 'found', operation } };
        });
    }, { serverUrl: 'https://store-app-listing-' + fixtureSequence + '.test', token: credentials.token });
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe('ready'));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error('Expected ready App');
        const prepared = await ready.prepare({ machineId: 'target', installationId: 'installed',
            newProject: { requestKey: 'store-new-project', name: 'New project', owner: { kind: 'account', accountId: 'owner' } } });
        expect(prepared).toMatchObject({ kind: 'prepared' });
        if (!('kind' in prepared) || prepared.kind !== 'prepared') throw new Error('Expected prepared new Project');
        const outcome = await ready.create(prepared, { name: 'Kuma', protection: 'nonProduction', deployerMode: 'managers' });
        expect(outcome).toMatchObject(state === 'failed'
            ? { ok: false, errorCode: 'action_forbidden', progress: partial }
            : { projectSourceId: 'source-retained', environmentId: partial.environmentId });
        expect(fixture.creations).toHaveLength(1);
        expect(receiptReads).toEqual([`controller:${ACTION_OPERATION_RPC_METHODS_V2.list}`, `controller:${ACTION_OPERATION_RPC_METHODS_V2.get}`]);
    } finally { await hook.unmount(); socket.dispose(); await fixture.dispose(); }
});

it('keeps the open App across unrelated source edits with zero reloads or blank renders, but retires selected-source edits and removal', async () => {
    const fixture = await createFixture(false, true);
    const states: StoreAppListingState['kind'][] = [];
    const hook = await renderHook(() => {
        const listing = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
            lifetime: fixture.account.accountLifetime, demand: { presented: true } });
        states.push(listing.kind);
        return { listing, mutations: useRegistrySourceMutations() };
    });
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().listing.kind).toBe('ready'));
        const initial = hook.getCurrent().listing;
        if (initial.kind !== 'ready') throw new Error('Expected selected App');
        const reads = fixture.catalogReads.length;
        states.length = 0;
        await act(async () => { await hook.getCurrent().mutations.update({ sourceId: 'other-source', title: 'Renamed other apps' }); });
        await act(async () => { await hook.getCurrent().mutations.setToken({ sourceId: 'other-source', npmRegistryProfileId: 'other-profile' }); });
        expect(fixture.catalogReads.length - reads).toBe(0);
        expect(states.filter(kind => kind !== 'ready')).toEqual([]);
        expect(hook.getCurrent().listing).toMatchObject({ kind: 'ready', item: initial.item });
        // Reopening also exercises host memo retention, independently of the mounted hook.
        await hook.unmount();
        const reopened = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
            lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().kind).toBe('ready'));
        expect(fixture.catalogReads.length - reads).toBe(0);
        await reopened.unmount();
        const selectedStates: StoreAppListingState['kind'][] = [];
        const selected = await renderHook(() => {
            const listing = useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
                lifetime: fixture.account.accountLifetime, demand: { presented: true } });
            selectedStates.push(listing.kind);
            return { listing, mutations: useRegistrySourceMutations() };
        });
        await waitForHomeGovernance(() => expect(selected.getCurrent().listing.kind).toBe('ready'));
        selectedStates.length = 0;
        await act(async () => { await selected.getCurrent().mutations.update({ sourceId: fixture.sourceId, title: 'Renamed selected apps' }); });
        expect(selectedStates).toContain('loading');
        await waitForHomeGovernance(() => expect(selected.getCurrent().listing.kind).toBe('ready'));
        expect(fixture.catalogReads.length - reads).toBe(1);
        selectedStates.length = 0;
        await act(async () => { await selected.getCurrent().mutations.setToken({ sourceId: fixture.sourceId, npmRegistryProfileId: 'selected-profile' }); });
        expect(selectedStates).toContain('loading');
        await waitForHomeGovernance(() => expect(selected.getCurrent().listing.loading).toBe(false));
        await act(async () => { await selected.getCurrent().mutations.delete(fixture.sourceId); });
        expect(selected.getCurrent().listing.kind).not.toBe('ready');
        await selected.unmount();
    } finally { await fixture.dispose(); }
});

it('reads only the selected native App, prepares its exact pin explicitly and retains native refusal/approval and Environment identity', async () => {
    const fixture = await createFixture();
    const selection = { sourceId: fixture.sourceId, itemId: 'uptime-kuma' };
    const hook = await renderHook((presented: boolean) => useStoreAppListing({ selection,
        lifetime: fixture.account.accountLifetime, demand: { presented } }), { initialProps: false });
    try {
        expect(fixture.catalogReads).toEqual([]);
        expect(fixture.preparations).toEqual([]);
        await hook.rerender(true);
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error(JSON.stringify({ kind: ready.kind, error: ready.error, status: ready.status,
            requests: fixture.requests.map(request => `${request.method} ${request.path}`) }));
        expect(ready.item.summary).toMatchObject(selection);
        expect(ready.app).toEqual(fixture.app);
        expect(ready.templateRef).toMatchObject({ ...selection, version: ready.item.summary.version, ref: ready.item.payload.kind === 'app' ? ready.item.payload.ref : null });
        expect(fixture.catalogReads).toHaveLength(1);
        expect(fixture.preparations).toHaveLength(0);
        const input = { machineId: 'target', installationId: 'installed', projectSourceId: 'repo-free', sourceRevision: 1 };
        expect(await ready.prepare(input)).toMatchObject({ kind: 'prepared', templateRef: ready.templateRef,
            creationDefaults: { values: { controllerMachineId: 'controller', buildMachineId: 'builder' } } });
        expect(fixture.preparations).toEqual([{ ...input, serverId: fixture.account.serverIdentityId, templateRef: ready.templateRef }]);
        fixture.mode.value = 'refused';
        expect(await ready.prepare(input)).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
        fixture.mode.value = 'approval';
        expect(await ready.prepare(input)).toEqual({ kind: 'approval_request_created', artifactId: 'prepare-approval', actionId: 'deployments.publish.prepare' });
        const href = new URL(ready.environmentHref({ projectSourceId: 'source/with space', environmentId: 'environment/one' }), 'https://ui.test');
        expect(decodeURIComponent(href.pathname)).toBe('/deployments/source/with space');
        expect(href.searchParams.get('serverId')).toBe(fixture.account.accountLifetime.scope.serverId);
        expect(href.searchParams.get('deploymentEnvironment')).toBe('environment/one');
        expect(fixture.requests.filter(request => request.method !== 'GET' && request.path !== '/v1/machines/read-batch'
            && !request.path.startsWith('/v1/actions/deployments.publish.prepare'))).toEqual([]);
        expect(fixture.boundary.list()).toEqual([]);
        await hook.rerender(false);
        expect(fixture.catalogReads).toHaveLength(1);
        await act(async () => { await homes.switchAccount(fixture.home.id, 'other', { currentAccount: true }); });
        expect(await ready.prepare(input)).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(fixture.preparations).toHaveLength(3);
    } finally { await hook.unmount(); await fixture.dispose(); }
});

it.each(['created', 'refused', 'approval'] as const)('creates only on explicit intent through the scoped catalog owner and retains %s', async outcome => {
    const fixture = await createFixture();
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe('ready'));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error('Expected ready App');
        expect(fixture.creations).toEqual([]);
        const prepared = await ready.prepare({ machineId: 'target', installationId: 'installed', projectSourceId: 'source/with space', sourceRevision: 1 });
        if (!('kind' in prepared) || prepared.kind !== 'prepared') throw new Error('Expected prepared App');
        expect(fixture.creations).toEqual([]);
        fixture.createMode.value = outcome;
        const choices = { name: 'My Kuma', protection: 'production', deployerMode: 'members' } satisfies StoreAppCreateChoices;
        const result = await ready.create(prepared, choices);
        if (outcome === 'created') {
            expect(result).toEqual({ projectSourceId: 'source/with space', environmentId: 'environment/created' });
            if (!('environmentId' in result)) throw new Error('Expected created identity');
            const href = new URL(ready.environmentHref(result), 'https://ui.test');
            expect(decodeURIComponent(href.pathname)).toBe('/deployments/source/with space');
            expect(href.searchParams.get('deploymentEnvironment')).toBe('environment/created');
            expect(href.searchParams.get('serverId')).toBe(fixture.account.accountLifetime.scope.serverId);
        } else if (outcome === 'refused') {
            expect(result).toEqual({ ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable',
                details: { machineId: 'target' }, requestId: expect.any(String) });
        } else {
            expect(result).toEqual({ kind: 'approval_request_created', artifactId: 'create-approval', actionId: 'deployments.templates.instantiate' });
        }
        expect(fixture.creations).toHaveLength(1);
        expect(fixture.creations[0]).toMatchObject({ serverId: fixture.account.serverIdentityId,
            projectSourceId: 'source/with space', templateRef: prepared.templateRef, machineId: prepared.machine.machineId,
            target: { kind: 'new', installationId: prepared.machine.installationId }, destination: { kind: 'stored' }, bindings: [],
            environment: { kind: 'create', ...prepared.creationDefaults.values, ...choices,
                purpose: 'standard', requestKey: expect.any(String) } });
        expect(fixture.preparations).toHaveLength(1);
        expect(fixture.boundary.list()).toEqual([]);
    } finally { await hook.unmount(); await fixture.dispose(); }
});

it('retains the same create attempt across retry and refresh, and retires its captured Account', async () => {
    const fixture = await createFixture();
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe('ready'));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error('Expected ready App');
        const prepared = await ready.prepare({ machineId: 'target', installationId: 'installed', projectSourceId: 'source', sourceRevision: 1 });
        if (!('kind' in prepared) || prepared.kind !== 'prepared') throw new Error('Expected prepared App');
        const choices = { name: 'My Kuma', protection: 'nonProduction', deployerMode: 'managers',
            domainBindings: [{ templateDomainId: 'web', hostname: 'status.example.com' }] } satisfies StoreAppCreateChoices;
        fixture.createMode.value = 'refused';
        await ready.create(prepared, choices);
        const first = fixture.creations[0];
        expect(first?.environment.kind === 'create' ? first.environment.requestKey : undefined).toEqual(expect.any(String));
        await hook.rerender();
        await act(async () => { await ready.refresh(); });
        const current = hook.getCurrent();
        if (current.kind !== 'ready') throw new Error('Expected ready App');
        fixture.createMode.value = 'created';
        expect(await current.create(prepared, { ...choices, domainBindings: choices.domainBindings.map(binding => ({ ...binding })) })).toEqual({ projectSourceId: 'source', environmentId: 'environment/created' });
        expect(fixture.creations[1]).toEqual(first);
        expect(first?.domainBindings).toEqual(choices.domainBindings);
        await current.create(prepared, { ...choices, domainBindings: [{ templateDomainId: 'web', hostname: 'other.example.com' }] });
        expect(fixture.creations[2]?.environment.kind === 'create' ? fixture.creations[2].environment.requestKey : undefined).not.toBe(first?.environment.kind === 'create' ? first.environment.requestKey : undefined);
        expect(fixture.creations[2]?.domainBindings).toEqual([{ templateDomainId: 'web', hostname: 'other.example.com' }]);
        await current.create(prepared, { ...choices, name: 'Another Kuma' });
        expect(fixture.creations[3]?.environment.kind === 'create' ? fixture.creations[3].environment.requestKey : undefined).not.toBe(first?.environment.kind === 'create' ? first.environment.requestKey : undefined);
        await act(async () => { await homes.switchAccount(fixture.home.id, 'other', { currentAccount: true }); });
        expect(await current.create(prepared, choices)).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(fixture.creations).toHaveLength(4);
    } finally { await hook.unmount(); await fixture.dispose(); }
});

it.each(['needs-review', 'missing'] as const)('settles %s through native Registry diagnostics without offering preparation', async itemId => {
    const fixture = await createFixture();
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe(itemId === 'needs-review' ? 'needs_review' : 'unavailable'));
        const state: StoreAppListingState = hook.getCurrent();
        expect(state.kind).toBe(itemId === 'needs-review' ? 'needs_review' : 'unavailable');
        if (state.kind === 'needs_review') expect(state.diagnostics.length).toBeGreaterThan(0);
        expect(fixture.catalogReads).toHaveLength(1);
        expect('prepare' in state).toBe(false);
        expect(fixture.preparations).toEqual([]);
    } finally { await hook.unmount(); await fixture.dispose(); }
});

it('uses one template Action and review shape for first install and retained retry without recreating its Environment', async () => {
    const fixture = await createFixture(true);
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe('ready'));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error('Expected ready App');
        const prepared = await ready.prepare({ machineId: 'target', installationId: 'installed', projectSourceId: 'source-retained', sourceRevision: 1 });
        if (!('kind' in prepared) || prepared.kind !== 'prepared') throw new Error('Expected prepared App');
        const choices = { name: 'My Kuma', protection: 'nonProduction', deployerMode: 'managers',
            domainBindings: [{ templateDomainId: 'web', hostname: 'status.example.com' }] } satisfies StoreAppCreateChoices;
        fixture.createMode.value = 'deployFailed';
        expect(await ready.create(prepared, choices)).toMatchObject({ ok: false, errorCode: 'deployment_failed', details: fixture.partial });
        await hook.rerender();
        const current = hook.getCurrent();
        if (current.kind !== 'ready') throw new Error('Expected ready App');
        const environmentPath = `/v1/deployments/environments/${encodeURIComponent(fixture.partial.environmentId)}`;
        homes.answer(fixture.home.id, environmentPath, { status: 503, body: { error: 'service_unavailable' } });
        expect(await current.create(prepared, choices)).toMatchObject({ ok: false, progress: fixture.partial, recovery: 'deploy' });
        expect(fixture.retries).toHaveLength(0);
        homes.answer(fixture.home.id, environmentPath, { body: { ok: true,
            environment: createDeploymentEnvironmentHeaderV1({ id: fixture.partial.environmentId, serverId: fixture.home.id,
                projectSourceId: 'source-retained', revision: 5, controllerMachineId: 'controller' }),
            targetLinks: [createDeploymentTargetLinkHeaderV1({ id: 'target-link', environmentId: fixture.partial.environmentId,
                revision: 2, machines: ['target'], members: [{ machineId: 'target', installationId: 'installed', state: 'active' }] })] } });
        expect(await current.create(prepared, choices)).toMatchObject({ ok: false, errorCode: 'deployment_failed' });
        expect(fixture.creations[0]).toMatchObject({ environment: { kind: 'create' },
            deploy: { requestKey: fixture.creations[0]?.environment.kind === 'create' ? fixture.creations[0].environment.requestKey : undefined } });
        expect(fixture.retries[0]).toMatchObject({ environment: { kind: 'existing', environmentId: fixture.partial.environmentId, expectedRevision: 5 },
            target: { kind: 'existing', targetLinkId: 'target-link', expectedRevision: 2, installationId: 'installed' },
            destination: fixture.partial.definition, templateRef: prepared.templateRef, domainBindings: choices.domainBindings,
            deploy: { requestKey: expect.any(String) } });
        fixture.retryMode.value = 'applied';
        expect(await current.create(prepared, choices)).toEqual({ projectSourceId: 'source-retained', environmentId: fixture.partial.environmentId });
        expect(fixture.retries.map(retry => retry.domainBindings)).toEqual([choices.domainBindings, choices.domainBindings]);
        expect(fixture.retries[1]?.deploy?.requestKey).not.toBe(fixture.retries[0]?.deploy?.requestKey);
        expect(fixture.creations).toHaveLength(1);
        expect(fixture.requests.filter(request => request.path === '/v1/actions/deployments.environments.create')).toEqual([]);
    } finally { await hook.unmount(); await fixture.dispose(); }
});


it('retains the successful deploy when Domain add is forbidden and recovers only at Domains without another install or deploy', async () => {
    const fixture = await createFixture(true, false, true);
    const hook = await renderHook(() => useStoreAppListing({ selection: { sourceId: fixture.sourceId, itemId: 'uptime-kuma' },
        lifetime: fixture.account.accountLifetime, demand: { presented: true } }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().kind).toBe('ready'));
        const ready = hook.getCurrent();
        if (ready.kind !== 'ready') throw new Error('Expected ready App');
        const prepared = await ready.prepare({ machineId: 'target', installationId: 'installed',
            projectSourceId: 'source-retained', sourceRevision: 1 });
        if (!('kind' in prepared) || prepared.kind !== 'prepared') throw new Error('Expected prepared App');
        const choices = { name: 'Linkding', protection: 'nonProduction', deployerMode: 'managers',
            domainBindings: [{ templateDomainId: 'web', hostname: 'bookmarks.example.com' }] } satisfies StoreAppCreateChoices;
        fixture.createMode.value = 'deployFailed';
        const failed = await ready.create(prepared, choices);
        expect(failed).toMatchObject({ ok: false, errorCode: 'action_forbidden', progress: {
            phase: 'domains', environmentId: fixture.partial.environmentId, deployment: { state: 'succeeded', deploymentId: 'deployed' },
        }, recovery: 'domains' });
        await hook.rerender();
        const current = hook.getCurrent();
        if (current.kind !== 'ready') throw new Error('Expected ready App');
        const recovered = await current.create(prepared, choices);
        expect(recovered).toEqual({ projectSourceId: 'source-retained', environmentId: fixture.partial.environmentId, tab: 'domains' });
        if (!('environmentId' in recovered)) throw new Error('Expected existing Environment');
        expect(new URL(current.environmentHref(recovered), 'https://ui.test').searchParams.get('deploymentTab')).toBe('domains');
        expect(fixture.creations).toHaveLength(1);
        expect(fixture.retries).toHaveLength(0);
    } finally { await hook.unmount(); await fixture.dispose(); }
});
