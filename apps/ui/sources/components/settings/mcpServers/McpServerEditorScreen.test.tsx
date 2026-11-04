import 'fake-indexeddb/auto';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { pressTestInstance } from '@/dev/testkit/render/renderScreen';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol';
import { createArtifactStoreBoundary, type ArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { mcpServerRoute } from './collection/mcpServerCollectionModel';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { CollectionDraftTitleScope, useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setMcpSettingsSpy = vi.fn();
const settingsHttpWriteSpy = vi.fn();
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const retainedApprovalNavigationSpy = vi.fn();
const navigationDispatchSpy = vi.fn();
const navigationSetOptionsSpy = vi.fn();
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
}));
const uuidBoundary = vi.hoisted(() => ({ sequence: 0 }));
let unsavedChangesDecision: UnsavedChangesDecision = 'discard';
let navigationCanGoBack = false;
// Retained wire content is unknown until the actual catalog opener admits it.
type McpServersSettingsRaw = unknown;

let liveMcpSettings: McpServersSettingsRaw;
let liveSecrets: SavedSecret[] = [];
let liveMachines = [{ id: 'machine-1', metadata: { displayName: 'Machine 1' } }];
const liveSettingListeners = new Set<() => void>();
let catalogRevision = 3;
let rowMutationOutcome: 'updated' | 'conflict' = 'updated';
let rowMutationGate: Promise<void> | null = null;
let releaseRowMutation: (() => void) | null = null;
let postWriteReadGate: Promise<void> | null = null;
let releasePostWriteRead: (() => void) | null = null;
let accountScope: { serverId: string; accountId: string } | null = null;
let rowMutationRequests: ReturnType<typeof McpServerCatalogRowMutationV1Schema.parse>[] = [];
let compoundMutationRequests: ReturnType<typeof SharedSavedSecretPromoteInputV1Schema.parse>[] = [];
let loseCompoundAcknowledgement = false;
let standaloneResourceMutationRequests: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>[] = [];
let activeConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let approvalArtifacts: ArtifactStoreBoundary | null = null;
let disposeActionExecutorModuleLoader: (() => void) | undefined;

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

function notifyLiveSettingListeners() {
    for (const listener of liveSettingListeners) {
        listener();
    }
}

function resetLiveSettings() {
    uuidBoundary.sequence = 0;
    liveMcpSettings = {
        v: 1,
        strictMode: false,
        servers: [{
            id: 'server-1',
            name: 'hard-drives',
            transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] },
            env: {},
            createdAt: 1,
            updatedAt: 1,
        }],
        bindings: [{
            id: 'binding-1',
            serverId: 'server-1',
            enabled: true,
            target: { t: 'machine', machineId: 'machine-1' },
            createdAt: 1,
            updatedAt: 1,
        }],
    };
    liveSecrets = [];
    liveMachines = [{ id: 'machine-1', metadata: { displayName: 'Machine 1' } }];
    liveSettingListeners.clear();
    setMcpSettingsSpy.mockReset();
    settingsHttpWriteSpy.mockReset();
    catalogRevision = 3;
    rowMutationOutcome = 'updated';
    rowMutationGate = null;
    releaseRowMutation = null;
    postWriteReadGate = null;
    releasePostWriteRead = null;
    accountScope = null;
    rowMutationRequests = [];
    compoundMutationRequests = [];
    loseCompoundAcknowledgement = false;
    standaloneResourceMutationRequests = [];
    approvalArtifacts = null;
    modalAlertSpy.mockReset();
    modalConfirmSpy.mockReset();
    navigationDispatchSpy.mockReset();
    navigationSetOptionsSpy.mockReset();
    navigationPreventRemove.enabled = false;
    navigationPreventRemove.callback = null;
    unsavedChangesDecision = 'discard';
}

function updateLiveSecrets(next: SavedSecret[]) {
    liveSecrets = next;
    void import('@/sync/domains/state/storageStore').then(({ storage }) => {
        storage.setState({ settings: settingsParse({ ...storage.getState().settings, secrets: next }) });
    });
    notifyLiveSettingListeners();
}

// Configure presentation boundaries before loading domain graphs that also
// reach navigation/modal. Retire the harness's store stub before importing Sync.
const {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} = await import('./mcpServersTestHelpers');

const mcpServersCommonModuleMockOptions = {
    realComponents: true,
    // The default text mock serializes parameters (`key(name=value)`), so copy can be checked for what it names.
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            renderCustomModals: true,
            spies: {
                alert: (title, message, buttons) => {
                    modalAlertSpy(title, message);
                    if (title !== 'common.discardChanges') return;
                    const buttonText = unsavedChangesDecision === 'save'
                        ? 'common.save'
                        : unsavedChangesDecision === 'discard'
                            ? 'common.discard'
                            : 'common.keepEditing';
                    buttons?.find(button => button.text === buttonText)?.onPress?.();
                },
                confirm: (...args) => modalConfirmSpy(...args) as any,
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: {
                get: () => ({ width: 1440, height: 900 }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            params: () => mcpServersModuleState.routerSearchParams,
            router: {
                back: routerBackSpy,
                push: routerPushSpy,
                replace: routerReplaceSpy,
            },
            navigation: {
                canGoBack: () => navigationCanGoBack,
                dispatch: navigationDispatchSpy,
                setOptions: navigationSetOptionsSpy,
            },
        });

        return routerMock.module;
    },
    routerSearchParams: { serverId: 'server-1' },
};

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({ usePreventRemove: (
        enabled: boolean,
        callback: (event: { data: { action: unknown } }) => void,
    ) => {
        navigationPreventRemove.enabled = enabled;
        navigationPreventRemove.callback = callback;
    } });
});

installMcpServersCommonModuleMocks(mcpServersCommonModuleMockOptions);
// The catalog API imports the common Settings writer through retained-history
// maintenance. Import that real owner only after retiring this presentation
// harness's internal store stub; unmocking in beforeEach is too late for its
// already-captured storage dependency and prevents Sync policy publication.
vi.doUnmock('@/sync/domains/state/storage');
// PageHeader binds the button during collection. Its real action lifecycle must
// be present before that owner loads, not first unmocked in beforeEach.
vi.doUnmock('@/components/ui/buttons/RoundButton');
const { findTestInstanceByTypeContainingText, renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeId, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { useMachineAdministrationTargetSelection, resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
// This host reaches both navigation and the store; load it only after the
// configured presentation boundaries and real domain store are established.
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { resetMcpServerCatalogEngineForTests, refreshMcpServerCatalog } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { resetSavedSecretCatalogEngineForTests } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const { resetSavedSecretCatalogSnapshotsForTests } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => ++uuidBoundary.sequence === 1 ? 'uuid' : `uuid-${uuidBoundary.sequence}`,
}));

