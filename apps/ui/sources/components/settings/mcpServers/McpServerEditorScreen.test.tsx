import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';

import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit/render/renderScreen';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeId, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { useMachineAdministrationTargetSelection, resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { renderHook } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretPromoteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { buildApprovalRequestArtifactHeaderV1, StoredApprovalRequestSchema, type ApprovalRequestV2 } from '@happier-dev/protocol';
import { createArtifactStoreBoundary, type ArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setMcpSettingsSpy = vi.fn();
const settingsHttpWriteSpy = vi.fn();
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
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

// The shared presentation harness registers a store stub. Load it only after
// the real domain imports above, then retire that stub before importing Sync.
const {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} = await import('./mcpServersTestHelpers');

const mcpServersCommonModuleMockOptions = {
    // The default text mock serializes parameters (`key(name=value)`), so copy can be checked for what it names.
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
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

        return {
            ...routerMock.module,
            useLocalSearchParams: () => mcpServersModuleState.routerSearchParams,
            useGlobalSearchParams: () => mcpServersModuleState.routerSearchParams,
        };
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
const { resetMcpServerCatalogEngineForTests, refreshMcpServerCatalog } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { resetSavedSecretCatalogEngineForTests } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const { resetSavedSecretCatalogSnapshotsForTests } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');

// These neighboring presentation hosts do not supply draft values, target
// resolution, validation, policy or results. Configure/import/quick-install
// forms and the Administration/Action/row/Artifact owners below stay real.
// This suite makes no whole-widget or accessibility rendering claim.
vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: (props: any) =>
        React.createElement('InlineAddExpander', props, props.isOpen ? props.children : null),
}));

vi.mock('@/components/settings/mcpServers/McpServerBindingEditor', () => ({
    McpServerBindingEditor: () => React.createElement('McpServerBindingEditor'),
}));

vi.mock('@/components/settings/mcpServers/McpServerTestPanel', () => ({
    McpServerTestPanel: () => React.createElement('McpServerTestPanel'),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: any) => React.createElement('MachineAdministrationTargetSelector', props),
}));

vi.mock('@/components/settings/mcpServers/McpValueRefMapEditor', () => ({
    McpValueRefMapEditor: () => React.createElement('McpValueRefMapEditor'),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => ++uuidBoundary.sequence === 1 ? 'uuid' : `uuid-${uuidBoundary.sequence}`,
}));

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return {
        ...actual,
        Typography: {
            ...actual.Typography,
            default: () => ({}),
        },
    };
});

/** The draft rule's target select (the page header also holds a `⋯` menu). */
function findBindingTargetDropdown(screen: Awaited<ReturnType<typeof renderEditorScreen>>) {
    return screen.findAllByType('DropdownMenu')
        .find((dropdown) => dropdown.props.itemTrigger?.title === 'settings.mcpServersBindingTarget')!;
}

async function renderEditorScreen(options: Readonly<{ activeAccount?: boolean; ask?: boolean;
    mcpUpdatePolicy?: 'disabled' | 'ask' }> = {}) {
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
        });
    });
    const machines = liveMachines.map(machine => createMachineFixture({ id: machine.id,
        activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, ...machine.metadata } }));
    let settingsVersion = 7;
    let rawSettings: Record<string, unknown> = { userNote: 'unrelated', actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: {
            ...(options.ask ? { 'secrets.shared.promote': { approvalRequiredSurfaces: ['ui'] } } : {}),
            ...(options.mcpUpdatePolicy === 'disabled' ? { 'mcp.servers.update': { disabledSurfaces: ['ui'] } } : {}),
            ...(options.mcpUpdatePolicy === 'ask' ? { 'mcp.servers.update': { approvalRequiredSurfaces: ['ui'] } } : {}),
        }, approvalWaivedSurfaces: {
            ...(!options.ask ? { 'secrets.shared.promote': ['ui'], 'secrets.shared.create': ['ui'] } : {}),
            'mcp.servers.create': ['ui'], 'mcp.servers.delete': ['ui'],
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
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
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
                return Response.json({ status: 'updated', revision: catalogRevision, cursor: catalogRevision });
            }
            if (!liveMcpSettings || typeof liveMcpSettings !== 'object' || Array.isArray(liveMcpSettings)) {
                return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: liveMcpSettings } });
            }
            const { strictMode: _strictMode, ...catalog } = liveMcpSettings as Record<string, unknown>;
            return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } });
        }
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
    const { McpServerEditorScreen } = await import('./McpServerEditorScreen');
    const screen = await renderScreen(React.createElement(McpServerEditorScreen));
    await act(async () => { await refreshMcpServerCatalog(accountScope!); });
    return screen;
}

