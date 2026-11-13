import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { FilesystemCreateDirectoryInputSchema, FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import {
    DaemonFilesystemListDirectoryRequestSchema,
    type DaemonFilesystemListRootsResponse} from '@happier-dev/protocol/machines/fileBrowser';
import {
    DaemonWorkspaceFileListRequestSchema,
    type DaemonWorkspaceFileListResponse,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

import {
    getPathBrowserRowTestId,
    getPathBrowserToggleTestId,
    PATH_BROWSER_CONFIRM_TEST_ID,
    PATH_BROWSER_CREATE_FOLDER_TEST_ID,
    PATH_BROWSER_MODAL_TEST_ID,
    PATH_BROWSER_ROOT_ERROR_TEST_ID,
} from './pathBrowserTestIds';
import { flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import type { CustomModalChromeConfig, CustomModalInjectedProps } from '@/modal/types';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Hosts the card chrome a modal browser publishes, as `CustomModal` does: the band's action, the
 * body, then the footer. The browser never draws a header of its own.
 */
function ChromeHost(props: Readonly<{ children: React.ReactElement<CustomModalInjectedProps> }>) {
    const [chrome, setChrome] = React.useState<CustomModalChromeConfig | null>(null);
    if (chrome && chrome.kind !== 'card') throw new Error('Expected path browser card chrome');
    return React.createElement(
        'ChromeHost',
        { testID: chrome?.testID, title: chrome?.title, subtitle: chrome?.subtitle },
        // The card draws a node subtitle under the title, as `CustomModal` does.
        React.isValidElement(chrome?.subtitle) ? chrome.subtitle : null,
        chrome?.actions,
        React.cloneElement(props.children, { setChrome }),
        chrome?.footer,
    );
}

function renderInModalChrome(element: React.ReactElement<CustomModalInjectedProps>) {
    return renderScreen(React.createElement(ChromeHost, null, element));
}

async function waitForTestId(screen: ReturnType<typeof renderScreen> extends Promise<infer Result> ? Result : never, testID: string) {
    for (let index = 0; index < 8; index += 1) {
        const target = screen.findByTestId(testID);
        if (target) {
            return target;
        }
        await flushHookEffects({ cycles: 1, turns: 1 });
    }
    const target = screen.findByTestId(testID);
    if (!target) throw new Error(`Expected test ID ${testID} to render`);
    return target;
}

const listMachineFileBrowserRootsMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<DaemonFilesystemListRootsResponse>>(async () => ({
    ok: true as const,
    roots: [{ id: '/', label: '/', path: '/' }],
})));
const listMachineFileBrowserDirectoryEntriesMock = vi.hoisted(() => vi.fn<(params: {
    directoryPath: string;
    includeFiles?: boolean;
    machineId?: string;
    serverId?: string | null;
}) => Promise<{
    ok: true;
    entries: Array<{ name: string; path: string; type: 'directory' | 'file' }>;
    truncated: boolean;
} | { ok: false; error: string; errorCode?: string }>>(async (params: { directoryPath: string }) => {
    if (params.directoryPath === '/') {
        return {
            ok: true as const,
            entries: [{ name: 'Users', path: '/Users', type: 'directory' as const }],
            truncated: false,
        };
    }
    if (params.directoryPath === '/Users') {
        return {
            ok: true as const,
            entries: [{ name: 'leeroy', path: '/Users/leeroy', type: 'directory' as const }],
            truncated: false,
        };
    }
    return {
        ok: true as const,
        entries: [],
        truncated: false,
    };
}));
const flatListScrollToIndexMock = vi.hoisted(() => vi.fn());
const machineCreateDirectoryMock = vi.hoisted(() => vi.fn<(machineId: string, path: string, options?: unknown) => Promise<{ success: true } | { success: false; error: string }>>(
    async () => ({ success: true as const }),
));
const machineWorkspaceFileListMock = vi.hoisted(() => vi.fn<(machineId: string, input: Readonly<{ rootPath: string; query?: string; includeHidden?: boolean }>, options?: unknown) => Promise<DaemonWorkspaceFileListResponse>>(async () => ({
    ok: true,
    paths: [],
    truncated: false,
})));
const modalPromptMock = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<string | null>>(async () => null));
const modalAlertMock = vi.hoisted(() => vi.fn());
const itemRenderCounts = vi.hoisted(() => new Map<string, number>());
// Platform.OS is read at render time; a test may switch to iOS for a native-only contract.
const platformOS = vi.hoisted(() => ({ current: 'web' as 'web' | 'ios' }));

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({
        original: await importOriginal<typeof import('@legendapp/list/react-native')>(),
        renderItems: true,
        refHandle: {
            scrollToIndex: flatListScrollToIndexMock,
            scrollToOffset: vi.fn(),
        },
    }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        useWindowDimensions: () => ({
            width: 1280,
            height: 900,
            scale: 1,
            fontScale: 1,
        }),
        FlatList: React.forwardRef(({ data, renderItem, ListHeaderComponent, contentContainerStyle, onScrollToIndexFailed }: any, ref) => {
            React.useImperativeHandle(ref, () => ({
                scrollToIndex: flatListScrollToIndexMock,
                scrollToOffset: vi.fn(),
            }));
            return React.createElement(
                'FlatList',
                { contentContainerStyle, onScrollToIndexFailed },
                [
                    React.createElement(React.Fragment, { key: 'header' }, ListHeaderComponent ?? null),
                    ...(data ?? []).map((item: any, index: number) =>
                        React.createElement(React.Fragment, { key: `${item.type}:${item.path}:${index}` }, renderItem({ item, index }))),
                ],
            );
        }),
        Platform: {
            get OS() {
                return platformOS.current;
            },
            select: (options: { ios?: unknown; native?: unknown; web?: unknown; default?: unknown }) => platformOS.current === 'ios'
                ? options.ios ?? options.native ?? options.default
                : options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, vars?: Record<string, unknown>) => typeof vars?.count === 'number' ? `${key}:${vars.count}` : key,
    });
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// Observe render passes of the shared tree row without replacing it: the real row still renders.
vi.mock('@happier-dev/plugin-ui/presentation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/plugin-ui/presentation')>();
    return {
        ...actual,
        HappierTreeRow: (props: React.ComponentProps<typeof actual.HappierTreeRow>) => {
            if (typeof props.testID === 'string') {
                itemRenderCounts.set(props.testID, (itemRenderCounts.get(props.testID) ?? 0) + 1);
            }
            return React.createElement(actual.HappierTreeRow, props);
        },
    };
});