function CollectionDraftTitleObservation() {
    const title = useCollectionDraftTitle().useTitle();
    return React.createElement('CollectionDraftTitleObservation', { testID: 'mcp.server.editor.published-title', title });
}

async function renderEditorScreen(options: Readonly<{ activeAccount?: boolean; ask?: boolean;
    mcpUpdatePolicy?: 'disabled' | 'ask'; mcpDeletePolicy?: 'ask' | 'allowed'; hosted?: boolean; machineDifferenceModal?: boolean;
    observeDraftTitle?: boolean }> = {}) {
    const configuredHome = await upsertServerProfileOnly({ serverUrl: options.mcpUpdatePolicy
        ? `https://mcp-editor-update-${options.mcpUpdatePolicy}.test` : options.ask ? 'https://mcp-editor-ask-row.test' : options.activeAccount
        ? 'https://mcp-editor-active-row.test' : 'https://mcp-editor-row.test', name: 'MCP editor' });
    const serverIdentityId = `srv_${new URL(configuredHome.serverUrl).hostname.replace(/\./g, '-')}`;
    const home = await setServerProfileIdentityForUrl(configuredHome.serverUrl, serverIdentityId);
    if (!home) throw new Error('Expected the editor Home portable identity');
    const accountId = 'mcp-editor-account';
    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
        token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    });
    accountScope = { serverId: resolveServerProfileScopeId(home), accountId };
    const { storage } = await import('@/sync/domains/state/storageStore');
    let settingsReads = 0;
    const unhandledRequests: string[] = [];
    onTestFailed(async () => {
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        console.error('MCP editor boundary refusal', {
            scope: accountScope, profileScope: storage.getState().profileScope,
            settingsScope: storage.getState().settingsScope, credentialsPresent: Boolean(credentials),
            isDataReady: storage.getState().isDataReady, machineCount: Object.keys(storage.getState().machines).length,
            settingsReads, artifacts: approvalArtifacts?.list().length,
            rowWrites: rowMutationRequests.length, compoundWrites: compoundMutationRequests.length,
            alerts: modalAlertSpy.mock.calls.map(([title, reason]) => ({ title, reason })),
            pushes: routerPushSpy.mock.calls, replacements: routerReplaceSpy.mock.calls,
            unhandledRequests,
        });
    });
    const machines = liveMachines.map(machine => createMachineFixture({ id: machine.id,
        activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, ...machine.metadata } }));
    let settingsVersion = 7;
    let rawSettings: Record<string, unknown> = { userNote: 'unrelated', actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: {
            ...(options.ask ? { 'mcp.servers.import': { approvalRequiredSurfaces: ['ui'] } } : {}),
            ...(options.mcpUpdatePolicy === 'disabled' ? { 'mcp.servers.update': { disabledSurfaces: ['ui'] } } : {}),
            ...(options.mcpUpdatePolicy === 'ask' ? { 'mcp.servers.update': { approvalRequiredSurfaces: ['ui'] } } : {}),
            ...(options.mcpDeletePolicy === 'ask' ? { 'mcp.servers.delete': { approvalRequiredSurfaces: ['ui'] } } : {}),
        }, approvalWaivedSurfaces: {
            ...(!options.ask ? { 'secrets.shared.promote': ['ui'], 'secrets.shared.create': ['ui'] } : {}),
            ...(!options.ask ? { 'mcp.servers.import': ['ui'] } : {}),
            'mcp.servers.create': ['ui'],
            ...(options.mcpDeletePolicy === 'allowed' ? { 'mcp.servers.delete': ['ui'] } : {}),
            ...(!options.mcpUpdatePolicy ? { 'mcp.servers.update': ['ui'] } : {}),
        } }) };
    approvalArtifacts = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
    const machineRows = Object.fromEntries(machines.map(machine => [machine.id, machine]));
    // Every case restores the actual Home and publishes its first Settings
    // baseline from HTTP; no parsed Settings/Account projection authorizes it.
    storage.setState({ machines: machineRows });
    const request: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
        const path = new URL(String(url)).pathname;
        const artifactResponse = approvalArtifacts!.handle(path + new URL(String(url)).search, init);
        if (artifactResponse) return await artifactResponse;
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId } },
        }));
        if (path === '/v1/machines') return Response.json(machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId })));
        if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({ sessions: [], nextCursor: null, hasNext: false }));
        if (path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
            snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
                pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
        }));
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: accountId }));
        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }));
        }
        if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0,
                pluginIds: [], intentReads: [], failedPluginIds: [] }));
        }
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v2/account/settings') {
            if (init?.method === 'POST') {
                const input = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                settingsHttpWriteSpy(input);
                if (input.expectedVersion !== settingsVersion) return Response.json({ success: false, error: 'version-mismatch',
                    currentVersion: settingsVersion, currentContent: { t: 'plain', v: rawSettings } });
                if (input.content?.t !== 'plain') throw new Error('Expected plain Settings fixture content');
                rawSettings = input.content.v;
                settingsVersion += 1;
                return Response.json({ success: true, version: settingsVersion });
            }
            settingsReads += 1;
            return Response.json({ version: settingsVersion, content: { t: 'plain', v: rawSettings } });
        }
        if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
        if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json(
            SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: standaloneResourceMutationRequests.map(input => ({
                resourceId: input.resourceId, encryptionMode: input.encryptionMode,
                recipientEnvelope: null, storedContent: input.storedContent,
                entry: { ref: formatSharedSavedSecretRefV1(input.resourceId), source: 'shared_resource',
                    relationship: 'owner', ownerAccountId: accountId, name: input.displayName, kind: input.kind,
                    revision: 1, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            })) }));
        if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'] && init?.method === 'POST') {
            const input = SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(String(init.body)));
            standaloneResourceMutationRequests.push(input);
            return Response.json({ resourceId: input.resourceId, revision: 1 });
        }
        if (path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.promote'] && init?.method === 'POST') {
            const input = SharedSavedSecretPromoteInputV1Schema.parse(JSON.parse(String(init.body)));
            compoundMutationRequests.push(input);
            await rowMutationGate;
            const mutation = McpServerCatalogRowMutationV1Schema.parse(input.catalogMutations?.mcp);
            if (mutation.expectedRevision !== catalogRevision) return Response.json({ error: 'catalog_conflict' }, { status: 409 });
            if (mutation.content?.t !== 'plain') throw new Error('Expected plain compound MCP fixture');
            liveMcpSettings = { ...mutation.content.v, strictMode: false };
            catalogRevision += 1;
            if (loseCompoundAcknowledgement) throw new TypeError('Connection lost after the atomic commit');
            return Response.json({ resourceId: input.resourceId, settingsVersion });
        }
        if (path === '/v1/account/entity-rows/mcp') {
            if (init?.method === 'POST') {
                const input = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                rowMutationRequests.push(input);
                if (input.content?.t !== 'plain') throw new Error('Expected plain MCP fixture content');
                setMcpSettingsSpy({ ...input.content.v, strictMode: false });
                await rowMutationGate;
                if (rowMutationOutcome === 'conflict' || input.expectedRevision !== catalogRevision) {
                    return Response.json({ status: 'conflict', revision: catalogRevision });
                }
                liveMcpSettings = { ...input.content.v, strictMode: false };
                catalogRevision += 1;
                if (loseCompoundAcknowledgement) throw new TypeError('Connection lost after the catalog commit');
                return Response.json({ status: 'updated', revision: catalogRevision, cursor: catalogRevision });
            }
            if (rowMutationRequests.length > 0) await postWriteReadGate;
            if (!liveMcpSettings || typeof liveMcpSettings !== 'object' || Array.isArray(liveMcpSettings)) {
                return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: liveMcpSettings } });
            }
            const { strictMode: _strictMode, ...catalog } = liveMcpSettings as Record<string, unknown>;
            return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } });
        }
        unhandledRequests.push(`${init?.method ?? 'GET'} ${path}`);
        return Response.json({ error: 'not_found' }, { status: 404 });
    };
    setRuntimeFetch(request);
    {
        installDisconnectedServerSocketBoundary();
        await loadSyncSingletonForTests();
        activeConnection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId, credentials: {
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        }, request });
        // A cold transport has no connect event to demand the ordinary list.
        // Use Sync's public reader so active-Home readiness comes from HTTP.
        const { sync } = await import('@/sync/sync');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const captured = await captureLazyActionAccountContext(home.id);
            try {
                const actualRaw = await captured.readRawSettings();
                expect(actualRaw.actionsSettingsV1).toEqual(rawSettings.actionsSettingsV1);
                expect(settingsParse(actualRaw).actionsSettingsV1).toEqual(rawSettings.actionsSettingsV1);
                // This live projection is what the real front door prefers
                // for the same Account; wait for genuine Sync publication.
                await vi.waitFor(() => expect(storage.getState().settings.actionsSettingsV1).toEqual(rawSettings.actionsSettingsV1));
                expect((await captured.readSettings()).actionsSettingsV1).toEqual(rawSettings.actionsSettingsV1);
            }
            finally { captured.dispose(); }
        }
    }
    storage.getState().applyMachines(machines, true, { sourceServerId: home.id });
    // Choose through the real Administration controller after publishing the
    // same Home's genuine Machine census, not a fabricated target resolver.
    const targetSelection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers));
    try {
        if (machines.length > 0) {
            const target = { serverIdentityId, machineId: machines[0]!.id };
            await vi.waitFor(() => expect(resolveFreshMachineAdministrationExecutionTarget(target)).not.toBeNull());
            await act(async () => { targetSelection.getCurrent().selectTarget(target); });
            await vi.waitFor(() => expect(targetSelection.getCurrent().selectedTarget).toEqual(target));
        } else {
            await act(async () => { targetSelection.getCurrent().clearTarget(); });
            expect(targetSelection.getCurrent().selectedTarget).toBeNull();
        }
    } finally { await targetSelection.unmount(); }
    const routeBoundary = await import('expo-router');
    const route = await renderHook(() => routeBoundary.useLocalSearchParams());
    try { expect(route.getCurrent()).toEqual(mcpServersModuleState.routerSearchParams); }
    finally { await route.unmount(); }
    const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
    const { ModalProvider } = await import('@/modal');
    const editor = options.machineDifferenceModal
        ? <ModalProvider><McpServerEditorScreen /></ModalProvider>
        : React.createElement(McpServerEditorScreen);
    const scopedEditor = options.observeDraftTitle
        ? <CollectionDraftTitleScope>{editor}<CollectionDraftTitleObservation /></CollectionDraftTitleScope>
        : editor;
    const screen = await renderScreen(options.hosted ? <DestinationInstanceHost
        tabId="mcp-editor" ref={{ kind: 'settings', params: { pageId: 'mcp', serverId: 'server-1' } }}
        pathname="/settings/mcp/servers/server-1" focused visible navigation={{
            push: href => { void runGuardedNavigation(() => routerPushSpy(href)); },
            pushRetainingCurrent: retainedApprovalNavigationSpy,
            replace: routerReplaceSpy,
            back: routerBackSpy,
        }}>{scopedEditor}</DestinationInstanceHost> : scopedEditor);
    await act(async () => { await refreshMcpServerCatalog(accountScope!); });
    return screen;
}

