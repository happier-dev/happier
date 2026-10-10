import { store as routerStore } from 'expo-router/build/global-state/router-store';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { invokeWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { upsertAndActivateServer, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createWorkflowActionHttpTransport } from '../fixtures/workflowActionHttpTransport';
import { configureSingleLibraryDefinition, getLibraryFixtureAccountId, readLibraryFixtureResponse } from '../fixtures/workflowLibraryHttpFixture';
import { mountStartupRoot } from './workflowRouteStartupRootBoundary';
import { AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { createPlainProjectAccountRowListFixture } from '../fixtures/projectAccountRows';
import { navigationHydrationBrowser } from './navigationHydrationBrowser';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '../fixtures/workflowRunFixtures';
import { materializeWorkflowAcceptedSnapshotV1, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1, WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol';
import { WorkflowInvocationListRequestV1Schema, WorkflowRunGetRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { profileDefaults } from '@/sync/domains/profiles/profile';

const credentials = { token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature' };
let releaseHome: () => void = () => {};
let homeRequests = 0;
const bootstrapStates: Array<{ isDataReady: boolean; profileScope: unknown }> = [];
const unservedHttpPaths: string[] = [];
const httpFetch = globalThis.fetch.bind(globalThis);

async function mount(seed = true, holdHome = false) {
    configureSingleLibraryDefinition();
    const transport = createWorkflowActionHttpTransport({ fixtureResponse: readLibraryFixtureResponse, accountId: getLibraryFixtureAccountId });
    const homeResponse = holdHome ? new Promise<void>(resolve => { releaseHome = resolve; }) : Promise.resolve();
    homeRequests = 0;
    const run = createWorkflowRunSummaryFixture({ id: '10000000-0000-4000-8000-000000000004',
        ownerAccountId: getLibraryFixtureAccountId(), machineId: 'machine-1', origin: { kind: 'direct' }, state: 'succeeded' });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'review',
            document: { text: 'Review this workflow', references: [], attachments: [] }, result: { kind: 'text' } }] }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    if (!accepted.ok) throw new Error(`Invalid startup Run fixture: ${accepted.error.code}`);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: getLibraryFixtureAccountId(), runId: run.id },
        acceptedSnapshot: accepted.snapshot }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: getLibraryFixtureAccountId(),
        access: 'owner', encryptionMode: 'plain', visibleTeamId: null, dataEncryptionKey: null, callerDataEncryptionKey: null,
        recipients: [], ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    setRuntimeFetch(async (url, init) => {
        // Home bootstrap HTTP responses only; the canonical decoder and scope
        // readiness lifecycle remain unmodified beneath this boundary.
        const path = new URL(String(url)).pathname;
        if (path === '/v1/kv' || path.startsWith('/v1/kv/')) return httpFetch(url, init);
        const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
        if (path === '/v1/account/encryption') {
            homeRequests += 1;
            await homeResponse;
        }
        if (path === '/v3/automations/runs/workflow-storage') {
            // External server storage facts only; the real Account reader opens
            // the accepted envelope and the Run screen uses its normal Actions.
            const operation: unknown = JSON.parse(String(init?.body));
            if (!operation || typeof operation !== 'object' || !('operation' in operation)) {
                throw new Error('Invalid startup storage request');
            }
            // The storage HTTP owner sends the operation and request fields in
            // one object, not the Action executor's { operation, request } shape.
            const { operation: kind, ...requestFields } = operation;
            let value: unknown;
            if (kind === 'get' || kind === 'run-key.census') {
                const request = WorkflowRunGetRequestV1Schema.parse(requestFields);
                if (request.runId !== run.id) return new Response(null, { status: 404 });
                value = kind === 'get' ? { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus } : keyCensus;
            } else if (kind === 'invocations.list') {
                const request = WorkflowInvocationListRequestV1Schema.parse(requestFields);
                if (request.runId !== run.id) return new Response(null, { status: 404 });
                value = { invocations: [], parentRevision: run.revision };
            }
            if (value !== undefined) return json(value);
        }
        if (path === '/v1/account/profile') return json({ ...profileDefaults, id: getLibraryFixtureAccountId() });
        if (path === '/v2/changes') return json({ changes: [], nextCursor: 0 });
        if (path === '/v2/sessions' || path === '/v2/sessions/active') return json({ sessions: [], nextCursor: null, hasNext: false });
        if (path === '/v1/machines') return json([]);
        if (path === '/v1/push-tokens') return json({ success: true });
        const value = path === '/v1/account/authoring-memory'
            ? AuthoringMemoryListResponseV1Schema.parse({ rows: [] })
            : path === '/v1/account/project-rows/list' ? createPlainProjectAccountRowListFixture() : undefined;
        if (value !== undefined) return json(value);
        try { return await transport.fetch(url, init); }
        catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Unexpected HTTP fixture route ')) throw error;
            // An unserved endpoint is a server refusal, not a network outage.
            // Keep it visible in diagnostics rather than making Home offline.
            unservedHttpPaths.push(path);
            return new Response(JSON.stringify({ error: 'route_not_found' }), { status: 404,
                headers: { 'Content-Type': 'application/json' } });
        }
    });
    // Load the same server Artifact bytes used by the library HTTP fixture before
    // the saved editor opens its canonical get Action.
    await transport.fetch(`${location.origin}/v1/artifacts`);
    if (seed) {
        const home = await upsertAndActivateServer({ serverUrl: location.origin, name: 'Startup browser' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials);
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { automations: true } });
    }
    const home = getActiveServerSnapshot();
    if (!home.serverId || home.serverUrl !== location.origin) throw new Error('Startup browser did not restore persisted Home');
    if (!await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId })) {
        throw new Error('Startup browser did not retain persisted credentials');
    }
    const recordBootstrapState = () => {
        const state = storage.getState();
        const last = bootstrapStates.at(-1);
        if (!last || last.isDataReady !== state.isDataReady || last.profileScope !== state.profileScope) {
            bootstrapStates.push({ isDataReady: state.isDataReady, profileScope: state.profileScope });
        }
    };
    recordBootstrapState();
    storage.subscribe(recordBootstrapState);
    // Unmodified generated context and root layouts run AppBoot, credential/cache
    // restore, real providers, shell, navigation effects and editor admission.
    mountStartupRoot();
}

Object.assign(globalThis, { navigationHydrationBrowser, startupHarness: {
    mount,
    readNavigationState: () => ({ state: routerStore.state, routeInfo: routerStore.getRouteInfo(),
        isAuthenticated: getCurrentAuth()?.isAuthenticated, profileScope: storage.getState().profileScope,
        isDataReady: storage.getState().isDataReady }),
    readPersistenceState: () => ({ isDataReady: storage.getState().isDataReady,
        profileScope: storage.getState().profileScope, layouts: loadLocalSettings().workspaceLayoutV1 }),
    readBootstrapStates: () => bootstrapStates,
    readUnservedHttpPaths: () => unservedHttpPaths,
    readHomeGate: () => ({ requests: homeRequests, isDataReady: storage.getState().isDataReady }),
    releaseHome: () => releaseHome(),
    openWorkspace: (href: string) => invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { href, mode: 'newTab' } }),
    listWorkspace: () => invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} }),
} });