// Radix's DOM focus/listener boundary has no real DOM in the mounted renderer.
vi.mock('@/utils/web/radixCjs', async importOriginal => {
    const actual = await importOriginal<typeof import('@/utils/web/radixCjs')>();
    const Inline = (props: React.PropsWithChildren) => props.children;
    return { ...actual, requireRadixDismissableLayer: () => ({ Root: Inline, Branch: Inline }),
        requireRadixFocusScope: () => ({ Root: Inline }) };
});

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Only the external daemon ACK is replaced. Credential custody, guarded RPC
// policy, scope capture, filesystem parsers and caches all execute for real.
const machineRequests = installSessionActionRpcBoundary(async (request, context) => {
        const home = context.serverUrl && homes.findByServerUrl(context.serverUrl.replace(/\/+$/, ''));
        if (!home) throw new Error('Unexpected path-browser Home');
        const separator = request.method.indexOf(':');
        const machineId = request.method.slice(0, separator);
        const method = request.method.slice(separator + 1);
        const options = { serverId: home.serverId, accountId: 'target-account', signal: context.signal };
        switch (method) {
            case 'daemon.filesystem.createDirectory': {
                const payload = FilesystemCreateDirectoryInputSchema.parse(request.params);
                return machineCreateDirectoryMock(machineId, payload.path, options);
            }
            case RPC_METHODS.CREATE_DIRECTORY: {
                const payload = request.params;
                if (!payload || typeof payload !== 'object' || !('path' in payload) || typeof payload.path !== 'string') {
                    throw new Error('Malformed create-directory request');
                }
                return machineCreateDirectoryMock(machineId, payload.path, options);
            }
            case RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST:
                return machineWorkspaceFileListMock(
                    machineId,
                    DaemonWorkspaceFileListRequestSchema.parse(request.params),
                    options,
                );
            case RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS:
                return listMachineFileBrowserRootsMock({ machineId, serverId: home.serverId });
            case RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY: {
                const payload = DaemonFilesystemListDirectoryRequestSchema.parse(request.params);
                const response = await listMachineFileBrowserDirectoryEntriesMock({
                    directoryPath: payload.path,
                    includeFiles: payload.includeFiles,
                    machineId,
                    serverId: home.serverId,
                });
                return response.ok ? { ...response, path: payload.path } : response;
            }
            default:
                throw Object.assign(new Error('Fixture daemon method is unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
        }
});

// Present-user folder creation is an external Account Action (one admitted filesystem owner): the
// Home mints its authorization and the daemon executes the decoded input. Only that daemon reply is replaced.
const folderActionRequests: Array<Readonly<{ machineId: string; input: unknown }>> = [];
const readActionRequests: Array<Readonly<{ actionId: string; input: unknown; requestId?: string; invocation: ExternalActionRequesterInvocationV1 }>> = [];

const defaultDirectoryEntries = listMachineFileBrowserDirectoryEntriesMock.getMockImplementation()!;
const defaultRoots = listMachineFileBrowserRootsMock.getMockImplementation()!;
const initialState = storage.getState();
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests> | undefined;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
async function setFolderActionPolicy(mode: 'off' | 'ask' | 'allowed') {
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected the path-browser Account');
    await storage.getState().activateSettingsScope(scope);
    const actionId = 'daemon.filesystem.createDirectory';
    const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: mode === 'off' ? { [actionId]: { disabledSurfaces: ['ui'] } }
            : mode === 'ask' ? { [actionId]: { approvalRequiredSurfaces: ['ui'] } } : {},
        approvalWaivedSurfaces: { ...Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(id => [id, ['ui', 'agent']])),
            ...(mode === 'allowed' ? { [actionId]: ['ui'] } : {}) },
    }) };
    const version = (storage.getState().settingsVersion ?? 0) + 1;
    storage.getState().applySettingsForScope(scope, settings, version);
    homes.answer(scope.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
    return scope;
}
async function addPathHome(options: Readonly<{ serverUrl: string; name: string; serverIdentityId: string; active?: boolean }>) {
    const id = await homes.addHome({ ...options, accountId: 'target-account', currentAccount: true, active: options.active ?? false });
    const machine = createMachineFixture({ storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: { host: 'path-browser.test', platform: 'darwin', happyCliVersion: 'test',
            happyHomeDir: '/Users/leeroy/.happier', homeDir: '/Users/leeroy' },
    });
    const folderAction = await createExternalActionAccountHttpBoundary({ serverUrl: options.serverUrl,
        serverIdentityId: options.serverIdentityId, accountId: 'target-account', machineId: machine.id,
        actionId: 'daemon.filesystem.createDirectory', tokenEpoch: 0,
        execute: async (input, context) => {
            const payload = FilesystemCreateDirectoryInputSchema.parse(input);
            folderActionRequests.push({ machineId: context.target.machineId, input: payload });
            return machineCreateDirectoryMock(context.target.machineId, payload.path,
                { serverId: id, accountId: 'target-account', signal: context.signal ?? undefined });
        },
    });
    for (const actionId of Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1)) {
        const readAction = await createExternalActionAccountHttpBoundary({ serverUrl: options.serverUrl,
            serverIdentityId: options.serverIdentityId, accountId: 'target-account', machineId: machine.id,
            actionId, tokenEpoch: 0, requesterInvocation: 'required',
            execute: async (input, context) => {
                readActionRequests.push({ actionId, input, requestId: context.requestId, invocation: context.invocation });
                if (actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listRoots) {
                    return listMachineFileBrowserRootsMock({ machineId: context.target.machineId, serverId: id });
                }
                if (actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles) {
                    return machineWorkspaceFileListMock(context.target.machineId, DaemonWorkspaceFileListRequestSchema.parse(input),
                        { serverId: id, accountId: 'target-account', signal: context.signal });
                }
                const payload = DaemonFilesystemListDirectoryRequestSchema.parse(input);
                const response = await listMachineFileBrowserDirectoryEntriesMock({ directoryPath: payload.path,
                    includeFiles: payload.includeFiles, machineId: context.target.machineId, serverId: id });
                return response.ok ? { ...response, path: payload.path } : response;
            },
        });
        for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
            homes.answer(id, path, { select: async (_body, request) => {
                const response = await readAction.handle(new URL(request.url), request.init);
                if (!response) throw new Error('Unhandled browser read Action request');
                return { status: response.status, body: await response.json() };
            } });
        }
    }
    const row = { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'target-account' }),
        installationPublicKey: folderAction.machine.installationPublicKey,
        metadata: encodePlainMachineStoredContent(machine.metadata) };
    for (const path of ['/v1/actions/daemon.filesystem.createDirectory/execution-authorization', '/v1/actions/daemon.filesystem.createDirectory']) {
        homes.answer(id, path, { select: async (_body, request) => {
            const response = await folderAction.handle(new URL(request.url), request.init);
            if (!response) throw new Error('Unhandled folder Action request');
            return { status: response.status, body: await response.json() };
        } });
    }
    homes.answer(id, '/v1/machines', { body: [row] });
    homes.answer(id, `/v1/machines/${machine.id}`, { body: { machine: row } });
    storage.getState().applyMachines([{ ...machine, access: row.access }], true, { sourceServerId: id, sourceAccountId: 'target-account' });
    storage.getState().markMachineListSettled(id);
    return { id };
}

// Load the real component after the boundary factories are initialized, during
// collection rather than inside a fake-timer test's execution budget.
await loadSyncSingletonForTests();
const { Modal: actualModal } = await import('@/modal/ModalManager');
const realModalPrompt = actualModal.prompt.bind(actualModal);
const realModalAlert = actualModal.alert.bind(actualModal);
let restoreModalBoundary = () => {};
const { MachinePathBrowserModal, MachinePathBrowserView } = await import('./MachinePathBrowserModal');