afterEach(async () => {
    releaseRowMutation?.();
    releasePostWriteRead?.();
    await standardCleanup();
    await activeConnection?.dispose();
    activeConnection = null;
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetRuntimeFetch();
    disposeActionExecutorModuleLoader?.();
    disposeActionExecutorModuleLoader = undefined;
});

beforeEach(async () => {
    resetMcpServersCommonModuleMockState();
    resetLiveSettings();
    navigationCanGoBack = false;
    routerBackSpy.mockReset();
    routerReplaceSpy.mockReset();
    routerPushSpy.mockReset();
    retainedApprovalNavigationSpy.mockReset();
    installMcpServersCommonModuleMocks(mcpServersCommonModuleMockOptions);
    // Sync restoration must see the real store domains, not the shared UI
    // harness's presentation-only stub.
    vi.doUnmock('@/sync/domains/state/storage');
    disposeActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    // Exercise the real button action owner; a synthetic host drops PageHeader's async action.
    vi.doUnmock('@/components/ui/buttons/RoundButton');
    mcpServersModuleState.routerSearchParams = { serverId: 'server-1' };
});

/** A Configuration field (the input itself, not its row). */
function configField(screen: Awaited<ReturnType<typeof renderEditorScreen>>, testID: string) {
    return screen.findAllByTestId(testID).find((node) => typeof node.props.onChangeText === 'function')!;
}
async function typeConfig(screen: Awaited<ReturnType<typeof renderEditorScreen>>, testID: string, text: string) {
    await act(async () => { configField(screen, testID).props.onChangeText(text); });
}
/** Focus leaves the field: a new server keeps the value in its draft; a saved server saves it. */
async function leaveConfig(screen: Awaited<ReturnType<typeof renderEditorScreen>>, testID: string) {
    await act(async () => { configField(screen, testID).props.onBlur?.(); });
}