afterEach(async () => {
    releaseRowMutation?.();
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
    installMcpServersCommonModuleMocks(mcpServersCommonModuleMockOptions);
    // Sync restoration must see the real store domains, not the shared UI
    // harness's presentation-only stub.
    vi.doUnmock('@/sync/domains/state/storage');
    disposeActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    // Exercise the real button action owner; a synthetic host drops PageHeader's async action.
    vi.doUnmock('@/components/ui/buttons/RoundButton');
    mcpServersModuleState.routerSearchParams = { serverId: 'server-1' };
});

describe('McpServerEditorScreen', () => {
    it('keeps a new draft open and dirty until its destination CAS is acknowledged', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen();
        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'awaiting-ack');
            screen.changeTextByTestId('mcp.server.editor.commandLine', 'mcp-server');
        });
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
        await act(async () => { screen.changeTextByTestId('mcp.server.editor.name', 'disabled-policy-draft'); });
        act(() => { screen.pressByTestId('mcp.server.editor.save'); });
        await vi.waitFor(() => expect(rowMutationRequests.length + modalAlertSpy.mock.calls.length
            + routerReplaceSpy.mock.calls.length).toBeGreaterThan(0));
        expect(rowMutationRequests).toHaveLength(0);
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'action_disabled');
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('mcp.server.editor.name').props.value).toBe('disabled-policy-draft');
        expect(navigationPreventRemove.enabled).toBe(true);
    });

    it('keeps an ordinary MCP editor Save under its original update Action approval without replay', async () => {
        mcpServersModuleState.routerSearchParams = { serverId: 'server-1' };
        const screen = await renderEditorScreen({ activeAccount: true, mcpUpdatePolicy: 'ask' });
        await act(async () => { screen.changeTextByTestId('mcp.server.editor.name', 'approved-policy-draft'); });
        act(() => { screen.pressByTestId('mcp.server.editor.save'); });
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
        expect(request.actionArgs).toMatchObject({ expectedRevision: 3, entry: { id: 'server-1', name: 'approved-policy-draft' } });
        // The real Inbox decision executes the captured Action against this
        // HTTP row and publishes its genuine durable approval receipt.
        expect(await decideApprovalAsInbox(accountScope!.serverId, artifact.id, 'approve')).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(navigationPreventRemove.enabled).toBe(false));
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('mcp.server.editor.name').props.value).toBe('approved-policy-draft');
        expect(approvalArtifacts!.list()).toHaveLength(1);
        expect(rowMutationRequests).toHaveLength(1);
        expect(rowMutationRequests[0]?.expectedRevision).toBe(3);
        expect(catalogRevision).toBe(4);
    });

    it('preserves the dirty draft and captured base when another writer moves the destination', async () => {
        const screen = await renderEditorScreen();
        await act(async () => { screen.changeTextByTestId('mcp.server.editor.name', 'local-draft'); });
        liveMcpSettings = { v: 1, strictMode: false, servers: [{ id: 'server-1', name: 'remote-edit', transport: 'stdio',
            stdio: { command: 'node', args: ['server.js'] }, env: {}, createdAt: 1, updatedAt: 2 }], bindings: [] };
        catalogRevision = 4;
        await act(async () => { await refreshMcpServerCatalog(accountScope!); });
        expect(screen.findByTestId('mcp.server.editor.name').props.value).toBe('local-draft');
        act(() => { screen.pressByTestId('mcp.server.editor.save'); });
        await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalled());
        // The canonical Action owner observes the moved revision before row CAS.
        expect(rowMutationRequests).toHaveLength(0);
        expect(screen.findByTestId('mcp.server.editor.name').props.value).toBe('local-draft');
        expect(navigationPreventRemove.enabled).toBe(true);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
    });

    it('replaces to the MCP servers settings screen when cancelling quick install even if a back stack exists', async () => {
        navigationCanGoBack = true;

        Object.defineProperty(globalThis, 'location', {
            value: { href: 'http://localhost/settings/mcp-server?addMode=quick-install', pathname: '/settings/mcp-server' },
            writable: true,
            configurable: true,
        });
        Object.defineProperty(globalThis, 'history', {
            value: { back: vi.fn() },
            writable: true,
            configurable: true,
        });

        mcpServersModuleState.routerSearchParams = { addMode: 'quick-install', presetId: 'sequential-thinking' };
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };

        const screen = await renderEditorScreen();
        vi.useFakeTimers();

        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.cancel');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp');

        vi.useRealTimers();
    });

    it('prompts to discard unsaved changes when navigating away via the navigation back action', async () => {
        const screen = await renderEditorScreen();

        // Save lives in the page header and is offered only once there is something to save.
        expect(screen.findByTestId('mcp.server.editor.save')?.props.disabled).toBe(true);

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

    it('saves the draft before completing navigation when the user chooses save in the unsaved-changes prompt', async () => {
        unsavedChangesDecision = 'save';

        const screen = await renderEditorScreen();

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
            servers: [{ id: 'server-1', name: 'server_edited' }],
        } });
    });

    it('falls back to the MCP settings screen after delete when there is no back stack entry', async () => {
        const screen = await renderEditorScreen();

        // Delete is the rare operation in the header's ⋯ menu.
        await act(async () => {
            screen.find((node) => node.props?.testID === 'mcp.server.editor.menu' && typeof node.props?.onSelect === 'function')
                .props.onSelect('delete');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp'));
        expect(rowMutationRequests).toHaveLength(1);
        expect(rowMutationRequests[0]?.content).toEqual({ t: 'plain', v: {
            v: 1, servers: [], bindings: [],
        } });
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('confirms deleting the saved server by the name the collection shows, not an unsaved edit', async () => {
        // This case observes the translation's name argument. The shared cold
        // module graph can already have installed the key-only text boundary.
        const text = await import('@/text');
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const textBoundary = createTextModuleMock();
        const translate = vi.spyOn(text, 't').mockImplementation((key, params) => String(textBoundary.t(key, params)));
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
            await act(async () => {
                screen.changeTextByTestId('mcp.server.editor.name', 'github_renamed_unsaved');
            });
            await act(async () => {
                screen.find((node) => node.props?.testID === 'mcp.server.editor.menu' && typeof node.props?.onSelect === 'function')
                    .props.onSelect('delete');
                await flushHookEffects({ cycles: 1, turns: 1 });
            });

            expect(modalConfirmSpy).toHaveBeenCalledWith(
                'settings.mcpServersDeleteTitle',
                expect.stringContaining('GitHub tools'),
                expect.anything(),
            );
            expect(modalConfirmSpy.mock.calls.at(-1)?.[1]).not.toContain('github_renamed_unsaved');
        } finally { translate.mockRestore(); }
    });

    it('titles a new server with the placeholder until the user names it', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const { mcpServerDraftTitle } = await import('./collection/mcpServerCollectionModel');
        const published: string[] = [];
        const originalPublish = mcpServerDraftTitle.publish;
        const publishSpy = vi.spyOn(mcpServerDraftTitle, 'publish').mockImplementation((title) => {
            published.push(title);
            originalPublish(title);
        });

        const screen = await renderEditorScreen();
        expect(screen.find((node) => node.props?.testID === 'mcp.server.editor.header' && typeof node.props?.title === 'string').props.title)
            .toBe('mcpSettings.newServer');
        expect(published.at(-1)).toBe('');

        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'playwright');
        });
        expect(screen.find((node) => node.props?.testID === 'mcp.server.editor.header' && typeof node.props?.title === 'string').props.title)
            .toBe('playwright');
        expect(published.at(-1)).toBe('playwright');
        publishSpy.mockRestore();
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
        await act(async () => {
            screen.changeTextByTestId('mcp.server.editor.name', 'hard-drives-updated');
        });
        await act(async () => {
            screen.pressByTestId('mcp.server.editor.save');
        });

        await vi.waitFor(() => expect(setMcpSettingsSpy).toHaveBeenCalled());
        expect(setMcpSettingsSpy.mock.calls.at(-1)?.[0]).toMatchObject({ servers: [{ name: 'hard-drives-updated' }] });
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

        const transportTabs = screen.findAllByType('SegmentedTabBar')[1];
        expect(transportTabs).toBeTruthy();
        await act(async () => {
            transportTabs?.props.onSelectTab?.('http');
        });

        await act(async () => {
            screen.findByProps({ placeholder: 'https://example.com/mcp' }).props.onChangeText?.('http://127.0.0.1:63254/mcp');
        });

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
        expect(screen.findByProps({ placeholder: 'https://example.com/mcp' })?.props.value).toBe('http://127.0.0.1:63254/mcp');
        expect(screen.findAllByType('SegmentedTabBar')[1]?.props.activeTabId).toBe('http');
    });

    it('shows configure/import-json/quick-install add-flow tabs for new servers', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        const addFlowTabs = screen.findAllByType('SegmentedTabBar')[0];
        expect(addFlowTabs).toBeTruthy();
        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('importJson');
        });
        expect(screen.findByTestId('mcp.server.importJson.input')).toBeTruthy();

        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('quickInstall');
        });
        expect(screen.findByTestId('mcp.server.quickInstall.preset.github')).toBeTruthy();
    });

    it('disables JSON import when a saved-secret mapping is missing a value', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        const addFlowTabs = screen.findAllByType('SegmentedTabBar')[0];
        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('importJson');
        });

        await act(async () => {
            screen.changeTextByTestId('mcp.server.importJson.input', `{
                "mcp": {
                    "inputs": {
                        "github_token": {
                            "type": "promptString",
                            "password": true
                        }
                    },
                    "servers": {
                        "github": {
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-github"],
                            "env": {
                                "GITHUB_TOKEN": "\${input:github_token}"
                            }
                        }
                    }
                }
            }`);
        });

        expect(screen.findByTestId('mcp.server.importJson.import')?.props.disabled).toBe(true);
    });

    it('saves an imported credential and its MCP binding in one transaction without a standalone Settings write', async () => {
        mcpServersModuleState.routerSearchParams = { addMode: 'import-json' };
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen({ activeAccount: true });
        await act(async () => {
            screen.changeTextByTestId('mcp.server.importJson.input', JSON.stringify({ mcp: {
                inputs: { github_token: { type: 'promptString', password: true } },
                servers: { github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${input:github_token}' } } },
            } }));
        });
        const valueField = screen.findAllByType('TextInput').find(input => input.props.secureTextEntry === true);
        expect(valueField).toBeTruthy();
        await act(async () => { valueField!.props.onChangeText('imported-credential-value'); });
        expect(screen.findByTestId('mcp.server.importJson.import').props.disabled).toBe(false);
        modalAlertSpy.mockClear();
        await act(async () => { screen.pressByTestId('mcp.server.importJson.import'); });
        // A refused incumbent save is also a completed observable outcome; it
        // must not turn this defining compound-write assertion into a setup timeout.
        await vi.waitFor(() => expect(settingsHttpWriteSpy.mock.calls.length + standaloneResourceMutationRequests.length
            + compoundMutationRequests.length + modalAlertSpy.mock.calls.length).toBeGreaterThan(0));
        expect(compoundMutationRequests).toHaveLength(1);
        expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
        expect(standaloneResourceMutationRequests).toHaveLength(0);
        expect(rowMutationRequests).toHaveLength(0);
        const input = compoundMutationRequests[0]!;
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input.catalogMutations?.mcp);
        expect(input).toMatchObject({ nextSettings: null, profileMutations: [],
            referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: { mcp: 3 } } });
        expect(input).not.toHaveProperty('expectedSettingsVersion');
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain MCP compound content');
        expect(mutation.content.v.servers[0]?.env.GITHUB_TOKEN).toEqual({ t: 'savedSecret', secretId: `happier:shared-secret:v1:${input.resourceId}` });
        expect(mutation).toMatchObject({ expectedRevision: 3,
            savedSecretRevisions: [{ resourceId: input.resourceId, expectedRevision: 1 }] });
    });

    it('awaits one compound acknowledgement for quick-install credential and selected servers', async () => {
        mcpServersModuleState.routerSearchParams = { addMode: 'quick-install' };
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen({ activeAccount: true });
        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.preset.github');
            screen.pressByTestId('mcp.server.quickInstall.preset.sequential-thinking');
        });
        const valueField = screen.findAllByType('TextInput').find(input => input.props.secureTextEntry === true);
        expect(valueField).toBeTruthy();
        await act(async () => { valueField!.props.onChangeText('quick-install-credential'); });
        rowMutationGate = new Promise(resolve => { releaseRowMutation = resolve; });
        modalAlertSpy.mockClear();
        act(() => { screen.pressByTestId('mcp.server.quickInstall.install'); });
        await vi.waitFor(() => expect(compoundMutationRequests).toHaveLength(1));
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
        expect(standaloneResourceMutationRequests).toHaveLength(0);
        expect(rowMutationRequests).toHaveLength(0);
        const input = compoundMutationRequests[0]!;
        const mutation = McpServerCatalogRowMutationV1Schema.parse(input.catalogMutations?.mcp);
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain quick-install catalog');
        expect(mutation.content.v.servers.map(server => server.name).sort()).toEqual(['github', 'sequential_thinking']);
        expect(mutation.content.v.servers.find(server => server.name === 'github')?.env.GITHUB_TOKEN).toEqual({
            t: 'savedSecret', secretId: `happier:shared-secret:v1:${input.resourceId}`,
        });
        releaseRowMutation!();
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp'));
        expect(compoundMutationRequests).toHaveLength(1);
    });

    it('keeps an imported credential Save pending and consumes its original deferred approval without replay', async () => {
        let phase = 'mount Ask-enabled editor';
        onTestFailed(async () => {
            const { storage } = await import('@/sync/domains/state/storageStore');
            console.error('Deferred MCP import approval phase:', phase, {
            artifacts: approvalArtifacts?.list().length ?? 0,
            compoundWrites: compoundMutationRequests.length,
            alerts: modalAlertSpy.mock.calls,
            navigations: routerReplaceSpy.mock.calls,
            settingsScope: storage.getState().settingsScope,
            settingsVersion: storage.getState().settingsVersion,
            syncStatus: storage.getState().accountSettingsSyncStatus,
        }); });
        mcpServersModuleState.routerSearchParams = { addMode: 'import-json' };
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen({ activeAccount: true, ask: true });
        phase = 'author JSON import and credential';
        await act(async () => {
            screen.changeTextByTestId('mcp.server.importJson.input', JSON.stringify({ mcp: {
                inputs: { github_token: { type: 'promptString', password: true } },
                servers: { github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${input:github_token}' } } },
            } }));
        });
        const valueField = screen.findAllByType('TextInput').find(input => input.props.secureTextEntry === true)!;
        await act(async () => { valueField.props.onChangeText('deferred-import-value'); });
        phase = 'submit original Save and wait for approval Artifact';
        act(() => { screen.pressByTestId('mcp.server.importJson.import'); });
        await vi.waitFor(() => expect(approvalArtifacts!.list()).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findByTestId('mcp.server.editor.approval')).toBeTruthy());
        expect(screen.findByTestId('mcp.server.importJson.import').props.disabled).toBe(true);
        phase = 'inspect pending Artifact';
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(compoundMutationRequests).toHaveLength(0);
        expect(standaloneResourceMutationRequests).toHaveLength(0);
        expect(rowMutationRequests).toHaveLength(0);
        const artifact = approvalArtifacts!.list()[0]!;
        const request = StoredApprovalRequestSchema.parse(JSON.parse(approvalArtifacts!.readPlainBody(artifact.id)!));
        if (request.v !== 2 || !request.actionArgs || typeof request.actionArgs !== 'object') throw new Error('Expected original compound approval');
        const resourceId = Reflect.get(request.actionArgs, 'resourceId');
        if (typeof resourceId !== 'string') throw new Error('Expected original pending resource identity');
        const settledAt = request.createdAtMs + 1;
        const settled: ApprovalRequestV2 = { ...request, status: 'executed', updatedAtMs: settledAt,
            decision: { kind: 'approve', decidedAtMs: settledAt },
            execution: { ok: true, executedAtMs: settledAt, result: { resourceId, settingsVersion: 7 } } };
        // Model the Home's terminal Artifact observation, not a direct call into
        // the pending registration. The actual mounted reader must deliver it.
        const { storage } = await import('@/sync/domains/state/storageStore');
        phase = 'publish Home terminal approval observation';
        await act(async () => { storage.getState().updateArtifact({ id: artifact.id,
            header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled),
            title: null, headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1,
            seq: artifact.seq + 1, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt + 1, isDecrypted: true }); });
        phase = 'await mounted continuation completion';
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/mcp'));
        expect(approvalArtifacts!.list()).toHaveLength(1);
        expect(compoundMutationRequests).toHaveLength(0);
        expect(standaloneResourceMutationRequests).toHaveLength(0);
        expect(rowMutationRequests).toHaveLength(0);
        expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
    });

    it('retains an imported credential draft after an unknown commit and verifies without replaying Save', async () => {
        mcpServersModuleState.routerSearchParams = { addMode: 'import-json' };
        liveMcpSettings = { v: 1, strictMode: false, servers: [], bindings: [] };
        const screen = await renderEditorScreen({ activeAccount: true });
        const source = JSON.stringify({ mcp: {
            inputs: { github_token: { type: 'promptString', password: true } },
            servers: { github: { command: 'github-mcp', env: { GITHUB_TOKEN: '${input:github_token}' } } },
        } });
        await act(async () => { screen.changeTextByTestId('mcp.server.importJson.input', source); });
        const valueField = screen.findAllByType('TextInput').find(input => input.props.secureTextEntry === true);
        expect(valueField).toBeTruthy();
        await act(async () => { valueField!.props.onChangeText('unknown-import-value'); });
        loseCompoundAcknowledgement = true;
        modalAlertSpy.mockClear();
        act(() => { screen.pressByTestId('mcp.server.importJson.import'); });
        await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'outcome_unknown'));
        expect(compoundMutationRequests).toHaveLength(1);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('mcp.server.importJson.input').props.value).toBe(source);
        expect(screen.findAllByType('TextInput').find(input => input.props.secureTextEntry === true)?.props.value).toBe('unknown-import-value');
        // The resource material boundary intentionally cannot prove the lost
        // commit. A second click must use the original read-only continuation.
        modalAlertSpy.mockClear();
        act(() => { screen.pressByTestId('mcp.server.importJson.import'); });
        await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'outcome_unknown'));
        expect(compoundMutationRequests).toHaveLength(1);
        expect(standaloneResourceMutationRequests).toHaveLength(0);
        expect(rowMutationRequests).toHaveLength(0);
        expect(settingsHttpWriteSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('allows selecting multiple quick-install presets while preserving required-auth validation', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        const addFlowTabs = screen.findAllByType('SegmentedTabBar')[0];
        await act(async () => {
            addFlowTabs?.props.onSelectTab?.('quickInstall');
        });

        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.preset.github');
        });

        await act(async () => {
            screen.pressByTestId('mcp.server.quickInstall.preset.sequential-thinking');
        });

        expect(screen.findByTestId('mcp.server.quickInstall.preset.github')?.props.selected).toBe(true);
        expect(screen.findByTestId('mcp.server.quickInstall.preset.sequential-thinking')?.props.selected).toBe(true);
        expect(screen.findByTestId('mcp.server.quickInstall.install')?.props.disabled).toBe(true);
    });

    it('opens add binding as a draft expander instead of creating a binding immediately', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        expect(screen.findAllByType('McpServerBindingEditor')).toHaveLength(0);

        const addBindingExpander = screen.findByType('InlineAddExpander');
        expect(addBindingExpander).toBeTruthy();
        expect(addBindingExpander.props.title).toBe('settings.mcpServersAddApplyRule');
        expect(addBindingExpander.props.isOpen).toBe(false);

        await act(async () => {
            addBindingExpander.props.onOpenChange?.(true);
        });

        const addBindingExpanderAfterOpen = screen.findByType('InlineAddExpander');
        expect(screen.findAllByType('McpServerBindingEditor')).toHaveLength(0);
        expect(addBindingExpanderAfterOpen?.props.isOpen).toBe(true);
    });

    it('keeps a draft binding on all machines when no machine-scoped target can be selected', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMachines = [];
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.findByType('InlineAddExpander').props.onOpenChange?.(true);
        });

        expect(screen.findAllByProps({ title: 'settings.mcpServersBindingMachine' })).toHaveLength(0);
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'settings.mcpServersBindingTargetAllMachines')).toBeTruthy();

        await act(async () => {
            findBindingTargetDropdown(screen).props.onSelect?.('machine');
        });

        expect(screen.findAllByProps({ title: 'settings.mcpServersBindingMachine' })).toHaveLength(0);
        expect(screen.findAllByType('McpServerBindingEditor')).toHaveLength(0);
    });

    it('updates the binding target scope from the draft editor', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.findByType('InlineAddExpander').props.onOpenChange?.(true);
        });
        await act(async () => {
            findBindingTargetDropdown(screen).props.onSelect?.('allMachines');
        });

        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'settings.mcpServersBindingTargetAllMachines')).toBeTruthy();
    });

    it('shows a validation alert when no machine is selected for the add binding draft', async () => {
        mcpServersModuleState.routerSearchParams = {};
        liveMachines = [];
        liveMcpSettings = {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
        };

        const screen = await renderEditorScreen();

        await act(async () => {
            screen.findByType('InlineAddExpander').props.onOpenChange?.(true);
        });
        await act(async () => {
            findBindingTargetDropdown(screen).props.onSelect?.('allMachines');
        });

        await act(async () => {
            findBindingTargetDropdown(screen).props.onSelect?.('machine');
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'settings.mcpServersNoMachineSelected');
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'settings.mcpServersBindingTargetAllMachines')).toBeTruthy();
        expect(screen.findAllByProps({ title: 'settings.mcpServersBindingMachine' })).toHaveLength(0);
    });
});