describe('MachinePathBrowserModal', () => {
    afterEach(async () => {
        vi.useRealTimers();
        standardCleanup();
        restoreModalBoundary();
        restoreModalBoundary = () => {};
        try {
            await connection?.dispose(); connection = undefined;
            await homes.reset();
            storage.setState(initialState, true);
        } finally {
            portal?.restore(); portal = undefined;
            browser?.restore(); browser = undefined;
            platformOS.current = 'web';
        }
    });
    beforeEach(async (context) => {
        // Device credentials must be written on the platform the mounted owner reads.
        platformOS.current = context.task.name.includes('native') ? 'ios' : 'web';
        browser = await installBrowserRuntimeForTests({ url: 'https://path-browser-active.example.test' });
        portal = installReactDomPortalBoundaryForTests();
        await homes.reset();
        storage.setState(initialState, true);
        await addPathHome({ serverUrl: 'https://path-browser-active.example.test', name: 'Active Home', serverIdentityId: 'srv_path_active', active: true });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://path-browser-active.example.test');
        if (!credentials) throw new Error('Path-browser Home credentials are missing');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://path-browser-active.example.test',
            serverIdentityId: 'srv_path_active', accountId: 'target-account', credentials, request: homes.request,
            additionalRequestOrigins: ['https://path-browser-folder-target.example.test', 'https://path-browser-target.example.test'] });
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        storage.setState({
            localSettings: { ...storage.getState().localSettings, uiItemDensity: 'comfortable', uiFontScale: 1 },
        });
        const { clearCachedMachineFileBrowserRoots, clearCachedMachineFileBrowserEntries } = await import('@/sync/domains/input/machineFileBrowser');
        clearCachedMachineFileBrowserRoots({ machineId: 'machine-1' });
        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1' });
        listMachineFileBrowserRootsMock.mockReset().mockImplementation(defaultRoots);
        listMachineFileBrowserDirectoryEntriesMock.mockReset().mockImplementation(defaultDirectoryEntries);
        flatListScrollToIndexMock.mockClear();
        machineCreateDirectoryMock.mockClear();
        machineRequests.length = 0;
        folderActionRequests.length = 0;
        readActionRequests.length = 0;
        machineWorkspaceFileListMock.mockReset().mockResolvedValue({ ok: true, paths: [], truncated: false });
        modalPromptMock.mockReset().mockResolvedValue(null);
        modalAlertMock.mockReset();
        // Legacy cases replace only dialog presentation; the composed case delegates these to the real host.
        const promptSpy = vi.spyOn(actualModal, 'prompt').mockImplementation((...args) => modalPromptMock(...args));
        const alertSpy = vi.spyOn(actualModal, 'alert').mockImplementation((...args) => modalAlertMock(...args));
        const confirmSpy = vi.spyOn(actualModal, 'confirm').mockResolvedValue(false);
        restoreModalBoundary = () => { promptSpy.mockRestore(); alertSpy.mockRestore(); confirmSpy.mockRestore(); };
        itemRenderCounts.clear();
        await setFolderActionPolicy('allowed');
    });

    it('names the Machine it browses in its header, and offers another only to a caller that takes the choice (TL-A 22:47Z)', async () => {
        const homeId = (await addPathHome({ serverUrl: 'https://path-browser-target.example.test', name: 'Studio Home', serverIdentityId: 'srv_path_machine_header' })).id;
        const { clearCachedMachineFileBrowserRoots, clearCachedMachineFileBrowserEntries } = await import('@/sync/domains/input/machineFileBrowser');
        clearCachedMachineFileBrowserRoots({ machineId: 'machine-1', serverId: homeId });
        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1', serverId: homeId });
        const { SelectionListFilterChip } = await import('@/components/ui/selectionList/SelectionListFilterChips');
        const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
        const current = storage.getState().machineListByServerId.srv_path_machine_header?.[0];
        if (!current) throw new Error('Expected the path-browser Machine');
        // The header names the Machine with New Session's Machine picker as a chip; its rows are that list's own.
        const machineChip = (screen: Awaited<ReturnType<typeof renderInModalChrome>>) =>
            screen.findAllByType(SelectionListFilterChip)[0]?.props.filter;
        const machineField = (screen: Awaited<ReturnType<typeof renderInModalChrome>>) =>
            screen.findAllByType(SessionMachineField)[0]?.props;

        const alone = await renderInModalChrome(<MachinePathBrowserModal machineId={current.id} serverId={homeId}
            selectionMode="directory" onResolve={vi.fn()} onClose={vi.fn()} />);
        await flushHookEffects();
        // Which Machine, by name, with a presence slot; one Machine is no choice.
        expect(machineChip(alone)).toMatchObject({ valueLabel: expect.any(String), reservePresence: true });
        expect(machineChip(alone)?.valueLabel).not.toBe('');
        expect(machineField(alone)?.onSelectMachine).toBeUndefined();
        expect(machineChip(alone)?.disabled).toBe(true);

        const other = createMachineFixture({ id: 'machine-studio', active: false, activeAt: 0, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadata: { host: 'studio.test', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/s/.happier', homeDir: '/home/s', displayName: 'Studio' } });
        await act(async () => {
            storage.getState().applyMachines([current, { ...other, access: current.access }], true, { sourceServerId: homeId, sourceAccountId: 'target-account' });
        });
        const fixed = await renderInModalChrome(<MachinePathBrowserModal machineId={current.id} serverId={homeId}
            selectionMode="directory" onResolve={vi.fn()} onClose={vi.fn()} />);
        await flushHookEffects();
        // A caller bound to one Machine (its storage page) shows it and offers no other.
        expect(machineField(fixed)?.onSelectMachine).toBeUndefined();
        expect(machineChip(fixed)?.disabled).toBe(true);

        const onResolve = vi.fn();
        const chooser = await renderInModalChrome(<MachinePathBrowserModal machineId={other.id} serverId={homeId}
            selectionMode="directory" allowMachineChange onResolve={onResolve} onClose={vi.fn()} />);
        await flushHookEffects();
        expect(machineField(chooser)?.machineId).toBe(other.id);
        expect(machineChip(chooser)).toMatchObject({ valueLabel: 'Studio', presence: 'offline' });
        expect(machineChip(chooser)?.disabled).toBeFalsy();
        await act(async () => { machineField(chooser)!.onSelectMachine!(current); });
        await flushHookEffects();
        // An offline Machine stays listed by the picker but cannot be chosen there (its own suite); the chosen one leads.
        expect(machineField(chooser)?.machineId).toBe(current.id);
        // The browser now reads the chosen Machine, and the picked folder comes back with it.
        await waitForTestId(chooser, getPathBrowserToggleTestId('/'));
        await chooser.pressByTestIdAsync(getPathBrowserRowTestId('/'));
        await chooser.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(onResolve).toHaveBeenCalledWith('/', current.id);
    });

    it('loads root children on the selected Home before confirming a folder, without selecting the disclosure target', async () => {
        const targetHome = await addPathHome({ serverUrl: 'https://path-browser-folder-target.example.test', name: 'Folder Home', serverIdentityId: 'srv_path_folder_target' });
        const { clearCachedMachineFileBrowserRoots, clearCachedMachineFileBrowserEntries } = await import('@/sync/domains/input/machineFileBrowser');
        clearCachedMachineFileBrowserRoots({ machineId: 'machine-1', serverId: targetHome.id });
        clearCachedMachineFileBrowserEntries({ machineId: 'machine-1', serverId: targetHome.id });
        let resolveRootChildren!: (result: Awaited<ReturnType<typeof defaultDirectoryEntries>>) => void;
        const rootChildren = new Promise<Awaited<ReturnType<typeof defaultDirectoryEntries>>>((resolve) => {
            resolveRootChildren = resolve;
        });
        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(async (input) => (
            input.directoryPath === '/' ? await rootChildren : await defaultDirectoryEntries(input)
        ));
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    serverId={targetHome.id}
                    selectionMode="directory"
                    onResolve={onResolve}
                    onClose={onClose}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));
        expect(screen.findByTestId(getPathBrowserRowTestId('/'))?.props.accessibilityState?.expanded).toBe(true);
        const pendingChildren = screen.findHostByTestId(`${getPathBrowserRowTestId('/')}-loading`);
        expect(pendingChildren).not.toBeNull();
        expect(pendingChildren?.props.accessibilityRole).toBe('progressbar');
        expect(pendingChildren?.props.accessibilityLabel).toBe('common.loading');
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users'))).toBeNull();
        expect(screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID)?.props.disabled).toBe(true);
        expect(onResolve).not.toHaveBeenCalled();

        await act(async () => {
            resolveRootChildren({ ok: true, entries: [{ name: 'Users', path: '/Users', type: 'directory' }], truncated: false });
        });

        const usersRow = await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        expect(usersRow).not.toBeNull();
        expect(screen.findHostByTestId(`${getPathBrowserRowTestId('/')}-loading`)).toBeNull();
        expect(screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID)?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));
        expect(screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID)?.props.disabled).toBe(false);

        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);

        expect(listMachineFileBrowserRootsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: targetHome.id,
        }));
        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls).toEqual(expect.arrayContaining([
            [expect.objectContaining({
                machineId: 'machine-1',
                directoryPath: '/',
                includeFiles: false,
                serverId: targetHome.id,
            })],
        ]));
        expect(onResolve).toHaveBeenCalledWith('/Users', 'machine-1');
        expect(onClose).toHaveBeenCalled();
    });

    it('keeps a native agent directory retry behind browseDirectory Action policy', async () => {
        platformOS.current = 'ios';
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const scope = await setFolderActionPolicy('allowed');
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { [FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory]: { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { [FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory]: ['ui'],
                [ACTION_ID_FAMILIES_V1.current_ui_context[1]]: ['ui'] },
        }) };
        const version = (storage.getState().settingsVersion ?? 0) + 1;
        storage.getState().applySettingsForScope(scope, settings, version);
        homes.answer(scope.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({ ok: false, error: 'MACHINE_RPC_FAILED', errorCode: 'MACHINE_RPC_FAILED' });
        const screen = await renderMountedCurrentUiContext(<MachinePathBrowserView machineId="machine-1"
            rootDirectoryPath="/" currentUiContextCommandScope="test.read-browser" onPickPath={() => {}} />,
        { withModalProvider: true });
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })?.readCurrentUiContext()?.commands ?? [];
        const retry = () => commands().find(candidate => {
            try { return JSON.parse(candidate.description ?? '{}').control === 'test.read-browser.retryRoot'; } catch { return false; }
        });
        await act(async () => { await vi.waitFor(() => expect(retry()).toBeTruthy()); });
        const readsBeforeRetry = listMachineFileBrowserDirectoryEntriesMock.mock.calls.length;
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => {
            await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: retry()!.id }, {
                surface: 'agent', authority: 'account_automation', expectedAccountId: 'target-account',
                actionRequestId: 'native-browser-read-retry',
            });
            await flushHookEffects();
        });
        await act(async () => { await vi.waitFor(() => {
            const settledError = screen.findAll(node => node.props.diagnosticCode
                && node.props.diagnosticCode !== 'MACHINE_RPC_FAILED');
            expect(screen.findByTestId(getPathBrowserRowTestId('/Users')) ?? settledError[0]).toBeTruthy();
        }); });
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users'))).toBeNull();
        expect(screen.findAll(node => node.props.diagnosticCode === 'action_disabled').length).toBeGreaterThan(0);
        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls.length).toBe(readsBeforeRetry);
        const { FileBrowserToolbarIconButton } = await import('@/components/ui/filesystemBrowser/FileBrowserToolbar');
        const readsBeforeRefresh = readActionRequests.length;
        await act(async () => {
            const refresh = screen.findAllByTestId('path-browser-refresh')
                .find(node => node.type === FileBrowserToolbarIconButton);
            expect(refresh).toBeDefined();
            expect(await refresh!.props.onPress()).toBe(true);
        });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findByTestId(getPathBrowserRowTestId('/Users')),
                JSON.stringify({ reads: readActionRequests, nativeRequests: machineRequests,
                    diagnostics: screen.findAll(node => Boolean(node.props.diagnosticCode)).map(node => node.props.diagnosticCode) }),
            ).toBeTruthy();
        });
        expect(readActionRequests.slice(readsBeforeRefresh)).toEqual(expect.arrayContaining([expect.objectContaining({
            actionId: FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory,
            invocation: expect.objectContaining({ surface: 'ui', authority: 'present_user' }),
        })]));
        expect(machineRequests).toEqual([]);
    });

    it('preserves the native opening agent through initial admitted directory reads', async () => {
        platformOS.current = 'ios';
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { useCurrentUiContextCommandBridge, useCurrentUiContextLocalCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const { openMachinePathBrowserModal } = await import('./openMachinePathBrowserModal');
        const callerContext: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
            expectedAccountId: 'target-account', actionRequestId: 'native-browser-agent-open' };
        function OpenBrowser() {
            const Bridge = useCurrentUiContextCommandBridge();
            useCurrentUiContextLocalCommands([{ key: 'browse', title: 'Browse initial directory',
                invoke: (_input, context) => { void openMachinePathBrowserModal({ machineId: 'machine-1', initialPath: '/Users',
                    currentUiContextCommandScope: 'test.initial-browser', commandBridge: Bridge, callerContext: context }); },
            }]);
            return null;
        }
        const screen = await renderMountedCurrentUiContext(<OpenBrowser />, { withModalProvider: true });
        const command = await vi.waitFor(() => {
            const descriptor = readCurrentUiContextActionReader({ surface: 'agent' })?.readCurrentUiContext()?.commands
                .find(candidate => candidate.title === 'Browse initial directory');
            expect(descriptor).toBeTruthy();
            return descriptor!;
        });
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command.id }, callerContext))
            .toMatchObject({ ok: true }); });
        await waitForTestId(screen, getPathBrowserRowTestId('/Users/leeroy'));
        const initialReads = readActionRequests.filter(request => request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory);
        expect(initialReads.length).toBeGreaterThan(0);
        expect(initialReads).toEqual(expect.arrayContaining([expect.objectContaining({ input: expect.objectContaining({ path: '/Users' }) })]));
        expect(new Set(initialReads.map(request => request.requestId)).size).toBe(initialReads.length);
        for (const request of readActionRequests) {
            expect(request.invocation).toMatchObject({ surface: 'agent', authority: 'account_automation' });
        }
        expect(machineRequests).toEqual([]);
    });

    it('shares mounted browser selection, disclosure, filters and confirmation between UI and agent commands', async () => {
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const confirmingContexts: ActionExecutorContext[] = [];
        modalPromptMock.mockImplementation((...args: Parameters<typeof realModalPrompt>) => realModalPrompt(args[0], args[1], {
            ...args[2],
            onConfirmContext: context => {
                confirmingContexts.push(context);
                args[2]?.onConfirmContext?.(context);
            },
        }));
        modalAlertMock.mockImplementation(realModalAlert);
        const picked = vi.fn();
        const screen = await renderMountedCurrentUiContext(<ChromeHost>
            <MachinePathBrowserModal machineId="machine-1" currentUiContextCommandScope="test.browser" onResolve={picked} onClose={() => {}} />
        </ChromeHost>, { withModalProvider: true });
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        let agentInvocationNumber = 0;
        // Agent ingress supplies its operation identity; the app mints one only for its own UI/voice/plugin origins.
        const agentContext = (): ActionExecutorContext => ({ surface: 'agent', authority: 'account_automation',
            expectedAccountId: 'target-account', actionRequestId: `browser-agent-${++agentInvocationNumber}` });
        const commands = () => readCurrentUiContextActionReader({ surface: 'agent' })?.readCurrentUiContext()?.commands ?? [];
        const invoke = async (control: string, input?: { path?: string; value?: string; open?: boolean }) => {
            const command = commands().find(candidate => {
                try { return JSON.parse(candidate.description ?? '{}').control === `test.browser.${control}`; } catch { return false; }
            });
            expect(command, control).toBeTruthy();
            let result: unknown;
            await act(async () => { result = await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
                { commandId: command!.id, ...(input ? { input } : {}) }, agentContext()); });
            return result;
        };
        expect(await invoke('confirm')).toMatchObject({ ok: false });
        expect(picked).not.toHaveBeenCalled();
        expect(await invoke('overflow', { open: true })).toMatchObject({ ok: true });
        expect(await invoke('overflow')).toMatchObject({ ok: true, result: { open: true } });
        expect(await invoke('overflow', { open: false })).toMatchObject({ ok: true });
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));
        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        expect(await invoke('disclosure', { path: '/Users' })).toMatchObject({ ok: true });
        await waitForTestId(screen, getPathBrowserRowTestId('/Users/leeroy'));
        expect(await invoke('activate', { path: '/Users/leeroy' })).toMatchObject({ ok: true });
        expect(await invoke('activate')).toMatchObject({ ok: true, result: { selectedPath: '/Users/leeroy' } });
        expect(await invoke('contextMenu', { path: '/Users/leeroy' })).toMatchObject({ ok: true });
        expect(await invoke('closeContextMenu')).toMatchObject({ ok: true });
        expect(screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID)?.props.disabled).toBe(false);
        expect(await invoke('hidden')).toMatchObject({ ok: true });
        expect(await invoke('search', { value: 'repo' })).toMatchObject({ ok: true });
        expect(screen.findByTestId('path-browser-search')?.props.value).toBe('repo');
        expect(await invoke('clearSearch')).toMatchObject({ ok: true });
        expect(await invoke('activate', { path: '/not-rendered' })).toMatchObject({ ok: false });
        expect(await invoke('confirm')).toMatchObject({ ok: true });
        expect(picked).toHaveBeenCalledWith('/Users/leeroy', 'machine-1');
        const scope = await setFolderActionPolicy('allowed');
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'daemon.filesystem.createDirectory': { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: { ...Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(id => [id, ['ui', 'agent']])),
                'daemon.filesystem.createDirectory': ['ui'] },
        }) };
        const version = (storage.getState().settingsVersion ?? 0) + 1;
        storage.getState().applySettingsForScope(scope, settings, version);
        homes.answer(scope.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
        await screen.pressByTestIdAsync(PATH_BROWSER_CREATE_FOLDER_TEST_ID);
        await waitForTestId(screen, 'web-prompt-input');
        const invokePrompt = async (title: string, input?: { value: string }) => {
            const command = await vi.waitFor(() => {
                const candidate = commands().find(command => command.title === title);
                expect(candidate, title).toBeTruthy();
                return candidate!;
            });
            await act(async () => { expect(await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1],
                { commandId: command.id, ...(input ? { input } : {}) }, agentContext())).toMatchObject({ ok: true }); });
        };
        await invokePrompt('files.createFolderPromptTitle', { value: 'agent-folder' });
        await invokePrompt('common.ok');
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(machineCreateDirectoryMock).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalled();
        await waitForTestId(screen, 'web-modal-button-0');
        await invokePrompt('common.ok');

        const allowedSettings = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: {},
            approvalWaivedSurfaces: { ...Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(id => [id, ['ui', 'agent']])),
                'daemon.filesystem.createDirectory': ['ui', 'agent'] },
        }) };
        storage.getState().applySettingsForScope(scope, allowedSettings, version + 1);
        homes.answer(scope.serverId, '/v2/account/settings', {
            body: { content: { t: 'plain', v: allowedSettings }, version: version + 1 },
        });
        await screen.pressByTestIdAsync(PATH_BROWSER_CREATE_FOLDER_TEST_ID);
        await waitForTestId(screen, 'web-prompt-input');
        await invokePrompt('files.createFolderPromptTitle', { value: 'allowed-agent-folder' });
        await invokePrompt('common.ok');
        expect(confirmingContexts).toHaveLength(2);
        expect(confirmingContexts.at(-1)).toMatchObject({ surface: 'agent', authority: 'account_automation',
            expectedAccountId: 'target-account', actionRequestId: `browser-agent-${agentInvocationNumber}` });
        expect(confirmingContexts.at(-1)?.signal?.aborted).not.toBe(true);
        await act(async () => {
            await vi.waitFor(() => {
                expect(modalAlertMock.mock.calls.slice(1)).toEqual([]);
                expect(folderActionRequests, JSON.stringify({ nativeRequests: machineRequests,
                    alerts: modalAlertMock.mock.calls, confirmingActor: confirmingContexts.at(-1)?.surface,
                    confirmingAuthority: confirmingContexts.at(-1)?.authority,
                    hasOrdinaryChild: Boolean(confirmingContexts.at(-1)?.executeOrdinaryChildAction),
                })).toContainEqual({ machineId: 'machine-1',
                    input: expect.objectContaining({ path: '/Users/leeroy/allowed-agent-folder' }) });
            });
        });
        expect(machineCreateDirectoryMock).toHaveBeenCalledWith('machine-1', '/Users/leeroy/allowed-agent-folder',
            expect.objectContaining({ signal: expect.objectContaining({ aborted: false }) }));
    });

    it('shows a failed root-directory read as a retryable child error instead of an empty expanded root', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({ ok: false, error: 'RPC method not available' });
        const screen = await renderInModalChrome(<MachinePathBrowserModal machineId="machine-1"
            selectionMode="directory" onResolve={vi.fn()} onClose={vi.fn()} />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));
        const error = await waitForTestId(screen, `${getPathBrowserRowTestId('/')}-folder-error`);
        expect(error).not.toBeNull();
        expect(screen.getTextContent()).toContain('files.repositoryFolderLoadFailed');
        expect(screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID)?.props.disabled).toBe(true);

        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(defaultDirectoryEntries);
        await screen.pressByTestIdAsync(`${getPathBrowserRowTestId('/')}-folder-error-action`);
        expect(await waitForTestId(screen, getPathBrowserRowTestId('/Users'))).not.toBeNull();
        expect(screen.findByTestId(`${getPathBrowserRowTestId('/')}-folder-error`)).toBeNull();
    });

    it('names one failure once: a failed root listing owns the error, its expanded folder repeats nothing', async () => {
        listMachineFileBrowserRootsMock.mockResolvedValue({ ok: false, error: 'boom' } as never);
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({ ok: false, error: 'boom' });
        // The initial path paints its chain at once, so the failed listing has rows under it, as on a real Machine.
        const screen = await renderInModalChrome(<MachinePathBrowserModal machineId="machine-1" initialPath="/Users/leeroy"
            selectionMode="directory" onResolve={vi.fn()} onClose={vi.fn()} />);

        await waitForTestId(screen, `${PATH_BROWSER_ROOT_ERROR_TEST_ID}-action`);
        await flushHookEffects({ cycles: 3, turns: 3 });
        const text = screen.getTextContent();
        expect(text.split('files.pane.rootErrorTitleUnnamed')).toHaveLength(2);
        expect(text).not.toContain('files.repositoryFolderLoadFailed');
        expect(screen.findByTestId(`${getPathBrowserRowTestId('/')}-folder-error`)).toBeNull();
        // An unclassified cause adds no sentence of its own: "Operation failed" says nothing.
        expect(text).not.toContain('errors.operationFailed');

        listMachineFileBrowserRootsMock.mockResolvedValue({ ok: true, roots: [{ id: '/', label: '/', path: '/' }] } as never);
        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(defaultDirectoryEntries);
        await screen.pressByTestIdAsync(`${PATH_BROWSER_ROOT_ERROR_TEST_ID}-action`);
        expect(await waitForTestId(screen, getPathBrowserRowTestId('/Users'))).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('files.pane.rootErrorTitleUnnamed');
    });

    it('uses tree arrow disclosure without selecting or picking the focused folder', async () => {
        const onPickPath = vi.fn();
        const screen = await renderScreen(<MachinePathBrowserView machineId="machine-1" variant="popover"
            interaction="immediate" onPickPath={onPickPath} />);
        const root = await waitForTestId(screen, getPathBrowserRowTestId('/'));
        expect(root?.props.onKeyDown).toBeTypeOf('function');
        await act(async () => { root!.props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() }); });
        const child = await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        expect(child).not.toBeNull();
        expect(onPickPath).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));
        expect(onPickPath).toHaveBeenCalledWith('/Users');
    });

    it('shows the machine-unreachable copy instead of transport vocabulary when the directory RPC fails', async () => {
        // `F-UI-2`: this slot rendered whatever string the ops adapter produced, and the adapter
        // passed `error.message` through — so an internal `TypeError` was displayed here verbatim.
        // The adapter now reports an unreachable machine with the canonical protocol constant; the
        // picker owns turning that into copy, exactly as the source-control surfaces do.
        // The shared mocks are only `mockClear()`ed between tests, so restore the defaults rather
        // than leaking this failure into every later case.
        const defaultEntries = listMachineFileBrowserDirectoryEntriesMock.getMockImplementation();
        const defaultRoots = listMachineFileBrowserRootsMock.getMockImplementation();
        try {
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
                ok: false,
                error: 'RPC method not available',
            });
            listMachineFileBrowserRootsMock.mockResolvedValue({
                ok: false,
                error: 'RPC method not available',
            });

            const screen = await renderInModalChrome(<MachinePathBrowserModal
                        machineId="machine-1"
                        onResolve={vi.fn()}
                        onClose={vi.fn()}
                    />);
            await flushHookEffects();
            const text = screen.getTextContent();

            expect(text).toContain('errors.daemonUnavailableBody');
            expect(text).not.toContain('RPC method not available');
        } finally {
            listMachineFileBrowserDirectoryEntriesMock.mockReset();
            listMachineFileBrowserRootsMock.mockReset();
            if (defaultEntries) listMachineFileBrowserDirectoryEntriesMock.mockImplementation(defaultEntries);
            if (defaultRoots) listMachineFileBrowserRootsMock.mockImplementation(defaultRoots);
        }
    });

    it('supports a scoped popover view rooted at a specific directory without listing machine roots', async () => {
        const onPickPath = vi.fn();
        const onRequestClose = vi.fn();

        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true as const,
            entries: [
                { name: 'README.md', path: '/repo/README.md', type: 'file' as const },
            ],
            truncated: false,
        });

        const screen = await renderScreen(
            <MachinePathBrowserView
                machineId="machine-1"
                rootDirectoryPath="/repo"
                includeFiles
                selectionMode="file"
                variant="popover"
                interaction="immediate"
                maxHeight={320}
                onPickPath={onPickPath}
                onRequestClose={onRequestClose}
            />,
        );

        await waitForTestId(screen, getPathBrowserRowTestId('/repo/README.md'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/repo/README.md'));

        expect(listMachineFileBrowserRootsMock).not.toHaveBeenCalled();
        expect(listMachineFileBrowserDirectoryEntriesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            directoryPath: '/repo',
            includeFiles: true,
        }));
        expect(onPickPath).toHaveBeenCalledWith('/repo/README.md');
        expect(onRequestClose).not.toHaveBeenCalled();
        expect(screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID)).toBeNull();
    });

    it('can search deep paths on the machine when scoped, not just already-loaded nodes', async () => {
        vi.useFakeTimers();
        const onPickPath = vi.fn();

        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true as const,
            entries: [
                { name: 'apps', path: '/repo/apps', type: 'directory' as const },
            ],
            truncated: false,
        });
        machineWorkspaceFileListMock.mockResolvedValueOnce({
            ok: true,
            paths: ['apps/ui/README.md', 'apps/ui/src/index.ts'],
            truncated: false,
        });

        const screen = await renderScreen(
            <MachinePathBrowserView
                machineId="machine-1"
                rootDirectoryPath="/repo"
                includeFiles
                selectionMode="file"
                variant="popover"
                interaction="immediate"
                maxHeight={320}
                onPickPath={onPickPath}
            />,
        );

        await act(async () => {
            screen.changeTextByTestId('path-browser-search', 'readme');
        });
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(machineWorkspaceFileListMock).toHaveBeenCalledWith(
            'machine-1',
            { rootPath: '/repo', query: 'readme', includeHidden: true, resultType: 'file', budgetMs: expect.any(Number) },
            expect.anything(),
        );

        await waitForTestId(screen, getPathBrowserRowTestId('/repo/apps/ui/README.md'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/repo/apps/ui/README.md'));

        expect(onPickPath).toHaveBeenCalledWith('/repo/apps/ui/README.md');
        vi.useRealTimers();
    });

    it('binds a targeted Home search to its credential Account and reports incomplete coverage', async () => {
        const targetHome = await addPathHome({ serverUrl: 'https://path-browser-target.example.test', name: 'Target Home', serverIdentityId: 'srv_path_search_target' });
        vi.useFakeTimers();
        machineWorkspaceFileListMock.mockResolvedValueOnce({ ok: true, paths: ['src/needle.ts'], truncated: true });
        const screen = await renderScreen(<MachinePathBrowserView machineId="machine-1" serverId={targetHome.id}
            rootDirectoryPath="/repo" includeFiles selectionMode="file" variant="popover" onPickPath={vi.fn()} />);
        await flushHookEffects({ cycles: 1, turns: 2 });
        await act(async () => { screen.changeTextByTestId('path-browser-search', 'needle'); });
        await act(async () => { await vi.advanceTimersByTimeAsync(200); });
        expect(machineWorkspaceFileListMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            serverId: targetHome.id, accountId: 'target-account', signal: expect.any(AbortSignal),
        }));
        expect(screen.findByTestId('path-browser-search-incomplete')).toBeTruthy();
        expect(screen.findByTestId(getPathBrowserRowTestId('/repo/src/needle.ts'))).toBeTruthy();
        vi.useRealTimers();
    });

    it('can search deep paths on the machine within the selected directory when not scoped', async () => {
        vi.useFakeTimers();
        const onPickPath = vi.fn();

        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true as const,
            entries: [
                { name: 'Users', path: '/Users', type: 'directory' as const },
            ],
            truncated: false,
        });

        // A folder search returns folder records, empty folders included (QA-BREADTH Q11).
        machineWorkspaceFileListMock.mockResolvedValueOnce({
            ok: true,
            paths: ['leeroy/.ssh/'],
            truncated: false,
        });

        const screen = await renderInModalChrome(
            <MachinePathBrowserView
                machineId="machine-1"
                includeFiles={false}
                selectionMode="directory"
                variant="modal"
                interaction="confirm"
                onPickPath={onPickPath}
            />,
        );

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));
        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));

        await act(async () => {
            screen.changeTextByTestId('path-browser-search', 'ssh');
        });
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(machineWorkspaceFileListMock).toHaveBeenCalledWith(
            'machine-1',
            { rootPath: '/Users', query: 'ssh', includeHidden: true, resultType: 'folder', budgetMs: expect.any(Number) },
            expect.anything(),
        );

        await waitForTestId(screen, getPathBrowserRowTestId('/Users/leeroy/.ssh'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users/leeroy/.ssh'));
        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);

        expect(onPickPath).toHaveBeenCalledWith('/Users/leeroy/.ssh');
        vi.useRealTimers();
    });

    it('disables confirm while a deep search error is surfaced', async () => {
        vi.useFakeTimers();
        const onPickPath = vi.fn();

        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true as const,
            entries: [{ name: 'Users', path: '/Users', type: 'directory' as const }],
            truncated: false,
        });

        machineWorkspaceFileListMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'ripgrep_failed',
            exitCode: 2,
        });

        const screen = await renderInModalChrome(
            <MachinePathBrowserView
                machineId="machine-1"
                includeFiles={false}
                selectionMode="directory"
                variant="modal"
                interaction="confirm"
                onPickPath={onPickPath}
            />,
        );

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));
        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));

        const confirmBefore = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(confirmBefore?.props.disabled).toBe(false);

        await act(async () => {
            screen.changeTextByTestId('path-browser-search', 'needle');
        });
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        const confirmAfter = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(confirmAfter?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('errors.searchFailed');
        expect(screen.getTextContent()).not.toContain('errors.unknownError');

        vi.useRealTimers();
    });

    it('does not rerender unchanged ancestor rows when expanding a descendant directory', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));
        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));

        const rootRenderCountAfterRootExpand = itemRenderCounts.get(getPathBrowserRowTestId('/')) ?? 0;
        expect(rootRenderCountAfterRootExpand).toBeGreaterThan(0);

        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/Users'));
        expect(await waitForTestId(screen, getPathBrowserRowTestId('/Users/leeroy'))).not.toBeNull();
        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls).toEqual(expect.arrayContaining([
            [expect.objectContaining({
                machineId: 'machine-1',
                directoryPath: '/Users',
                includeFiles: false,
            })],
        ]));

        expect(itemRenderCounts.get(getPathBrowserRowTestId('/')) ?? 0).toBe(rootRenderCountAfterRootExpand);
    });

    it('discloses folders through the shared tree row: a named, expandable chevron outside the tab order', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        const rootToggle = screen.findByTestId(getPathBrowserToggleTestId('/'));
        // The tree row is the keyboard item; its chevron says what it opens and whether it is open.
        expect(rootToggle?.props.accessibilityLabel).toBe('/');
        expect(rootToggle?.props.tabIndex).toBe(-1);
        expect(rootToggle?.props.accessibilityState?.expanded).toBe(false);

        const stopPropagation = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(rootToggle, 'onPress', { stopPropagation, nativeEvent: { stopPropagation } });
        });

        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));

        // Disclosing never also activates (selects) the row it sits in.
        expect(stopPropagation).toHaveBeenCalled();
        expect(screen.findByTestId(getPathBrowserToggleTestId('/'))?.props.accessibilityState?.expanded).toBe(true);
        expect(listMachineFileBrowserDirectoryEntriesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            directoryPath: '/',
            includeFiles: false,
        }));
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users'))).toBeTruthy();
    });

    it('lists everything under the root when it opens on a folder inside it, not only the way to that folder', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(async (input) => input.directoryPath === '/'
            ? { ok: true as const, entries: [{ name: 'Users', path: '/Users', type: 'directory' as const },
                { name: 'var', path: '/var', type: 'directory' as const }], truncated: false }
            : await defaultDirectoryEntries(input));
        const screen = await renderInModalChrome(<MachinePathBrowserModal machineId="machine-1" initialPath="/Users/leeroy"
            onResolve={vi.fn()} onClose={vi.fn()} />);
        await waitForTestId(screen, getPathBrowserRowTestId('/var'));
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users/leeroy'))).toBeTruthy();
    });

    it('goes to a typed or pasted absolute path, listing that folder by the typed name instead of searching for it', async () => {
        const listing: Record<string, Array<{ name: string; path: string; type: 'directory' }>> = {
            '/': [{ name: 'Users', path: '/Users', type: 'directory' }, { name: 'var', path: '/var', type: 'directory' }],
            '/var': [{ name: 'tmp', path: '/var/tmp', type: 'directory' }, { name: 'log', path: '/var/log', type: 'directory' }],
            '/var/tmp': [{ name: 'project', path: '/var/tmp/project', type: 'directory' }, { name: 'other', path: '/var/tmp/other', type: 'directory' }],
        };
        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(async (input) => (
            { ok: true as const, entries: listing[input.directoryPath] ?? [], truncated: false }));
        const onResolve = vi.fn();
        const screen = await renderInModalChrome(<MachinePathBrowserModal machineId="machine-1" onResolve={onResolve} onClose={vi.fn()} />);
        await waitForTestId(screen, getPathBrowserToggleTestId('/'));

        await act(async () => { screen.changeTextByTestId('path-browser-search', '/var/tmp/pro'); });
        await waitForTestId(screen, getPathBrowserRowTestId('/var/tmp/project'));
        expect(screen.findByTestId(getPathBrowserRowTestId('/var/tmp/other'))).toBeNull();
        expect(screen.findByTestId(getPathBrowserRowTestId('/var/log'))).toBeNull();

        await act(async () => { screen.changeTextByTestId('path-browser-search', '/var/tmp/project'); });
        let confirm = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        for (let index = 0; index < 8 && confirm?.props?.disabled !== false; index += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
            confirm = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        }
        expect(confirm?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(onResolve).toHaveBeenCalledWith('/var/tmp/project', 'machine-1');
        expect(machineWorkspaceFileListMock).not.toHaveBeenCalled();
    });

    it('finds a typed path inside a capped folder by asking the Machine for that name (QA-BREADTH Q11)', async () => {
        // `/tmp` has more entries than one listing carries; the typed folder is not in the first page.
        const capped = Array.from({ length: 500 }, (_, index) => ({ name: `a-${index}`, path: `/tmp/a-${index}`, type: 'directory' as const }));
        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(async (input) => input.directoryPath === '/'
            ? { ok: true as const, entries: [{ name: 'tmp', path: '/tmp', type: 'directory' as const }], truncated: false }
            : input.directoryPath === '/tmp' ? { ok: true as const, entries: capped, truncated: true }
                : { ok: true as const, entries: [], truncated: false });
        machineWorkspaceFileListMock.mockResolvedValue({ ok: true, paths: ['p03-qab-join/', 'p03-qab-join2/'], truncated: false });
        const onResolve = vi.fn();
        const screen = await renderInModalChrome(<MachinePathBrowserModal machineId="machine-1" onResolve={onResolve} onClose={vi.fn()} />);
        await waitForTestId(screen, getPathBrowserToggleTestId('/'));

        await act(async () => { screen.changeTextByTestId('path-browser-search', '/tmp/p03-qab-join'); });
        // The capped listing arrives, then the name lookup runs after the query's input debounce.
        await vi.waitFor(async () => {
            await flushHookEffects({ cycles: 1, turns: 1 });
            expect(screen.findByTestId(getPathBrowserRowTestId('/tmp/p03-qab-join'))).not.toBeNull();
        }, { timeout: 3_000, interval: 50 });
        expect(screen.findByTestId(getPathBrowserRowTestId('/tmp/p03-qab-join2'))).not.toBeNull();
        expect(screen.findByTestId(getPathBrowserRowTestId('/tmp/a-1'))).toBeNull();
        // One name lookup in the typed folder, not a walk below it.
        expect(machineWorkspaceFileListMock).toHaveBeenCalledTimes(1);
        expect(machineWorkspaceFileListMock.mock.calls[0]?.[1]).toMatchObject(
            { rootPath: '/tmp', query: 'p03-qab-join', resultType: 'folder', maxDepth: 1 });

        let confirm = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        for (let index = 0; index < 8 && confirm?.props?.disabled !== false; index += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
            confirm = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        }
        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(onResolve).toHaveBeenCalledWith('/tmp/p03-qab-join', 'machine-1');
    });

    it('pre-expands and preselects the current directory path so the user can navigate up or elsewhere', async () => {
        const onResolve = vi.fn();

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    onResolve={onResolve}
                    onClose={vi.fn()}
                />);

        let confirmButton: ReturnType<typeof screen.findByTestId> = await waitForTestId(screen, PATH_BROWSER_CONFIRM_TEST_ID);
        for (let index = 0; index < 8 && confirmButton?.props?.disabled !== false; index += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
            confirmButton = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        }

        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls).toEqual(expect.arrayContaining([
            [expect.objectContaining({ directoryPath: '/', includeFiles: false })],
            [expect.objectContaining({ directoryPath: '/Users', includeFiles: false })],
        ]));
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users/leeroy'))).toBeTruthy();

        confirmButton = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(confirmButton?.props.disabled).toBe(false);

        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);

        expect(onResolve).toHaveBeenCalledWith('/Users/leeroy', 'machine-1');
    });

    it('shows the selected path once, relative to the machine home', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);
        let confirmButton: ReturnType<typeof screen.findByTestId> = await waitForTestId(screen, PATH_BROWSER_CONFIRM_TEST_ID);
        for (let index = 0; index < 8 && confirmButton?.props?.disabled !== false; index += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
            confirmButton = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        }
        const textsShowingSelection = screen.findAll((node) => (node.type as string) === 'Text'
            && (node.props.children === '~' || node.props.children === '/Users/leeroy'));
        expect(textsShowingSelection.map((node) => node.props.children)).toEqual(['~']);

        let chrome: { subtitle?: unknown } | null = null;
        await renderScreen(<MachinePathBrowserView
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    variant="modal"
                    interaction="confirm"
                    setChrome={(next: unknown) => { chrome = next as { subtitle?: unknown; actions?: unknown }; }}
                    onPickPath={vi.fn()}
                    onRequestClose={vi.fn()}
                />);
        for (let index = 0; index < 8; index += 1) await flushHookEffects({ cycles: 1, turns: 1 });
        // The confirm footer carries the selection, so the title band does not repeat it: it names the Machine,
        // on the title's own row beside the folder action, taking no line of its own.
        const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
        const band = chrome as { subtitle?: unknown; actions?: unknown } | null;
        expect(band?.subtitle).toBeUndefined();
        const actions = React.isValidElement<{ children?: React.ReactNode }>(band?.actions)
            ? React.Children.toArray(band.actions.props.children) : [];
        expect(actions.map(child => React.isValidElement(child) ? child.type : null)).toContain(SessionMachineField);
    });

    it('shows the initial path chain while the root listing is still pending', async () => {
        listMachineFileBrowserRootsMock.mockImplementationOnce(async () => await new Promise(() => {}));


        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        expect(screen.findByTestId(getPathBrowserRowTestId('/'))).toBeTruthy();
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users'))).toBeTruthy();
    });

    it('scrolls the preselected directory into view once its ancestor chain has loaded', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        for (let index = 0; index < 8 && flatListScrollToIndexMock.mock.calls.length === 0; index += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
        }

        expect(flatListScrollToIndexMock).toHaveBeenCalledWith(expect.objectContaining({
            index: 2,
            animated: false,
        }));

        flatListScrollToIndexMock.mockClear();

        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));

        expect(flatListScrollToIndexMock).not.toHaveBeenCalled();
    });

    it('starts with no selection when the initial path cannot be resolved inside the loaded tree', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Missing/Folder"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        for (let index = 0; index < 8; index += 1) {
            await flushHookEffects({ cycles: 1, turns: 1 });
        }

        const confirmButton = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(confirmButton?.props.disabled).toBe(true);
    });

    it('renders a truncation info row when a loaded directory is capped', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockImplementation(async (params: { directoryPath: string }) => {
            if (params.directoryPath === '/') {
                return {
                    ok: true as const,
                    entries: [{ name: 'Users', path: '/Users', type: 'directory' as const }],
                    truncated: true,
                };
            }
            return {
                ok: true as const,
                entries: [],
                truncated: false,
            };
        });


        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        await waitForTestId(screen, getPathBrowserRowTestId('/#truncated'));

        const infoRows = screen.findAllByTestId(getPathBrowserRowTestId('/#truncated'));
        const titledInfoRows = infoRows.filter((node) => typeof node.props?.title === 'string');
        expect(titledInfoRows.length).toBeGreaterThan(0);
        expect(titledInfoRows[0]?.props?.title).toBe('newSession.pathPicker.truncatedDirectoryInfo:1');
    });

    it('publishes no card container of its own and hands both footer actions to the shared chrome', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        // The card is the shared chrome's: the browser names it and publishes no container of its own.
        expect(screen.findByTestId(PATH_BROWSER_MODAL_TEST_ID)?.type).toBe('ChromeHost');

        const footerButtons = screen.findAll((node) => {
            return node.props?.title === 'common.cancel' || node.props?.title === 'common.use';
        });
        expect(new Set(footerButtons.map((node) => node.props.title))).toEqual(new Set(['common.cancel', 'common.use']));
    });

    it('does not republish card chrome on iOS when the host re-renders after applying it', async () => {
        platformOS.current = 'ios';
        let publishCount = 0;
        const host: { rerender?: () => void } = {};

        // Like the modal host, every applied chrome update re-renders the host.
        function Harness() {
            const [, forceRender] = React.useReducer((value: number) => value + 1, 0);
            React.useEffect(() => {
                host.rerender = forceRender;
            }, []);
            const setChrome = React.useCallback(() => {
                publishCount += 1;
                forceRender();
            }, []);
            const onClose = React.useCallback(() => {}, []);
            const onResolve = React.useCallback(() => {}, []);
            return <MachinePathBrowserModal machineId="machine-1" onClose={onClose} onResolve={onResolve} setChrome={setChrome} />;
        }

        await renderScreen(<Harness />);
        await flushHookEffects({ cycles: 8, turns: 2 });
        const settledPublishCount = publishCount;
        expect(settledPublishCount).toBeGreaterThan(0);

        await act(async () => {
            host.rerender?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(publishCount).toBe(settledPublishCount);
    });

    it('requests body-owned scrolling when rendered through shared modal chrome', async () => {
        let chrome: unknown = null;
        const setChrome = vi.fn((next: unknown) => {
            chrome = next;
        });

        await renderScreen(<MachinePathBrowserView
                    machineId="machine-1"
                    variant="modal"
                    interaction="confirm"
                    setChrome={setChrome}
                    onPickPath={vi.fn()}
                    onRequestClose={vi.fn()}
                />);

        expect(setChrome).toHaveBeenCalled();
        expect(chrome).toEqual(expect.objectContaining({
            kind: 'card',
            scrollHost: 'body',
            dimensions: {
                size: 'lg',
                width: 560,
                maxHeightRatio: 0.96,
                viewportMargin: { horizontal: 12, vertical: 12 },
            },
        }));
    });

    it.each(['off', 'ask', 'allowed'] as const)('admits New folder through the rooted Action under %s policy', async mode => {
        const scope = await setFolderActionPolicy(mode);
        modalPromptMock.mockResolvedValueOnce('new-folder');

        const screen = await renderInModalChrome(<MachinePathBrowserModal
            machineId="machine-1"
            onResolve={vi.fn()}
            onClose={vi.fn()}
        />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));

        await screen.pressByTestIdAsync(PATH_BROWSER_CREATE_FOLDER_TEST_ID);
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(modalPromptMock).toHaveBeenCalledWith('files.createFolderPromptTitle', '/Users', expect.anything());

        if (mode === 'allowed') {
            await vi.waitFor(() => expect(folderActionRequests).toContainEqual(expect.objectContaining({
                machineId: 'machine-1', input: { rootPath: '/Users', path: '/Users/new-folder' },
            })));
            expect(machineCreateDirectoryMock).toHaveBeenCalledWith('machine-1', '/Users/new-folder', expect.anything());
            expect(modalAlertMock).not.toHaveBeenCalled();
        } else {
            await vi.waitFor(() => expect(modalAlertMock).toHaveBeenCalled());
            expect(machineCreateDirectoryMock).not.toHaveBeenCalled();
            expect(machineRequests.some(request => request.method.endsWith(`:${RPC_METHODS.CREATE_DIRECTORY}`))).toBe(false);
            expect(folderActionRequests).toEqual([]);
            if (mode === 'ask') {
                // Own-UI Ask uses local confirmation; the declined review creates no Artifact.
                expect(actualModal.confirm).toHaveBeenCalledTimes(1);
                expect(homes.artifacts(scope.serverId).list()).toHaveLength(0);
            }
        }
    });

    it('cancels an admitted folder request when its picker unmounts', async () => {
        let finishRequest = () => {};
        machineCreateDirectoryMock.mockImplementationOnce(async () => new Promise<{ success: true }>(resolve => {
            finishRequest = () => resolve({ success: true });
        }));
        modalPromptMock.mockResolvedValueOnce('new-folder');
        const screen = await renderInModalChrome(<MachinePathBrowserModal
            machineId="machine-1" initialPath="/Users" onResolve={vi.fn()} onClose={vi.fn()} />);
        try {
            await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
            await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));
            await screen.pressByTestIdAsync(PATH_BROWSER_CREATE_FOLDER_TEST_ID);
            await vi.waitFor(() => expect(machineCreateDirectoryMock).toHaveBeenCalled());
            const options = machineCreateDirectoryMock.mock.calls[0]?.[2];
            if (!options || typeof options !== 'object' || !('signal' in options) || !(options.signal instanceof AbortSignal)) {
                throw new Error('Expected the daemon request cancellation lifetime');
            }
            const signal = options.signal;
            expect(signal.aborted).toBe(false);
            await screen.unmount();
            await vi.waitFor(() => expect(signal.aborted).toBe(true));
            expect(modalAlertMock).not.toHaveBeenCalled();
        } finally {
            await act(async () => { finishRequest(); });
        }
    });

    it('opens a context menu on right click and creates a folder in the clicked directory', async () => {
        modalPromptMock.mockResolvedValueOnce('child');

        const screen = await renderInModalChrome(<MachinePathBrowserModal
            machineId="machine-1"
            selectionMode="file"
            includeFiles={true}
            onResolve={vi.fn()}
            onClose={vi.fn()}
        />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        const confirmBefore = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(confirmBefore?.props.disabled).toBe(true);

        const usersRow = await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(usersRow, 'onContextMenu', { preventDefault, stopPropagation });
        });

        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();

        await waitForTestId(screen, 'dropdown-option-create-folder');

        const confirmAfter = screen.findByTestId(PATH_BROWSER_CONFIRM_TEST_ID);
        expect(confirmAfter?.props.disabled).toBe(true);

        await screen.pressByTestIdAsync('dropdown-option-create-folder');
        // Folder creation admits the menu command before it closes the current directory menu.
        await act(async () => {
            await vi.waitFor(() => expect(machineCreateDirectoryMock).toHaveBeenCalledWith(
                'machine-1',
                '/Users/child',
                expect.anything(),
            ));
        });
    });

    it('uses context-menu semantics instead of row long-press on web to avoid delayed tap selection', async () => {

        const screen = await renderInModalChrome(<MachinePathBrowserModal
            machineId="machine-1"
            onResolve={vi.fn()}
            onClose={vi.fn()}
        />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        const usersRow = await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        expect(usersRow).toBeTruthy();
        if (!usersRow) {
            return;
        }
        expect(usersRow.props.onContextMenu).toBeTypeOf('function');
        expect(usersRow.props.onLongPress).toBeUndefined();
    });
});