describe('McpServerEditorScreen', () => {
    it('saves Session folder from the real machine difference modal into the catalog', async () => {
        liveMcpSettings = { v: 1, strictMode: false, servers: [{ id: 'server-1', name: 'hard-drives', transport: 'stdio',
            stdio: { command: 'echo', args: [], cwd: { t: 'path', path: '/base-folder' } }, env: {}, createdAt: 1, updatedAt: 1,
            configOverrides: [{ target: { t: 'machine', machineId: 'machine-1' }, stdio: { cwd: { t: 'path', path: '/machine-folder' } } }],
        }], bindings: [] };
        const screen = await renderEditorScreen({ machineDifferenceModal: true });
        await act(async () => {
            const disclosure = screen.findHostByTestId('mcp.server.differences.toggle')!;
            pressTestInstance(disclosure.findAll(node => typeof node.props.onPress === 'function')[0]);
        });
        await act(async () => { screen.pressByTestId('mcp.server.differences.row.0'); });
        const folder = screen.findAllByTestId('mcp.server.config.folder')
            .filter(node => typeof node.props.onSelect === 'function' && node.props.selectedId === 'path').pop();
        expect(folder).toBeDefined();
        // The modal's picker clears cwd for Session folder; Save must encode that as an explicit override.
        await act(async () => { folder!.props.onSelect('session'); });
        await act(async () => { screen.pressByTestId('mcp.server.differences.save'); });
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: { servers: [{
            stdio: { cwd: { t: 'path', path: '/base-folder' } },
            configOverrides: [{ target: { t: 'machine', machineId: 'machine-1' }, stdio: { cwd: { t: 'session' } } }],
        }], bindings: [] } });
        expect(screen.findAllByTestId('mcp.server.differences.save')).toHaveLength(0);
    });
    it('saves a saved server\'s Configuration when focus leaves a value, keeping its machine differences and reach rules', async () => {
        const configOverrides = [{ target: { t: 'machine', machineId: 'machine-1' }, stdio: { command: 'machine-command' } }];
        const bindings = [{ id: 'binding-1', serverId: 'server-1', target: { t: 'allMachines' }, enabled: false,
            createdAt: 1, updatedAt: 1 }];
        liveMcpSettings = { v: 1, strictMode: false, servers: [{ id: 'server-1', name: 'hard-drives', transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] }, env: {}, createdAt: 1, updatedAt: 1, configOverrides }], bindings };
        const screen = await renderEditorScreen();
        const command = () => screen.findAllByTestId('mcp.server.editor.command')
            .find((node) => typeof node.props.onChangeText === 'function')!;
        expect(command().props.value).toBe('node');
        // Typing alone writes nothing; there is no Save on a saved server's page.
        await act(async () => { command().props.onChangeText('bun'); });
        await flushHookEffects();
        expect(rowMutationRequests).toHaveLength(0);
        expect(screen.findAllByTestId('mcp.server.editor.save')).toHaveLength(0);

        await act(async () => { command().props.onBlur?.(); });
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: {
            servers: [{ name: 'hard-drives', stdio: { command: 'bun', args: ['server.js'] }, configOverrides }], bindings,
        } });
        await vi.waitFor(() => expect(screen.findAllByTestId('mcp.server.config.saveState').length).toBeGreaterThan(0));
    });

    it('keeps a new draft open and dirty until its destination CAS is acknowledged', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen();
        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'awaiting-ack');
        });
        await typeConfig(screen, 'mcp.server.editor.command', 'mcp-server');
        await leaveConfig(screen, 'mcp.server.editor.command');
        rowMutationGate = new Promise<void>(resolve => { releaseRowMutation = resolve; });
        try {
            act(() => { screen.pressByTestId('mcp.server.editor.save'); });
            await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
            expect(routerReplaceSpy).not.toHaveBeenCalled();
            expect(navigationPreventRemove.enabled).toBe(true);
            expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
            releaseRowMutation?.();
            await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp/uuid'));
        } finally { releaseRowMutation?.(); }
    });

    it('honors the disabled MCP update Action for an ordinary editor Save without writing the row', async () => {
        mcpServersModuleState.routerSearchParams = { serverId: 'server-1' };
        const screen = await renderEditorScreen({ activeAccount: true, mcpUpdatePolicy: 'disabled' });
        await typeConfig(screen, 'mcp.server.editor.command', 'disabled-policy-draft');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(rowMutationRequests.length + modalAlertSpy.mock.calls.length
            + routerReplaceSpy.mock.calls.length).toBeGreaterThan(0));
        expect(rowMutationRequests).toHaveLength(0);
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'action_disabled');
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('disabled-policy-draft');
        expect(navigationPreventRemove.enabled).toBe(true);
    });

    it('opens the original MCP approval while retaining the dirty editor and later edits without replay', async () => {
        mcpServersModuleState.routerSearchParams = { serverId: 'server-1' };
        const screen = await renderEditorScreen({ activeAccount: true, mcpUpdatePolicy: 'ask', hosted: true });
        await typeConfig(screen, 'mcp.server.editor.command', 'approved-policy-draft');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(approvalArtifacts!.list().length + rowMutationRequests.length
            + modalAlertSpy.mock.calls.length + routerReplaceSpy.mock.calls.length).toBeGreaterThan(0));
        expect(approvalArtifacts!.list()).toHaveLength(1);
        expect(rowMutationRequests).toHaveLength(0);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(routerPushSpy).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.editor.approval')).not.toBeNull());
        const artifact = approvalArtifacts!.list()[0]!;
        const request = StoredApprovalRequestSchema.parse(JSON.parse(approvalArtifacts!.readPlainBody(artifact.id)!));
        if (request.v !== 2) throw new Error('Expected typed MCP update approval');
        expect(request.actionId).toBe('mcp.servers.update');
        expect(request.actionArgs).toMatchObject({ expectedRevision: 3, entry: { id: 'server-1', stdio: { command: 'approved-policy-draft' } } });
        await typeConfig(screen, 'mcp.server.editor.command', 'later-local-edit');
        unsavedChangesDecision = 'keepEditing';
        await act(async () => {
            const notice = screen.findAll(node => node.props.testID === 'mcp.server.editor.approval'
                && typeof node.props.onOpenApproval === 'function')[0]!;
            notice.props.onOpenApproval();
        });
        expect(retainedApprovalNavigationSpy).toHaveBeenCalledWith(
            `/inbox/approvals/${encodeURIComponent(artifact.id)}?serverId=${encodeURIComponent(accountScope!.serverId)}`,
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('later-local-edit');
        // The real Inbox decision executes the captured Action against this
        // HTTP row and publishes its genuine durable approval receipt.
        const decision = await decideApprovalAsInbox(accountScope!.serverId, artifact.id, 'approve');
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(catalogRevision).toBe(4));
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('later-local-edit');
        expect(approvalArtifacts!.list()).toHaveLength(1);
        expect(rowMutationRequests).toHaveLength(1);
        expect(rowMutationRequests[0]?.expectedRevision).toBe(3);
        expect(catalogRevision).toBe(4);
    });

    it('saves a typed value against the latest revision when another writer moved the server first', async () => {
        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'local-draft');
        liveMcpSettings = { v: 1, strictMode: false, servers: [{ id: 'server-1', name: 'remote-edit', transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] }, env: {}, createdAt: 1, updatedAt: 2 }], bindings: [] };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        // The typed value survives the other writer's change, which the page now shows.
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('local-draft');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.expectedRevision).toBe(4);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: {
            servers: [{ name: 'remote-edit', stdio: { command: 'local-draft', args: ['server.js'] } }],
        } });
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('rebases an open dirty configuration over an observed Test snapshot without losing either change', async () => {
        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.args.item.0', 'local-argument');
        await typeConfig(screen, 'mcp.server.editor.command', 'local-command');
        const current = McpServersSettingsV1Schema.parse(liveMcpSettings);
        const toolsSnapshot = { checkedAt: 10, machineId: 'machine-1', tools: [{ name: 'read', tokens: 12 }] };
        liveMcpSettings = { ...current, servers: current.servers.map(server => ({ ...server, toolsSnapshot, updatedAt: 10 })) };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('local-command');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.expectedRevision).toBe(4);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: { servers: [{
            stdio: { command: 'local-command', args: ['local-argument'] }, toolsSnapshot,
        }] } });
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('saves the rebased entry when a catalog publication and blur share an effect flush', async () => {
        const screen = await renderEditorScreen();
        const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
        const { applyMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
        const { McpServerCatalogV1Schema } = await import('@happier-dev/protocol/mcp/servers/serverRowsV1');
        const current = McpServersSettingsV1Schema.parse(liveMcpSettings);
        const toolsSnapshot = { checkedAt: 10, machineId: 'machine-1', tools: [{ name: 'read', tokens: 12 }] };
        const { strictMode: _strictMode, ...catalog } = current;
        const next = McpServerCatalogV1Schema.parse({ ...catalog,
            servers: catalog.servers.map(server => ({ ...server, toolsSnapshot, updatedAt: 10 })) });
        liveMcpSettings = { ...next, strictMode: false };
        catalogRevision = 4;
        // Publish through the real subscription owner in the same React turn as the committed field intent.
        await act(async () => {
            applyMcpServerCatalogSnapshot(accountScope!, { status: 'ready', authority: 'active', revision: 4,
                catalog: next, diagnostics: [] }, true);
            const detail = screen.findByType(McpServerDetailPage);
            detail.props.onChangeServer((server: (typeof next.servers)[number]) => ({ ...server,
                stdio: { ...server.stdio!, command: 'same-turn-command' } }));
            detail.props.onCommitConfiguration();
        });
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.expectedRevision).toBe(4);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: { servers: [{
            stdio: { command: 'same-turn-command' }, toolsSnapshot,
        }] } });
    });

    it('preserves a real concurrent edit for Review and saves only after the current version is reviewed', async () => {
        const screen = await renderEditorScreen();
        const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
        await typeConfig(screen, 'mcp.server.editor.command', 'local-command');
        const current = McpServersSettingsV1Schema.parse(liveMcpSettings);
        liveMcpSettings = { ...current, servers: current.servers.map(server => ({ ...server,
            stdio: { ...server.stdio!, command: 'remote-command', args: ['remote-argument'] }, updatedAt: 10 })) };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        await leaveConfig(screen, 'mcp.server.editor.command');
        await flushHookEffects();
        expect(rowMutationRequests).toHaveLength(0);
        expect(modalAlertSpy).not.toHaveBeenCalled();
        const conflict = screen.findByType(McpServerDetailPage).props.configurationConflict;
        expect(conflict).toMatchObject({ phase: 'detected', currentServer: { stdio: { command: 'remote-command' } } });
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('local-command');
        const beforeReview = McpServersSettingsV1Schema.parse(liveMcpSettings);
        liveMcpSettings = { ...beforeReview, servers: beforeReview.servers.map(server => ({ ...server,
            env: { REGION: { t: 'literal', v: 'eu' } }, updatedAt: 11 })) };
        catalogRevision = 5;
        await act(async () => { await conflict.onReview(); });
        expect(screen.findByType(McpServerDetailPage).props.configurationConflict.phase).toBe('reviewing');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.expectedRevision).toBe(5);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: { servers: [{
            stdio: { command: 'local-command', args: ['remote-argument'] },
            env: { REGION: { t: 'literal', v: 'eu' } },
        }] } });
    });

    async function openConcurrentReview() {
        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'local-command');
        const current = McpServersSettingsV1Schema.parse(liveMcpSettings);
        liveMcpSettings = { ...current, servers: current.servers.map(server => ({ ...server,
            stdio: { ...server.stdio!, command: 'remote-command' }, updatedAt: 10 })) };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        await leaveConfig(screen, 'mcp.server.editor.command');
        await flushHookEffects();
        return screen;
    }

    it('shows Changed elsewhere · Review on the page, lays both versions side by side, and Keep mine saves the open one', async () => {
        const screen = await openConcurrentReview();
        expect(screen.findByTestId('mcp.server.conflict.line')).not.toBeNull();
        expect(screen.findByTestId('mcp.server.conflict.review')).toBeNull();
        await act(async () => { screen.pressByTestId('mcp.server.conflict.line-action'); });
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.conflict.field.command')).not.toBeNull(), { timeout: 5000 });
        const review = screen.getTextContent();
        expect(review).toContain('remote-command');
        expect(review).toContain('local-command');
        expect(rowMutationRequests).toHaveLength(0);
        await act(async () => { screen.pressByTestId('mcp.server.conflict.keepMine'); });
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.expectedRevision).toBe(4);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: { servers: [{ stdio: { command: 'local-command' } }] } });
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.conflict')).toBeNull());
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('Use current drops the open edit without writing anything', async () => {
        const screen = await openConcurrentReview();
        await act(async () => { screen.pressByTestId('mcp.server.conflict.line-action'); });
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.conflict.useCurrent')).not.toBeNull(), { timeout: 5000 });
        await act(async () => { screen.pressByTestId('mcp.server.conflict.useCurrent'); });
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.conflict')).toBeNull());
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('remote-command');
        expect(rowMutationRequests).toHaveLength(0);
        expect(navigationPreventRemove.enabled).toBe(false);
    });

    it('says the server was removed elsewhere, and discarding the edit closes the page without recreating it', async () => {
        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'retained-command');
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        await act(async () => { screen.pressByTestId('mcp.server.conflict.line-action'); });
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.conflict.removed')).not.toBeNull(), { timeout: 5000 });
        expect(screen.findByTestId('mcp.server.conflict.keepMine')).toBeNull();
        await act(async () => { screen.pressByTestId('mcp.server.conflict.discard'); });
        expect(routerReplaceSpy).toHaveBeenCalledOnce();
        expect(rowMutationRequests).toHaveLength(0);
        expect(McpServersSettingsV1Schema.parse(liveMcpSettings).servers).toEqual([]);
    });

    it('turns an unobserved CAS refusal into the same Review continuation rather than a raw alert', async () => {
        const screen = await renderEditorScreen();
        const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
        await typeConfig(screen, 'mcp.server.editor.command', 'local-command');
        rowMutationOutcome = 'conflict';
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(screen.findByType(McpServerDetailPage).props.configurationConflict).toBeTruthy());
        expect(screen.findByType(McpServerDetailPage).props.configurationConflict.phase).toBe('detected');
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('local-command');
    });

    it('removes a machine difference after an observed Test snapshot while preserving the snapshot and reach', async () => {
        const initial = McpServersSettingsV1Schema.parse(liveMcpSettings);
        liveMcpSettings = { ...initial, servers: initial.servers.map(server => ({ ...server,
            configOverrides: [{ target: { t: 'machine', machineId: 'machine-1' }, stdio: { cwd: { t: 'session' } } }],
        })) };
        const screen = await renderEditorScreen();
        const current = McpServersSettingsV1Schema.parse(liveMcpSettings);
        const toolsSnapshot = { checkedAt: 10, machineId: 'machine-1', tools: [{ name: 'read', tokens: 12 }] };
        liveMcpSettings = { ...current, servers: current.servers.map(server => ({ ...server, toolsSnapshot, updatedAt: 10 })) };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        await act(async () => {
            const disclosure = screen.findHostByTestId('mcp.server.differences.toggle')!;
            pressTestInstance(disclosure.findAll(node => typeof node.props.onPress === 'function')[0]);
        });
        await act(async () => { screen.pressByTestId('mcp.server.differences.row.0.remove'); });
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.expectedRevision).toBe(4);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: {
            servers: [{ configOverrides: [], toolsSnapshot }], bindings: initial.bindings,
        } });
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('keeps a server after a delete CAS conflict and offers the same Review continuation', async () => {
        const screen = await renderEditorScreen();
        const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
        rowMutationOutcome = 'conflict';
        await act(async () => { screen.pressByTestId('mcp.server.editor.remove'); });
        await vi.waitFor(() => expect(screen.findByType(McpServerDetailPage).props.configurationConflict).toBeTruthy());
        expect(McpServersSettingsV1Schema.parse(liveMcpSettings).servers.map(server => server.id)).toEqual(['server-1']);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('keeps typing made during its own pending save without treating the acknowledgement as a concurrent edit', async () => {
        const screen = await renderEditorScreen();
        const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
        rowMutationGate = new Promise(resolve => { releaseRowMutation = resolve; });
        await typeConfig(screen, 'mcp.server.editor.command', 'first-command');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        await typeConfig(screen, 'mcp.server.editor.command', 'later-command');
        await act(async () => { releaseRowMutation?.(); });
        await vi.waitFor(() => expect(catalogRevision).toBe(4));
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('later-command');
        expect(screen.findByType(McpServerDetailPage).props.configurationConflict).toBeNull();
        await leaveConfig(screen, 'mcp.server.editor.command');
        await vi.waitFor(() => expect(catalogRevision).toBe(5));
        expect(McpServersSettingsV1Schema.parse(liveMcpSettings).servers[0]?.stdio?.command).toBe('later-command');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('leaves a saved editor pristine when a typed field returns to its acknowledged value', async () => {
        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'temporary-command');
        await typeConfig(screen, 'mcp.server.editor.command', 'node');
        await leaveConfig(screen, 'mcp.server.editor.command');
        expect(rowMutationRequests).toHaveLength(0);
        expect(navigationPreventRemove.enabled).toBe(false);
    });

    it('retains an edited server after another writer deletes it and never recreates it on Review', async () => {
        const screen = await renderEditorScreen();
        const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
        await typeConfig(screen, 'mcp.server.editor.command', 'retained-command');
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        expect(configField(screen, 'mcp.server.editor.command')).toBeDefined();
        expect(configField(screen, 'mcp.server.editor.command').props.value).toBe('retained-command');
        const conflict = screen.findByType(McpServerDetailPage).props.configurationConflict;
        expect(conflict).toMatchObject({ phase: 'detected', currentServer: null });
        await act(async () => { await conflict.onReview(); });
        await leaveConfig(screen, 'mcp.server.editor.command');
        expect(rowMutationRequests).toHaveLength(0);
        expect(McpServersSettingsV1Schema.parse(liveMcpSettings).servers).toEqual([]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('prompts to discard an unsaved new server when navigating away via the navigation back action', async () => {
        // A saved server saves on blur; only a server being added holds unsaved edits.
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'node');
        await leaveConfig(screen, 'mcp.server.editor.command');

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'server_edited');
        });

        expect(navigationPreventRemove.enabled).toBe(true);
        expect(navigationPreventRemove.callback).not.toBeNull();
        expect(screen.findByTestId('mcp.server.editor.save')?.props.disabled).toBe(false);

        const action = { type: 'GO_BACK' };

        await act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 3 });
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.discardChanges', 'common.unsavedChangesWarning');
        expect(navigationDispatchSpy).toHaveBeenCalledWith(action);
    });

    it('saves a new server before completing navigation when the user chooses save in the unsaved-changes prompt', async () => {
        unsavedChangesDecision = 'save';
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };

        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'node');
        await leaveConfig(screen, 'mcp.server.editor.command');

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'server_edited');
        });

        const action = { type: 'GO_BACK' };

        await act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 3 });
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.discardChanges', 'common.unsavedChangesWarning');
        await vi.waitFor(() => expect(navigationDispatchSpy).toHaveBeenCalledWith(action));
        expect(rowMutationRequests).toHaveLength(1);
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: {
            servers: [{ name: 'server_edited', stdio: { command: 'node' } }],
        } });
    });

    it('uses the Action Ask policy without a caller dialog or an unapproved catalog delete', async () => {
        const screen = await renderEditorScreen({ mcpDeletePolicy: 'ask' });
        await act(async () => { screen.pressByTestId('mcp.server.editor.remove'); });
        await vi.waitFor(() => expect(approvalArtifacts!.list()).toHaveLength(1));
        expect(rowMutationRequests).toHaveLength(0);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('honors Allowed and falls back to the MCP settings screen after delete without a dialog', async () => {
        const screen = await renderEditorScreen({ mcpDeletePolicy: 'allowed' });

        // Remove is the page's way out, at its foot.
        await act(async () => {
            screen.pressByTestId('mcp.server.editor.remove');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp'));
        expect(rowMutationRequests).toHaveLength(1);
        expect(rowMutationRequests[0]?.content).toEqual({ t: 'plain', v: {
            v: 1, servers: [], bindings: [],
        } });
        expect(approvalArtifacts!.list()).toHaveLength(0);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('duplicates the saved server from the header menu without a confirmation and opens the new row', async () => {
        const screen = await renderEditorScreen();
        // Another device saves after this screen renders. Duplicate must read
        // the current source and revision at the Account Action owner.
        const current = McpServersSettingsV1Schema.parse(liveMcpSettings);
        liveMcpSettings = { ...current, servers: current.servers.map(server => ({ ...server,
            stdio: { command: 'current-command', args: ['current-argument'] } })) };
        catalogRevision += 1;
        const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const menu = () => screen.findByType(PageHeaderMenu);
        expect(menu().props.actions.map((action: { id: string }) => action.id)).toContain('duplicate');
        await act(async () => {
            await menu().props.actions.find((action: { id: string }) => action.id === 'duplicate').onSelect();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        const written = (rowMutationRequests[0]!.content as { v: { servers: { id: string; name: string }[]; bindings: unknown[] } }).v;
        expect(written.servers.map((server) => server.name)).toEqual(['hard-drives', 'hard-drives_copy']);
        expect(written.servers[1]).toMatchObject({ stdio: { command: 'current-command', args: ['current-argument'] } });
        const copyId = written.servers[1]!.id;
        expect(copyId).not.toBe('server-1');
        // The copy gets the default reach, never the source's rules.
        expect(written.bindings).not.toContainEqual(expect.objectContaining({ serverId: copyId, target: { t: 'machine', machineId: 'machine-1' } }));
        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith(mcpServerRoute(copyId)));
        expect(modalConfirmSpy).not.toHaveBeenCalled();
    });

    it('confirms deleting the saved server by the name the collection shows, not an unsaved edit', async () => {
        // This case observes the translation's name argument. The shared cold
        // module graph can already have installed the key-only text boundary.
        const text = await import('@/text');
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const textBoundary = createTextModuleMock();
        const translateImplementation: typeof text.t = (key, ...params) => {
            const argument = params[0];
            const boundaryParams = typeof argument === 'object' && argument !== null
                ? Object.fromEntries(Object.entries(argument))
                : undefined;
            return String(textBoundary.t(key, boundaryParams));
        };
        const translate = vi.spyOn(text, 't').mockImplementation(translateImplementation);
        try {
            liveMcpSettings = {
                v: 1,
                strictMode: false,
                servers: [{
                    id: 'server-1', name: 'github', title: 'GitHub tools', transport: 'stdio',
                    stdio: { command: 'node', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
                }],
                bindings: [],
            };
            modalConfirmSpy.mockResolvedValueOnce(false);
            const screen = await renderEditorScreen();
            await typeConfig(screen, 'mcp.server.editor.command', 'github_renamed_unsaved');
            await act(async () => {
                screen.pressByTestId('mcp.server.editor.remove');
                await flushHookEffects({ cycles: 1, turns: 1 });
            });

            await vi.waitFor(() => expect(modalConfirmSpy).toHaveBeenCalledTimes(1));
            const presentation = modalConfirmSpy.mock.calls[0]?.slice(0, 2).join(' ');
            expect(presentation).toContain('GitHub tools');
            expect(presentation).not.toContain('github_renamed_unsaved');
            expect(rowMutationRequests).toHaveLength(0);
            expect(modalAlertSpy).not.toHaveBeenCalled();
        } finally { translate.mockRestore(); }
    });

    it('renders the custom draft as the detail body in create mode: one name, Where it\'s on and Configuration, nothing to test before it exists', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };

        const screen = await renderEditorScreen();

        expect(screen.findByTestId('mcp.server.editor.name')).not.toBeNull();
        expect(screen.findByTestId('mcp.server.config')).not.toBeNull();
        expect(screen.findAllByProps({ kind: 'mcp_server', presentation: 'section' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('mcp.server.editor.title')).toBeNull();
        expect(screen.findByTestId('mcp.server.test.run')).toBeNull();
        expect(screen.findByTestId('settings.mcpServers.administration.target')).toBeNull();
        expect(screen.findAllByProps({ testIDPrefix: 'settings.mcpServers.administration.target' })).toHaveLength(0);
        expect(screen.find((node) => node.props?.testID === 'mcp.server.editor.header' && typeof node.props?.primaryAction === 'object')
            .props.primaryAction.testID).toBe('mcp.server.editor.save');
    });

    it('titles a new server with the placeholder until the user names it', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen({ observeDraftTitle: true });
        expect(screen.find((node) => node.props?.testID === 'mcp.server.editor.header' && typeof node.props?.title === 'string').props.title)
            .toBe('mcpSettings.newServer');
        expect(screen.findByTestId('mcp.server.editor.published-title')?.props.title).toBe('');

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'playwright');
        });
        expect(screen.find((node) => node.props?.testID === 'mcp.server.editor.header' && typeof node.props?.title === 'string').props.title)
            .toBe('playwright');
        expect(screen.findByTestId('mcp.server.editor.published-title')?.props.title).toBe('playwright');
    });

    it('writes admitted known fields canonically without persisting unsupported catalog extras', async () => {
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [{
                id: 'server-1',
                name: 'hard-drives',
                transport: 'stdio',
                stdio: { command: 'node', args: ['server.js'] },
                env: {},
                createdAt: 1,
                updatedAt: 1,
            }],
            bindings: [],
            futureV2: { retained: true },
        };

        const screen = await renderEditorScreen();
        await typeConfig(screen, 'mcp.server.editor.command', 'bun');
        await leaveConfig(screen, 'mcp.server.editor.command');

        await vi.waitFor(() => expect(setMcpSettingsSpy).toHaveBeenCalled());
        expect(setMcpSettingsSpy.mock.calls.at(-1)?.[0]).toMatchObject({ servers: [{ name: 'hard-drives', stdio: { command: 'bun' } }] });
        expect(setMcpSettingsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('futureV2');
        expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
    });

    it('preserves a new server draft when unrelated secrets settings change', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'qa_remote_http_20260306');
        });

        await act(async () => {
            screen.pressByTestId('mcp.server.transport:http');
        });

        await typeConfig(screen, 'mcp.server.editor.url', 'http://127.0.0.1:63254/mcp');
        await leaveConfig(screen, 'mcp.server.editor.url');

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_remote_http_auth_livefix_20260306',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'qa-remote-auth-1772754949' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        expect(screen.findByTestId('mcp.server.editor.name')?.props.value).toBe('qa_remote_http_20260306');
        expect(configField(screen, 'mcp.server.editor.url').props.value).toBe('http://127.0.0.1:63254/mcp');
        expect(screen.find((node) => node.props.testIDPrefix === 'mcp.server.transport'
            && typeof node.props.onSelectTab === 'function').props.activeTabId).toBe('http');
    });

    it('keeps the chosen place local until the server is saved, then creates the server on it', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            await screen.find((node) => node.props.kind === 'mcp_server' && typeof node.props.onChange === 'function')
                .props.onChange({ kind: 'replace', rules: [{ target: { t: 'machine', machineId: 'machine-1' }, enabled: true }] });
        });
        expect(rowMutationRequests).toHaveLength(0);
        await typeConfig(screen, 'mcp.server.editor.command', 'machine-server');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await act(async () => { screen.pressByTestId('mcp.server.editor.save'); });
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        expect(rowMutationRequests[0]?.content).toMatchObject({ t: 'plain', v: {
            servers: [{ id: 'uuid', stdio: { command: 'machine-server' } }],
            bindings: [{ serverId: 'uuid', enabled: true, target: { t: 'machine', machineId: 'machine-1' } }],
        } });
    });

    it('creates a custom server with a variable selected from the real Saved Secret picker', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen({ machineDifferenceModal: true });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/account/settings/personalSavedSecretActionsV1');
        const created = await createDefaultActionExecutor().execute('secrets.create', {
            name: 'Notebook access', value: 'synthetic-private-value',
        }, { surface: 'ui', authority: 'present_user', serverId: accountScope!.serverId, expectedAccountId: accountScope!.accountId });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.errorCode);
        const { secretRef } = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(created.result);
        const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        await act(async () => { await refreshSavedSecretCatalog(accountScope!); });
        await typeConfig(screen, 'mcp.server.editor.command', 'echo');
        await leaveConfig(screen, 'mcp.server.editor.command');
        await screen.pressByTestIdAsync('mcp.server.env.add');
        await act(async () => { screen.changeTextByTestId('mcp.server.env.row.new.name', 'API_KEY'); });
        const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
        await act(async () => {
            screen.findAllByType(ValueFieldSelect).find(node => node.props.testID === 'mcp.server.env.row.new.type')!.props.onSelect('savedSecret');
        });
        await vi.waitFor(() => expect(screen.findByTestId(`saved-secret:${secretRef}`)).not.toBeNull());
        await screen.pressByTestIdAsync(`saved-secret:${secretRef}`);
        await screen.pressByTestIdAsync('mcp.server.editor.save');
        await vi.waitFor(() => expect(rowMutationRequests).toHaveLength(1));
        const persisted = McpServersSettingsV1Schema.parse(liveMcpSettings);
        expect(persisted.servers[0]?.env.API_KEY).toEqual({ t: 'savedSecret', secretId: secretRef });
        expect(JSON.stringify(rowMutationRequests).includes('synthetic-private-value')).toBe(false);
        expect(rowMutationRequests[0]?.savedSecretRevisions).toHaveLength(1);
        expect(routerReplaceSpy).toHaveBeenCalledWith(mcpServerRoute(persisted.servers[0]!.id));
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
