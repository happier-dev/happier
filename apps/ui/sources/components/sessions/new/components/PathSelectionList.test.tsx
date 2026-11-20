import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import type { AppTextProps, AppTextInputProps } from '@/components/ui/text/Text';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import { installSessionOpsNetworkBoundary, type SessionOpsRpcRequest } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { DaemonFilesystemListDirectoryRequestSchema, DaemonFilesystemListDirectoryResponseSchema,
    type DaemonFilesystemListDirectoryResponse } from '@happier-dev/protocol/machines/fileBrowser';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionIdsV1';
import { DaemonWorkspaceFileListRequestSchema, type DaemonWorkspaceFileListRequest,
    type DaemonWorkspaceFileListResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
    }),
});

// The Account Action HTTP reply is the network boundary; sorting, caching,
// Home/Account admission and the picker lifecycle remain real.
const openMachinePathBrowserModalMock = vi.hoisted(() => vi.fn());
type DirectoryReply = (Pick<Extract<DaemonFilesystemListDirectoryResponse, { ok: true }>, 'ok' | 'entries'>
    & Partial<Pick<Extract<DaemonFilesystemListDirectoryResponse, { ok: true }>, 'truncated'>>)
    | Extract<DaemonFilesystemListDirectoryResponse, { ok: false }>;
type DirectoryRequest = Pick<SessionOpsRpcRequest, 'serverUrl' | 'targetId' | 'method' | 'payload'>;
const listMachineFileBrowserDirectoryEntriesMock = vi.hoisted(() => vi.fn<(request: DirectoryRequest) => Promise<DirectoryReply>>());
const listWorkspaceFilesMock = vi.hoisted(() => vi.fn<(request: DaemonWorkspaceFileListRequest) => Promise<DaemonWorkspaceFileListResponse>>());

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (input: unknown) => openMachinePathBrowserModalMock(input),
}));

const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
let accountScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
afterAll(() => network.dispose());
afterEach(() => { accountScope?.dispose(); accountScope = null; });

beforeEach(async () => {
    openMachinePathBrowserModalMock.mockReset();
    listMachineFileBrowserDirectoryEntriesMock.mockReset().mockResolvedValue({ ok: true, entries: [] });
    listWorkspaceFilesMock.mockReset().mockResolvedValue({ ok: true, paths: [], truncated: false });
    network.resetRequests();
    const home = await network.addHome('https://srv-a', 'account-a', { serverIdentityId: 'srv_a' });
    await network.addHome('https://srv-b', 'account-b', { serverIdentityId: 'srv_b' });
    await network.addHome('https://srv-1', 'account-c', { serverIdentityId: 'srv_1' });
    const boundaries = await Promise.all([
        { serverUrl: 'https://srv-a', serverIdentityId: 'srv_a', accountId: 'account-a' },
        { serverUrl: 'https://srv-b', serverIdentityId: 'srv_b', accountId: 'account-b' },
        { serverUrl: 'https://srv-1', serverIdentityId: 'srv_1', accountId: 'account-c' },
    ].map(params => createExternalActionAccountHttpBoundary({
        ...params, machineId: 'm-1', actionId: FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory, tokenEpoch: 0,
        execute: async (input, context) => {
            const payload = DaemonFilesystemListDirectoryRequestSchema.parse(input);
            const reply = await listMachineFileBrowserDirectoryEntriesMock({
                serverUrl: params.serverUrl, targetId: context.target.machineId,
                method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY, payload,
            });
            return DaemonFilesystemListDirectoryResponseSchema.parse(reply.ok
                ? { path: payload.path, truncated: false, ...reply } : reply);
        },
    })));
    // The same Machine answers the folder-name lookup (`daemon.filesystem.listFiles`).
    boundaries.push(await createExternalActionAccountHttpBoundary({
        serverUrl: 'https://srv-1', serverIdentityId: 'srv_1', accountId: 'account-c',
        machineId: 'm-1', actionId: FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles, tokenEpoch: 0,
        execute: async (input) => listWorkspaceFilesMock(DaemonWorkspaceFileListRequestSchema.parse(input)),
    }));
    network.setHttpResponder(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === 'https://srv-1' && url.pathname === '/v1/machines/read-batch') {
            return createMachineReadBatchResponseFixture(init?.body, id => id === 'member-machine'
                ? createPlainMachineRowFixture({ id, accountId: 'account-c' })
                : boundaries[2]!.machine.id === id ? boundaries[2]!.machine : null);
        }
        for (const boundary of boundaries) {
            const response = await boundary.handle(url, init);
            if (response) return response;
        }
        return null;
    });
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    await setActiveServerId(home.id);
    accountScope = await activateStorageAccountScope({ serverId: home.id, accountId: home.accountId });
    network.setRpcAckResponder(async () => ({
        ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    }));
});

// The canonical `@/components/ui/text/Text` primitive depends on
// `useLocalSetting('uiFontScale')` and Typography defaults that are not
// available in this lightweight render environment. The mock is narrowed to
// the real prop contract (`AppTextProps` / `AppTextInputProps`) so prop drift
// still fails compilation instead of being silently absorbed by `any`-typed
// stubs.
vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: AppTextProps) =>
        React.createElement('Text', props, children),
    TextInput: React.forwardRef<unknown, AppTextInputProps>((props, ref) =>
        React.createElement('TextInput', { ...props, ref }),
    ),
}));

// Typed helpers for narrow prop-peek assertions on rendered host nodes.
// `react-test-renderer`'s `ReactTestInstance.props` is typed as `{ [k]: any }`,
// so this helper preserves the existing escape-hatch shape while letting each
// call site name the specific contract it is asserting against.
type DisabledLikeProps = Readonly<{
    disabled?: boolean;
    accessibilityState?: Readonly<{ disabled?: boolean }>;
}>;
type ValueLikeProps = Readonly<{ value?: string }>;
type PressableLikeProps = Readonly<{ onPress?: () => void }>;
type SelectableLikeProps = Readonly<{
    accessibilityState?: Readonly<{ selected?: boolean }>;
    'aria-pressed'?: boolean;
    accessibilityLabel?: string;
}>;
type StyleLikeProps = Readonly<{ style?: unknown }>;
type TextLikeProps = Readonly<{
    children?: unknown;
    ellipsizeMode?: 'head' | 'middle' | 'tail' | 'clip';
}>;
type OptionWrapperLikeProps = Readonly<{ 'aria-selected'?: boolean }>;
type ComboboxLikeProps = Readonly<{ 'aria-activedescendant'?: string }>;

function flattenStyle(props: StyleLikeProps): Record<string, unknown> {
    const style = props.style;
    if (Array.isArray(style)) {
        return Object.assign(
            {} as Record<string, unknown>,
            ...style.filter(Boolean).map((entry) => entry as Record<string, unknown>),
        );
    }
    return (style as Record<string, unknown> | undefined) ?? {};
}

function readProps<P>(node: ReactTestInstance): P {
    return node.props as P;
}

function selectedOptionState(screen: Awaited<ReturnType<typeof renderScreen>>, optionId: string): boolean {
    // The option's ARIA owner may be an inner gridcell rather than its layout row.
    const owner = screen.tree.root.findAll((node) => typeof node.type === 'string'
        && node.props.id === optionId && typeof node.props['aria-selected'] === 'boolean')[0];
    if (!owner) throw new Error(`Missing selected-state owner for ${optionId}`);
    return readProps<OptionWrapperLikeProps>(owner)['aria-selected']!;
}

function createInputNodeMock(focus: () => void) {
    return (element: { type: unknown }) => {
        if (element.type !== 'TextInput') return {};
        return {
            focus,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
    };
}

function flattenTextChildren(children: unknown): string {
    if (typeof children === 'string' || typeof children === 'number') return String(children);
    if (React.isValidElement(children)) {
        return flattenTextChildren((children.props as { children?: unknown }).children);
    }
    if (!Array.isArray(children)) return '';
    return children.map(flattenTextChildren).join('');
}

function findTextNodeByContent(root: ReactTestInstance, text: string): ReactTestInstance | undefined {
    return root.findAll((node) => {
        const nodeType: unknown = node.type;
        return nodeType === 'Text';
    }).find((node) => {
        return flattenTextChildren(readProps<TextLikeProps>(node).children) === text;
    });
}

async function flushPathSelectionDynamicResolver() {
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
}

describe('PathSelectionList', () => {
    it.each(['~', '~\\projects/child', ''])('keeps authored home intent %s through folder Enter and target preflight', async (intent) => {
        const expectedIntent = intent || '~';
        const { PathSelectionList } = await import('./PathSelectionList');
        const { useNewSessionDirectoryPreflight } = await import('../hooks/screenModel/useNewSessionDirectoryPreflight');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
        const { Text } = await import('@/components/ui/text/Text');
        const home = await network.addHome('https://srv-1', 'account-c', { serverIdentityId: 'srv_1' });
        const serverId = resolveServerProfileScopeId(home);
        network.setRpcAckResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
                const directory = (request.payload as { directory: { path: string } }).directory;
                return { ok: true, result: directory.path === expectedIntent
                    ? { ok: true, directory: '/member/home', directoryKind: 'path', directoryCreationRequired: false, checkout: null }
                    : { ok: false, code: 'invalid_directory' } };
            }
            return { ok: true, result: { ok: true, path: '~', entries: [], truncated: false } };
        });
        function FolderEntry() {
            const [path, setPath] = React.useState('');
            const { binding } = useServerCredentialAccountScopeBinding(serverId);
            const preflight = useNewSessionDirectoryPreflight({ machineId: 'member-machine', binding,
                enabled: Boolean(path), requesterReady: true, path });
            return <>
                <PathSelectionList initialValue="" initialSuggestionMode="history" favorites={[]} recents={[]}
                    machineHomeDir="/home/happier.guest" machineId="member-machine" serverId={serverId}
                    machinePlatform="unix" onCommit={setPath} onRequestClose={() => {}} />
                <Text>{path && preflight.ready ? 'folder-ready' : 'folder-pending'}</Text>
            </>;
        }
        // The web TextInput owns a DOM keydown listener rather than an RN
        // onKeyPress prop. Exercise that native input boundary as the browser does.
        const inputTarget = new EventTarget();
        const screen = await renderScreen(<FolderEntry />, {
            createNodeMock: element => element.type === 'TextInput' ? {
                focus() {},
                addEventListener: inputTarget.addEventListener.bind(inputTarget),
                removeEventListener: inputTarget.removeEventListener.bind(inputTarget),
            } : {},
        });
        try {
            await act(async () => {
                screen.changeTextByTestId('path-selection-list:header:input', intent);
            });
            await act(async () => {
                inputTarget.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter' }));
            });
            await vi.waitFor(() => expect(network.requests.some(request =>
                request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT)).toBe(true));
            expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT))
                .toEqual([expect.objectContaining({ payload: { directory: { kind: 'path', path: expectedIntent } } })]);
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('folder-ready'));
        } finally { await screen.unmount(); }
    });

    it('names saved member workspaces without showing their digest and commits the real directory', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const digest = 'a'.repeat(64);
        const workspace = `/srv/happier/members/${digest}`;
        const onCommit = vi.fn();
        const screen = await renderScreen(<PathSelectionList
            initialValue={workspace} initialSuggestionMode="history"
            favorites={[{ path: workspace }]} recents={[{ path: `${workspace}/api`, lastUsedAt: 1 }]}
            machineHomeDir="/home/member" machineId={null} serverId={null} machinePlatform="unix"
            onCommit={onCommit} onRequestClose={() => {}}
        />);
        try {
            expect(screen.getTextContent()).toContain(t('workspacePresentation.memberWorkspace'));
            expect(screen.getTextContent()).not.toContain(digest);
            const input = screen.findByTestId('path-selection-list:header:input');
            expect(readProps<ValueLikeProps>(input!).value).toBe('');
            expect(input!.props.placeholder).toBe(t('workspacePresentation.memberWorkspace'));
            await act(async () => {
                readProps<PressableLikeProps>(screen.findByTestId(`path-selection-list:path-root:option:favorite:${workspace}`)!).onPress?.();
            });
            expect(onCommit).toHaveBeenCalledWith(workspace);
        } finally {
            await screen.unmount();
        }
    });

    it('renders favorites and recent sections rooted under the path-selection-list testID', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');

        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[{ path: '/Users/leeroy/fav-one' }]}
                recents={[{ path: '/Users/leeroy/recent-one', lastUsedAt: 1 }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        expect(screen.findByTestId('path-selection-list')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:section:favorites')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:section:recent')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:path-root:option:favorite:/Users/leeroy/fav-one')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:path-root:option:recent:/Users/leeroy/recent-one')).not.toBeNull();
        act(() => screen.tree.unmount());
    });

    it('offers “No folder” as the first row, above saved folders, and marks it when chosen', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const onSelectNoFolder = vi.fn();
        const onCommit = vi.fn();
        const render = (selected: boolean) => renderScreen(
            <PathSelectionList
                initialValue=""
                initialSuggestionMode="history"
                favorites={[{ path: '/Users/leeroy/fav-one' }]}
                recents={[{ path: '/Users/leeroy/recent-one', lastUsedAt: 1 }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={onCommit}
                onRequestClose={() => {}}
                noFolderOption={{ selected, onSelect: onSelectNoFolder }}
            />,
        );
        const screen = await render(false);
        const optionIds = screen.tree.root
            .findAll((node) => typeof node.props?.testID === 'string'
                && node.props.testID.startsWith('path-selection-list:path-root:option:')
                && !node.props.testID.includes(':favorite-toggle'))
            .map((node) => node.props.testID as string);
        expect(optionIds[0]).toBe('path-selection-list:path-root:option:no-folder');
        expect(selectedOptionState(screen, 'path-selection-list:path-root:option:no-folder')).toBe(false);

        await act(async () => {
            readProps<PressableLikeProps>(screen.findByTestId('path-selection-list:path-root:option:no-folder')!).onPress?.();
        });
        expect(onSelectNoFolder).toHaveBeenCalledTimes(1);
        expect(onCommit).not.toHaveBeenCalled();
        act(() => screen.tree.unmount());

        const selectedScreen = await render(true);
        expect(selectedOptionState(selectedScreen, 'path-selection-list:path-root:option:no-folder')).toBe(true);
        act(() => selectedScreen.tree.unmount());
    });

    it('omits recent rows that resolve to visible favorites and dedupes recent path variants', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const recentRowTestId = 'path-selection-list:path-root:option:recent:/Users/leeroy/recent';

        const baselineScreen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[{ path: '~/proj' }]}
                recents={[{ path: '/Users/leeroy/recent', lastUsedAt: 1 }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        const singleRecentRenderNodeCount = baselineScreen.findAllByTestId(recentRowTestId).length;
        expect(singleRecentRenderNodeCount).toBeGreaterThan(0);
        act(() => baselineScreen.tree.unmount());

        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[{ path: '~/proj' }]}
                recents={[
                    { path: '/Users/leeroy/proj', lastUsedAt: 3 },
                    { path: '/Users/leeroy/recent', lastUsedAt: 2 },
                    { path: '~/recent', lastUsedAt: 1 },
                ]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        expect(screen.findByTestId('path-selection-list:path-root:option:favorite:/Users/leeroy/proj')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:path-root:option:recent:/Users/leeroy/proj')).toBeNull();
        expect(screen.findAllByTestId(recentRowTestId)).toHaveLength(singleRecentRenderNodeCount);
        act(() => screen.tree.unmount());
    });

    it('uses maxHeight as a cap without forcing the popover to its maximum height', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');

        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                maxHeight={300}
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        const root = screen.findByTestId('path-selection-list') as unknown as { props: { style?: unknown } };
        const flat = flattenStyle(root.props);

        expect(flat.maxHeight).toBe(300);
        expect(flat.height).toBeUndefined();
        act(() => screen.tree.unmount());
    });

    it('focuses the path input on web so the popover is immediately keyboard-ready', async () => {
        const focus = vi.fn();
        const { PathSelectionList } = await import('./PathSelectionList');

        await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
            { createNodeMock: createInputNodeMock(focus) },
        );

        expect(focus).toHaveBeenCalled();
    });

    it('leaves focus alone when embedded in a page form, so opening the page does not scroll to the field', async () => {
        const focus = vi.fn();
        const { PathSelectionList } = await import('./PathSelectionList');

        await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                autoFocusInput={false}
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
            { createNodeMock: createInputNodeMock(focus) },
        );

        expect(focus).not.toHaveBeenCalled();
    });

    it('does not render the IN THIS FOLDER section when the input is empty (idle state)', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        expect(screen.findByTestId('path-selection-list:section:in-this-folder')).toBeNull();
        act(() => screen.tree.unmount());
    });

    it('history-first mode displays the selected path while showing favorites and recents without browsing it', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true,
            entries: [
                { type: 'directory', name: 'current-child', path: '/Users/leeroy/current/current-child' },
            ],
        });
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="/Users/leeroy/current"
                initialSuggestionMode="history"
                favorites={[{ path: '/Users/leeroy/fav-one' }]}
                recents={[{ path: '/Users/leeroy/recent-one', lastUsedAt: 1 }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        await flushPathSelectionDynamicResolver();

        expect(listMachineFileBrowserDirectoryEntriesMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('path-selection-list:section:in-this-folder')).toBeNull();
        expect(screen.findByTestId('path-selection-list:path-root:option:favorite:/Users/leeroy/fav-one')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:path-root:option:recent:/Users/leeroy/recent-one')).not.toBeNull();
        const input = screen.findByTestId('path-selection-list:header:input');
        expect(input).not.toBeNull();
        expect(readProps<ValueLikeProps>(input!).value).toBe('/Users/leeroy/current');
        act(() => screen.tree.unmount());
    });

    it('history-first mode retains the displayed selection as favorites and recents arrive across sections', async () => {
        const currentPath = '/Users/leeroy/Documents/Development/happier/dev';
        const firstPath = '/Users/leeroy/Documents/Development/happier/remote-dev';
        const { PathSelectionList } = await import('./PathSelectionList');
        const render = (settled: boolean) => (
            <PathSelectionList
                initialValue={currentPath}
                initialSuggestionMode="history"
                favorites={settled ? [{ path: firstPath }] : []}
                recents={settled ? [{ path: currentPath, lastUsedAt: 1 }] : []}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />
        );
        const screen = await renderScreen(render(false));
        expect(screen.findByTestId('path-selection-list:header:input')?.props.value).toBe(currentPath);
        expect(screen.findByTestId(`path-selection-list:path-root:option-wrapper:recent:${currentPath}`)).toBeNull();
        await screen.update(render(true));

        const firstWrapper = screen.findByTestId(
            `path-selection-list:path-root:option-wrapper:favorite:${firstPath}`,
        );
        const currentWrapper = screen.findByTestId(
            `path-selection-list:path-root:option-wrapper:recent:${currentPath}`,
        );
        const input = screen.findByTestId('path-selection-list:header:input');

        expect(firstWrapper).not.toBeNull();
        expect(currentWrapper).not.toBeNull();
        expect(selectedOptionState(screen, `path-selection-list:path-root:option:favorite:${firstPath}`)).toBe(false);
        expect(selectedOptionState(screen, `path-selection-list:path-root:option:recent:${currentPath}`)).toBe(true);
        expect(readProps<ComboboxLikeProps>(input!)['aria-activedescendant']).toBe(
            `path-selection-list:path-root:option:recent:${currentPath}`,
        );
        act(() => screen.tree.unmount());
    });

    it.each(['/Users/leeroy/current', '~/current'])('history-first mode browses selected folder %s after plain child text', async (initialValue) => {
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
            ok: true,
            entries: [
                { type: 'directory', name: 'Documents', path: '/Users/leeroy/current/Documents' },
                { type: 'directory', name: 'Archive', path: '/Users/leeroy/current/Archive' },
            ],
        });
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue={initialValue}
                initialSuggestionMode="history"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId="srv_1"
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        await act(async () => {
            screen.changeTextByTestId('path-selection-list:header:input', 'Doc');
        });
        await flushPathSelectionDynamicResolver();

        expect(listMachineFileBrowserDirectoryEntriesMock).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'm-1',
            serverUrl: 'https://srv-1',
            payload: expect.objectContaining({ path: initialValue, includeFiles: false }),
        }));
        expect(screen.findByTestId(
            'path-selection-list:path-root:option:in-folder:/Users/leeroy/current/Documents',
        )).not.toBeNull();
        expect(screen.findByTestId(
            'path-selection-list:path-root:option:in-folder:/Users/leeroy/current/Archive',
        )).toBeNull();
        act(() => screen.tree.unmount());
    });

    it('finds a typed name past the first listing page of a capped folder by asking the Machine (QA-BREADTH Q11)', async () => {
        // `/tmp` lists more folders than one page carries (`truncated`); the typed one is not on the page.
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({ ok: true, truncated: true,
            entries: Array.from({ length: 3 }, (_, index) => ({ type: 'directory' as const, name: `a-${index}`, path: `/tmp/a-${index}` })) });
        listWorkspaceFilesMock.mockResolvedValue({ ok: true, paths: ['p03-qab-join/', 'p03-qab-join2/'], truncated: false });
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList initialValue="/tmp/" initialSuggestionMode="browse" favorites={[]} recents={[]}
                machineHomeDir="/home/me" machineId="m-1" serverId="srv_1" machinePlatform="unix"
                onCommit={() => {}} onRequestClose={() => {}} />,
        );
        await act(async () => { screen.changeTextByTestId('path-selection-list:header:input', '/tmp/'); });
        await flushPathSelectionDynamicResolver();
        await act(async () => { screen.changeTextByTestId('path-selection-list:header:input', '/tmp/p03-qab-join'); });
        await flushPathSelectionDynamicResolver();
        await flushPathSelectionDynamicResolver();

        expect(screen.findByTestId('path-selection-list:path-root:option:in-folder:/tmp/p03-qab-join2')).not.toBeNull();
        expect(screen.findByTestId('path-selection-list:path-root:option:in-folder:/tmp/a-1')).toBeNull();
        // The capped folder was listed once, not once per keystroke; the typed name was looked up once.
        expect(listMachineFileBrowserDirectoryEntriesMock).toHaveBeenCalledTimes(1);
        expect(listWorkspaceFilesMock).toHaveBeenCalledTimes(1);
        expect(listWorkspaceFilesMock.mock.calls[0]?.[0]).toMatchObject(
            { rootPath: '/tmp', query: 'p03-qab-join', resultType: 'folder', maxDepth: 1 });
        act(() => screen.tree.unmount());
    });

    it('claims no missing folder when there is no machine to look in (one still to be created)', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="/Users/leeroy/current"
                initialSuggestionMode="history"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId={null}
                serverId="srv_1"
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('path-selection-list:header:input', 'recipe-box');
        });
        await flushPathSelectionDynamicResolver();

        const { t } = await import('@/text');
        expect(screen.getTextContent()).not.toContain(t('newSession.pathPicker.emptyNewFolder'));
        expect(screen.getTextContent()).toContain(t('newSession.pathPicker.typedPathOnly'));
        act(() => screen.tree.unmount());
    });

    it('tells the person that Enter uses a typed folder that does not exist yet, instead of a bare "No matches"', async () => {
        // Live 2026-10-16 (PLUGVIS r2k/r2l): typing a new folder name showed only "No matches".
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
            ok: true,
            entries: [{ type: 'directory', name: 'Archive', path: '/Users/leeroy/current/Archive' }],
        });
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="/Users/leeroy/current"
                initialSuggestionMode="history"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId="srv_1"
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        await act(async () => {
            screen.changeTextByTestId('path-selection-list:header:input', 'recipe-box');
        });
        await flushPathSelectionDynamicResolver();

        const { t } = await import('@/text');
        expect(screen.getTextContent()).toContain(t('newSession.pathPicker.emptyNewFolder'));
        expect(screen.getTextContent()).not.toContain(t('selectionList.emptyMatch'));
        act(() => screen.tree.unmount());
    });

    it('opens the machine path browser modal with the authored home intent as initialPath', async () => {
        openMachinePathBrowserModalMock.mockResolvedValueOnce('/Users/leeroy/picked');
        const onCommit = vi.fn();
        const { PathSelectionList } = await import('./PathSelectionList');

        const screen = await renderScreen(
            <PathSelectionList
                initialValue="~/sub"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId="srv_1"
                machinePlatform="unix"
                onCommit={onCommit}
                onRequestClose={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('path-selection-list:open-tree-browser');

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledTimes(1);
        expect(openMachinePathBrowserModalMock.mock.calls[0]![0]).toEqual(expect.objectContaining({
            machineId: 'm-1',
            serverId: 'srv_1',
            initialPath: '~/sub',
        }));
        // resolved → onCommit called with the modal-returned absolute path
        expect(onCommit).toHaveBeenCalledWith('/Users/leeroy/picked');
        act(() => screen.tree.unmount());
    });

    it('opens the machine path browser modal inside the current modal portal target', async () => {
        const webPortalTarget = { nodeType: 1 } as Element;
        openMachinePathBrowserModalMock.mockResolvedValueOnce(null);
        const { PathSelectionList } = await import('./PathSelectionList');

        const screen = await renderScreen(
            <ModalPortalTargetProvider target={webPortalTarget}>
                <PathSelectionList
                    initialValue="~/sub"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId="srv_1"
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                />
            </ModalPortalTargetProvider>,
        );

        await screen.pressByTestIdAsync('path-selection-list:open-tree-browser');

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledTimes(1);
        expect(openMachinePathBrowserModalMock.mock.calls[0]![0]).toEqual(expect.objectContaining({
            webPortalTarget,
        }));
        act(() => screen.tree.unmount());
    });

    it('awaits the pre-browse callback before opening the path browser modal', async () => {
        const callOrder: string[] = [];
        const onBeforeBrowseMachinePath = vi.fn(async () => {
            await Promise.resolve();
            callOrder.push('before');
        });
        openMachinePathBrowserModalMock.mockImplementationOnce(async () => {
            callOrder.push('open');
            return null;
        });
        const { PathSelectionList } = await import('./PathSelectionList');

        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
                onBeforeBrowseMachinePath={onBeforeBrowseMachinePath}
            />,
        );

        await screen.pressByTestIdAsync('path-selection-list:open-tree-browser');

        expect(onBeforeBrowseMachinePath).toHaveBeenCalledTimes(1);
        expect(callOrder).toEqual(['before', 'open']);
        act(() => screen.tree.unmount());
    });

    it('disables the open-tree-browser button when no machine is bound', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId={null}
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        const button = screen.findByTestId('path-selection-list:open-tree-browser');
        expect(button).not.toBeNull();
        const buttonProps = readProps<DisabledLikeProps>(button!);
        // Disabled when no machine
        expect(buttonProps.disabled === true || buttonProps.accessibilityState?.disabled === true).toBe(true);
        act(() => screen.tree.unmount());
    });

    it.each(['favorite', 'recent'] as const)('retains home intent when the user presses a %s row', async (kind) => {
        const onCommit = vi.fn();
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={kind === 'favorite' ? [{ path: '~/fav' }] : []}
                recents={kind === 'recent' ? [{ path: '~/fav', lastUsedAt: 1 }] : []}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={onCommit}
                onRequestClose={() => {}}
            />,
        );
        await screen.pressByTestIdAsync(`path-selection-list:path-root:option:${kind}:/Users/leeroy/fav`);
        expect(onCommit).toHaveBeenCalledWith('~/fav');
        act(() => screen.tree.unmount());
    });

    it('Bug 4a: fires onCommit exactly once per row press (no double-commit)', async () => {
        const onCommit = vi.fn();
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[{ path: '~/fav' }]}
                recents={[{ path: '~/recent', lastUsedAt: 1 }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={onCommit}
                onRequestClose={() => {}}
            />,
        );
        await screen.pressByTestIdAsync('path-selection-list:path-root:option:favorite:/Users/leeroy/fav');
        expect(onCommit).toHaveBeenCalledTimes(1);

        onCommit.mockClear();
        await screen.pressByTestIdAsync('path-selection-list:path-root:option:recent:/Users/leeroy/recent');
        expect(onCommit).toHaveBeenCalledTimes(1);
        act(() => screen.tree.unmount());
    });

    it('R13 Fix 2: does NOT mount a duplicate folder-icon prefix (search icon already serves the leading slot)', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        // The input-prefix slot rendered by SelectionListSearchHeader exists
        // ONLY when an inputPrefix is provided. PathSelectionList must not
        // provide one — the search icon in the leading slot already serves the
        // visual role and a second prefix produces a double-leading-icon.
        const prefixSlot = screen.findByTestId('path-selection-list:header:input-prefix');
        expect(prefixSlot).toBeNull();
        act(() => screen.tree.unmount());
    });

    it('renders the header path value with start ellipsis', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const selectedPath = '/Users/leeroy/Documents/Development/happier/remote-dev';
        const screen = await renderScreen(
            <PathSelectionList
                initialValue={selectedPath}
                initialSuggestionMode="history"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const visibleValue = screen.findByTestId('path-selection-list:header:input:start-ellipsis');
        expect(visibleValue).not.toBeNull();
        const visibleValueProps = readProps<TextLikeProps>(visibleValue!);
        expect(visibleValueProps.ellipsizeMode).toBe('head');
        expect(flattenTextChildren(visibleValueProps.children)).toBe(selectedPath);
        act(() => screen.tree.unmount());
    });

    it('renders saved path rows with start ellipsis', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const absolutePath = '/Users/leeroy/Documents/Development/happier/remote-dev';
        const displayPath = '~/Documents/Development/happier/remote-dev';
        const label = 'Saved project';
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[{ path: absolutePath, label }]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const title = findTextNodeByContent(screen.tree.root, label);
        const subtitle = findTextNodeByContent(screen.tree.root, displayPath);
        expect(title).not.toBeUndefined();
        expect(subtitle).not.toBeUndefined();
        expect(readProps<TextLikeProps>(title!).ellipsizeMode).toBe('head');
        expect(readProps<TextLikeProps>(subtitle!).ellipsizeMode).toBe('head');
        act(() => screen.tree.unmount());
    });

    it('aligns section headers with path row text', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[{ path: '/Users/leeroy/fav-one' }]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const header = screen.findByTestId('path-selection-list:section:favorites:header');
        expect(header).not.toBeNull();
        const headerStyle = flattenStyle(readProps<StyleLikeProps>(header!));
        expect(headerStyle.paddingHorizontal).toBe(16);
        expect(Number(headerStyle.paddingTop)).toBeLessThanOrEqual(16);
        act(() => screen.tree.unmount());
    });

    it('keeps the browse suffix flush with the header edge', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const suffixSlot = screen.findByTestId('path-selection-list:header:input-suffix');
        expect(suffixSlot).not.toBeNull();
        const suffixStyle = flattenStyle(readProps<StyleLikeProps>(suffixSlot!));
        expect(suffixStyle.marginRight ?? 0).toBe(0);
        act(() => screen.tree.unmount());
    });

    it('Bug 4e: resyncs the input value when the parent changes initialValue identity', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="/foo"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        const input = screen.findByTestId('path-selection-list:header:input');
        expect(input).not.toBeNull();
        expect(readProps<ValueLikeProps>(input!).value).toBe('/foo');

        await act(async () => {
            await screen.update(
                <PathSelectionList
                    initialValue="/bar"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                />,
            );
        });

        const inputAfter = screen.findByTestId('path-selection-list:header:input');
        expect(readProps<ValueLikeProps>(inputAfter!).value).toBe('/bar');
        act(() => screen.tree.unmount());
    });

    it('R16a: IN THIS FOLDER section does NOT flicker loading-skeleton when the parent re-renders with new closures', async () => {
        // Simulates the real-world bug: the parent (e.g. NewSessionScreen)
        // re-renders frequently and hands PathSelectionList a fresh `onCommit`
        // closure plus a fresh `recents` array each render. Under R9's
        // WeakMap-tagged resolver-token approach, every re-render flipped
        // descriptorIdentityKey → invalidated cache → flashed loading
        // skeleton. R16a stabilizes the resolver via refs + opt-in
        // `resolverKey`, so the cache stays warm across these re-renders.
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
            ok: true,
            entries: [
                { type: 'directory', name: 'Documents', path: '/Users/leeroy/Documents' },
            ],
        });
        const { PathSelectionList } = await import('./PathSelectionList');

        // Track how many times the resolver actually fires. After the initial
        // load, parent re-renders MUST NOT trigger additional fetches (and
        // therefore MUST NOT flash the loading skeleton).
        const renderHarness = (renderIdx: number) => (
            <PathSelectionList
                initialValue="~/"
                favorites={[]}
                // Churn the recents array identity each render — this is what
                // caused R9's invalidation under the WeakMap-resolver approach.
                recents={[{ path: `~/recent-${renderIdx}`, lastUsedAt: renderIdx }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                // Fresh closure each render — under the old contract this
                // would invalidate the cached state and flash the skeleton.
                onCommit={() => { /* noop r=${renderIdx} */ }}
                onRequestClose={() => {}}
            />
        );

        const screen = await renderScreen(renderHarness(0));

        // Wait for the initial dynamic resolve.
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

        const initialFetchCount = listMachineFileBrowserDirectoryEntriesMock.mock.calls.length;
        expect(initialFetchCount).toBeGreaterThanOrEqual(1);

        // Re-render the parent 3 times with NEW closures + churning recents.
        for (let i = 1; i <= 3; i += 1) {
            await screen.update(renderHarness(i));
            // Allow the dispatch effect to flush.
            await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
        }

        // The resolver MUST NOT have been re-fired by the parent re-renders.
        // (The same machineId + same input + same resolverKey — no work to do.)
        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls.length)
            .toBe(initialFetchCount);

        // The IN THIS FOLDER section MUST still expose its loaded directory
        // row — i.e. the cache stayed warm; we did NOT flash back through
        // loading-skeleton state.
        const documentsRow = screen.findByTestId(
            'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents',
        );
        expect(documentsRow).not.toBeNull();

        // No loading-skeleton row should be present in the IN THIS FOLDER
        // section after the re-renders.
        const skeletonRows = screen.findAllByTestId('sl:section:dyn:loading:row-0');
        expect(skeletonRows.length).toBe(0);

        act(() => screen.tree.unmount());
    });

    describe('RUX-3: favorite affordance on path rows', () => {
        it('renders a favorite-toggle button on every favorite row, marked as favorite', async () => {
            const { PathSelectionList } = await import('./PathSelectionList');
            const screen = await renderScreen(
                <PathSelectionList
                    initialValue=""
                    favorites={[{ path: '/Users/leeroy/fav-one' }]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                    isFavorite={(p) => p === '/Users/leeroy/fav-one'}
                    onToggleFavorite={() => {}}
                />,
            );
            const toggle = screen.findByTestId(
                'path-selection-list:path-root:option:favorite:/Users/leeroy/fav-one:favorite-toggle',
            );
            expect(toggle).not.toBeNull();
            const toggleProps = readProps<SelectableLikeProps>(toggle!);
            // marked as favorite (filled star)
            expect(toggleProps.accessibilityState?.selected === true
                || toggleProps['aria-pressed'] === true).toBe(true);
            act(() => screen.tree.unmount());
        });

        it('renders a favorite-toggle button on every recent row, marked as not-favorite when not in favorites', async () => {
            const { PathSelectionList } = await import('./PathSelectionList');
            const screen = await renderScreen(
                <PathSelectionList
                    initialValue=""
                    favorites={[]}
                    recents={[{ path: '/Users/leeroy/recent-one', lastUsedAt: 1 }]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                    isFavorite={() => false}
                    onToggleFavorite={() => {}}
                />,
            );
            const toggle = screen.findByTestId(
                'path-selection-list:path-root:option:recent:/Users/leeroy/recent-one:favorite-toggle',
            );
            expect(toggle).not.toBeNull();
            const toggleProps = readProps<SelectableLikeProps>(toggle!);
            expect(toggleProps.accessibilityState?.selected === true
                || toggleProps['aria-pressed'] === true).toBe(false);
            act(() => screen.tree.unmount());
        });

        it('renders a favorite-toggle button on every IN THIS FOLDER directory row', async () => {
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
                ok: true,
                entries: [
                    { type: 'directory', name: 'Documents', path: '/Users/leeroy/Documents' },
                ],
            });
            const { PathSelectionList } = await import('./PathSelectionList');
            const screen = await renderScreen(
                <PathSelectionList
                    initialValue="~/"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                    isFavorite={() => false}
                    onToggleFavorite={() => {}}
                />,
            );
            await act(async () => { await Promise.resolve(); });
            await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

            const toggle = screen.findByTestId(
                'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents:favorite-toggle',
            );
            expect(toggle).not.toBeNull();
            // The drill chevron MUST also still be present for in-folder rows.
            expect(screen.findByTestId(
                'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents:drill',
            )).not.toBeNull();
            act(() => screen.tree.unmount());
        });

        it('retains authored home intent when toggling a favorite without committing the row', async () => {
            const onCommit = vi.fn();
            const onToggleFavorite = vi.fn();
            const { PathSelectionList } = await import('./PathSelectionList');
            const screen = await renderScreen(
                <PathSelectionList
                    initialValue=""
                    favorites={[{ path: '~/fav' }]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={onCommit}
                    onRequestClose={() => {}}
                    isFavorite={(p) => p === '~/fav'}
                    onToggleFavorite={onToggleFavorite}
                />,
            );
            await screen.pressByTestIdAsync(
                'path-selection-list:path-root:option:favorite:/Users/leeroy/fav:favorite-toggle',
            );
            expect(onToggleFavorite).toHaveBeenCalledWith('~/fav');
            // Pressing the toggle MUST NOT commit the row.
            expect(onCommit).not.toHaveBeenCalled();
            act(() => screen.tree.unmount());
        });

        it('updates an IN THIS FOLDER favorite-toggle immediately after press while the directory rows stay cached', async () => {
            const onCommit = vi.fn();
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
                ok: true,
                entries: [
                    { type: 'directory', name: 'Documents', path: '/Users/leeroy/Documents' },
                ],
            });
            const { PathSelectionList } = await import('./PathSelectionList');

            function Harness() {
                const [favoritePaths, setFavoritePaths] = React.useState<readonly string[]>([]);
                const isFavorite = React.useCallback(
                    (path: string) => favoritePaths.includes(path),
                    [favoritePaths],
                );
                const onToggleFavorite = React.useCallback((path: string) => {
                    setFavoritePaths((current) => current.includes(path)
                        ? current.filter((entry) => entry !== path)
                        : [...current, path]);
                }, []);

                return (
                    <PathSelectionList
                        initialValue="~/"
                        favorites={[]}
                        recents={[]}
                        machineHomeDir="/Users/leeroy"
                        machineId="m-1"
                        serverId={null}
                        machinePlatform="unix"
                        onCommit={onCommit}
                        onRequestClose={() => {}}
                        isFavorite={isFavorite}
                        onToggleFavorite={onToggleFavorite}
                    />
                );
            }

            const screen = await renderScreen(<Harness />);
            await act(async () => { await Promise.resolve(); });
            await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

            const toggleTestId = 'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents:favorite-toggle';
            const beforeToggle = readProps<SelectableLikeProps>(screen.findByTestId(toggleTestId)!);
            expect(beforeToggle.accessibilityState?.selected === true
                || beforeToggle['aria-pressed'] === true).toBe(false);

            await screen.pressByTestIdAsync(toggleTestId);

            const afterToggle = readProps<SelectableLikeProps>(screen.findByTestId(toggleTestId)!);
            expect(afterToggle.accessibilityState?.selected === true
                || afterToggle['aria-pressed'] === true).toBe(true);
            expect(afterToggle.accessibilityLabel).toBe('newSession.pathPicker.favoriteRemove');

            await screen.pressByTestIdAsync(toggleTestId);
            const afterRemoval = readProps<SelectableLikeProps>(screen.findByTestId(toggleTestId)!);
            expect(afterRemoval.accessibilityState?.selected === true
                || afterRemoval['aria-pressed'] === true).toBe(false);
            expect(afterRemoval.accessibilityLabel).toBe('newSession.pathPicker.favoriteAdd');
            expect(onCommit).not.toHaveBeenCalled();
            expect(listMachineFileBrowserDirectoryEntriesMock).toHaveBeenCalledTimes(1);
            act(() => screen.tree.unmount());
        });

        it('uses the reopened picker commit and drill callbacks while cached directory rows refresh', async () => {
            const entries = [{ type: 'directory' as const, name: 'Documents', path: '/Users/leeroy/Documents' }];
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({ ok: true, entries });
            const { PathSelectionList } = await import('./PathSelectionList');
            const previousCommit = vi.fn();
            const currentCommit = vi.fn();
            const previousDraftPathChange = vi.fn();
            const currentDraftPathChange = vi.fn();
            const pendingListing = createDeferred<DirectoryReply>();
            const rowTestId = 'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents';
            const picker = (onCommit: (path: string) => void, onChangeDraftPath: (path: string) => void) => (
                <PathSelectionList
                    initialValue="~/"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={onCommit}
                    onChangeDraftPath={onChangeDraftPath}
                    onRequestClose={() => {}}
                />
            );
            const first = await renderScreen(picker(previousCommit, previousDraftPathChange));
            await flushPathSelectionDynamicResolver();
            expect(first.findByTestId(rowTestId)).not.toBeNull();
            await first.unmount();

            listMachineFileBrowserDirectoryEntriesMock.mockReturnValueOnce(pendingListing.promise);
            const reopened = await renderScreen(picker(currentCommit, currentDraftPathChange));
            try {
                await reopened.pressByTestIdAsync(rowTestId);
                expect(currentCommit).toHaveBeenCalledWith('/Users/leeroy/Documents');
                expect(previousCommit).not.toHaveBeenCalled();
                await reopened.pressByTestIdAsync(`${rowTestId}:drill`);
                expect(currentDraftPathChange).toHaveBeenCalledWith('~/Documents/');
                expect(previousDraftPathChange).not.toHaveBeenCalled();
            } finally {
                pendingListing.resolve({ ok: true, entries });
                await reopened.unmount();
            }
        });

        it('uses the reopened picker favorite state and callback while cached directory rows refresh', async () => {
            const entries = [{ type: 'directory' as const, name: 'Documents', path: '/Users/leeroy/Documents' }];
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({ ok: true, entries });
            const { PathSelectionList } = await import('./PathSelectionList');
            const firstToggle = vi.fn();
            const currentToggle = vi.fn();
            const pendingListing = createDeferred<DirectoryReply>();
            const toggleTestId = 'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents:favorite-toggle';
            const picker = (isFavorite: boolean, onToggleFavorite: (path: string) => void) => (
                <PathSelectionList
                    initialValue="~/"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                    isFavorite={() => isFavorite}
                    onToggleFavorite={onToggleFavorite}
                />
            );
            const first = await renderScreen(picker(false, firstToggle));
            await flushPathSelectionDynamicResolver();
            expect(first.findByTestId(toggleTestId)).not.toBeNull();
            await first.unmount();

            listMachineFileBrowserDirectoryEntriesMock.mockReturnValueOnce(pendingListing.promise);
            const reopened = await renderScreen(picker(true, currentToggle));
            try {
                // These rows came from the previous mount, not the still-pending daemon reply.
                expect(readProps<SelectableLikeProps>(reopened.findByTestId(toggleTestId)!)['aria-pressed']).toBe(true);
                await reopened.pressByTestIdAsync(toggleTestId);
                expect(currentToggle).toHaveBeenCalledWith('/Users/leeroy/Documents');
                expect(firstToggle).not.toHaveBeenCalled();
            } finally {
                pendingListing.resolve({ ok: true, entries });
                await reopened.unmount();
            }
        });

        it('exposes an aria-label that reflects current favorite state', async () => {
            const { PathSelectionList } = await import('./PathSelectionList');
            const screen = await renderScreen(
                <PathSelectionList
                    initialValue=""
                    favorites={[{ path: '/Users/leeroy/fav-one' }]}
                    recents={[{ path: '/Users/leeroy/not-fav', lastUsedAt: 1 }]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                    isFavorite={(p) => p === '/Users/leeroy/fav-one'}
                    onToggleFavorite={() => {}}
                />,
            );
            const favoriteToggle = screen.findByTestId(
                'path-selection-list:path-root:option:favorite:/Users/leeroy/fav-one:favorite-toggle',
            );
            const recentToggle = screen.findByTestId(
                'path-selection-list:path-root:option:recent:/Users/leeroy/not-fav:favorite-toggle',
            );
            const favoriteToggleProps = readProps<SelectableLikeProps>(favoriteToggle!);
            const recentToggleProps = readProps<SelectableLikeProps>(recentToggle!);
            // Filled (already favorite) → "Remove from favorites"
            expect(typeof favoriteToggleProps.accessibilityLabel).toBe('string');
            expect(favoriteToggleProps.accessibilityLabel).toMatch(/remove/i);
            // Outline (not yet favorite) → "Add to favorites"
            expect(typeof recentToggleProps.accessibilityLabel).toBe('string');
            expect(recentToggleProps.accessibilityLabel).toMatch(/add/i);
            act(() => screen.tree.unmount());
        });

        it('omits the favorite-toggle when the favorites callbacks are not provided (back-compat)', async () => {
            const { PathSelectionList } = await import('./PathSelectionList');
            const screen = await renderScreen(
                <PathSelectionList
                    initialValue=""
                    favorites={[{ path: '/Users/leeroy/fav-one' }]}
                    recents={[{ path: '/Users/leeroy/recent-one', lastUsedAt: 1 }]}
                    machineHomeDir="/Users/leeroy"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                />,
            );
            expect(screen.findByTestId(
                'path-selection-list:path-root:option:favorite:/Users/leeroy/fav-one:favorite-toggle',
            )).toBeNull();
            expect(screen.findByTestId(
                'path-selection-list:path-root:option:recent:/Users/leeroy/recent-one:favorite-toggle',
            )).toBeNull();
            act(() => screen.tree.unmount());
        });
    });

    /**
     * RUX-1 Issue 6: ENOENT detection. The user's screenshot showed
     * "ENOENT: no such file or directory, scandir '/Users/leeroy/Documents/Developmet/happier'"
     * rendered as the dynamic-section content. The fix:
     *   - PathSelectionList catches ENOENT-class errors and returns
     *     { options: [], notFound: true }
     *   - The orchestrator renders a "Path not found" hint (NOT raw scandir)
     *   - Sibling static sections (favorites/recents) bypass the input
     *     filter so they remain visible.
     */
    it('RUX-1 Issue 6: surfaces a friendly notFound hint when the resolver reports ENOENT (not the raw scandir error)', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: false,
            error: "ENOENT: no such file or directory, scandir '/Users/leeroy/Documents/Developmet/happier'",
        });
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="~/Developmet/happier"
                favorites={[{ path: '~/fav-one' }]}
                recents={[{ path: '~/recent-one', lastUsedAt: 1 }]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

        const notFoundHint = screen.findByTestId(
            'path-selection-list:section:in-this-folder:notFound',
        );
        expect(notFoundHint).not.toBeNull();
        expect(screen.findByTestId(
            'path-selection-list:path-root:option:favorite:/Users/leeroy/fav-one',
        )).not.toBeNull();
        expect(screen.findByTestId(
            'path-selection-list:path-root:option:recent:/Users/leeroy/recent-one',
        )).not.toBeNull();
        act(() => screen.tree.unmount());
    });

    it('RUX-1 Issue 6: isPathNotFoundErrorMessage detects ENOENT/ENOTDIR/no-such-file/not-a-directory variants', async () => {
        const { isPathNotFoundErrorMessage } = await import('./PathSelectionList');
        expect(isPathNotFoundErrorMessage('')).toBe(false);
        expect(isPathNotFoundErrorMessage('network down')).toBe(false);
        expect(isPathNotFoundErrorMessage("ENOENT: no such file or directory, scandir '/x'")).toBe(true);
        expect(isPathNotFoundErrorMessage('ENOTDIR: not a directory')).toBe(true);
        expect(isPathNotFoundErrorMessage('No such file or directory')).toBe(true);
        expect(isPathNotFoundErrorMessage('not a directory')).toBe(true);
    });

    it('Bug 4c: dynamic-section directory rows expose a drill-down chevron that does NOT commit', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true,
            entries: [
                { type: 'directory', name: 'Documents', path: '/Users/leeroy/Documents' },
            ],
        });
        const onCommit = vi.fn();
        const onChangeDraftPath = vi.fn();
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="~/"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={onCommit}
                onChangeDraftPath={onChangeDraftPath}
                onRequestClose={() => {}}
            />,
        );

        // Wait for the dynamic section to resolve.
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

        const chevron = screen.findByTestId(
            'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents:drill',
        );
        expect(chevron).not.toBeNull();
        // Press the chevron — this MUST NOT commit; it MUST update the input
        // value to the descend-into-directory shorthand.
        await act(async () => {
            readProps<PressableLikeProps>(chevron!).onPress?.();
        });
        expect(onCommit).not.toHaveBeenCalled();
        expect(onChangeDraftPath).toHaveBeenCalledWith('~/Documents/');

        const input = screen.findByTestId('path-selection-list:header:input');
        // Descend means the input shorthand becomes `~/Documents/` (trailing slash).
        expect(readProps<ValueLikeProps>(input!).value).toBe('~/Documents/');
        act(() => screen.tree.unmount());
    });

    // ---- FR3-11: drill chevron and tree-browser button must have distinct accessibility labels ----

    it('FR3-11: dynamic-section drill chevron uses a "show folder" label distinct from the tree-browser label', async () => {
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true,
            entries: [
                { type: 'directory', name: 'Documents', path: '/Users/leeroy/Documents' },
            ],
        });
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue="~/"
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );

        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 200)); });

        const drillChevron = screen.findByTestId(
            'path-selection-list:path-root:option:in-folder:/Users/leeroy/Documents:drill',
        );
        expect(drillChevron).not.toBeNull();
        // The drill chevron handler just drills into the folder (updates the
        // input value) — it does NOT open the tree-browser modal. The label
        // must reflect THIS action, not the tree-browser action.
        const drillLabel = readProps<SelectableLikeProps>(drillChevron!).accessibilityLabel;
        expect(typeof drillLabel).toBe('string');
        // FR3-11: the drill chevron must use the dedicated drill/descend label,
        // NOT the tree-browser label.
        expect(drillLabel).toBe('newSession.pathPicker.openFolderLabel');
        expect(drillLabel).not.toBe('newSession.pathPicker.openInTreeBrowserLabel');

        // The input-suffix tree-browser button must STILL use the tree-browser label.
        const treeBrowserButton = screen.findByTestId('path-selection-list:open-tree-browser');
        expect(treeBrowserButton).not.toBeNull();
        expect(readProps<SelectableLikeProps>(treeBrowserButton!).accessibilityLabel)
            .toBe('newSession.pathPicker.openInTreeBrowserLabel');

        act(() => screen.tree.unmount());
    });

    it('RUX-8: omits the maxHeight clamp when no maxHeight is provided (back-compat)', async () => {
        const { PathSelectionList } = await import('./PathSelectionList');
        const screen = await renderScreen(
            <PathSelectionList
                initialValue=""
                favorites={[]}
                recents={[]}
                machineHomeDir="/Users/leeroy"
                machineId="m-1"
                serverId={null}
                machinePlatform="unix"
                onCommit={() => {}}
                onRequestClose={() => {}}
            />,
        );
        const container = screen.findByTestId('path-selection-list');
        expect(container).not.toBeNull();
        const flatStyle = flattenStyle(readProps<StyleLikeProps>(container!));
        expect(flatStyle.maxHeight).toBeUndefined();
        act(() => screen.tree.unmount());
    });

    /**
     * FR4-9: the IN THIS FOLDER dynamic-section's `resolverKey` must include
     * the machine HOME DIR, server scope, and target PLATFORM in addition to
     * the machine id. Otherwise cached directory rows for one home/server/
     * platform combo can be reused for a different combo on the same machine
     * id (e.g. the same machine id resurfacing under a different account
     * scope with a new homeDir).
     *
     * The tests below pin the contract by:
     *   - rendering with one (home/server/platform) combo, letting the
     *     dynamic section resolve, then
     *   - swapping ONE of (home/server/platform) while keeping machineId and
     *     the input value identical, and
     *   - asserting the resolver fires AGAIN with the new context (cache
     *     invalidated via the resolverKey change).
     */
    describe('FR4-9: resolverKey includes home/server/platform context', () => {
        async function flushDynamicSection() {
            await act(async () => { await Promise.resolve(); });
            await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
        }

        it('re-fires the resolver when machineHomeDir changes (same machineId)', async () => {
            listMachineFileBrowserDirectoryEntriesMock.mockReset();
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
                ok: true,
                entries: [
                    { type: 'directory', name: 'Documents', path: '/home/alice/Documents' },
                ],
            });
            const { PathSelectionList } = await import('./PathSelectionList');

            const renderHarness = (homeDir: string) => (
                <PathSelectionList
                    initialValue="~/"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir={homeDir}
                    machineId="m-1"
                    serverId={null}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                />
            );

            const screen = await renderScreen(renderHarness('/home/alice'));
            await flushDynamicSection();
            const initialCount = listMachineFileBrowserDirectoryEntriesMock.mock.calls.length;
            expect(initialCount).toBeGreaterThanOrEqual(1);

            await screen.update(renderHarness('/home/bob'));
            await flushDynamicSection();

            // The machine id is unchanged but the resolved home dir changed:
            // the cache MUST be invalidated and the resolver re-fired.
            expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls.length)
                .toBeGreaterThan(initialCount);
            act(() => screen.tree.unmount());
        });

        it('re-fires the resolver when serverId changes (same machineId + homeDir)', async () => {
            listMachineFileBrowserDirectoryEntriesMock.mockReset();
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
                ok: true,
                entries: [
                    { type: 'directory', name: 'Documents', path: '/home/alice/Documents' },
                ],
            });
            const { PathSelectionList } = await import('./PathSelectionList');

            const renderHarness = (serverId: string | null) => (
                <PathSelectionList
                    initialValue="~/"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/home/alice"
                    machineId="m-1"
                    serverId={serverId}
                    machinePlatform="unix"
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                />
            );

            const screen = await renderScreen(renderHarness('srv_a'));
            await flushDynamicSection();
            const initialCount = listMachineFileBrowserDirectoryEntriesMock.mock.calls.length;
            expect(initialCount).toBeGreaterThanOrEqual(1);

            await screen.update(renderHarness('srv_b'));
            await flushDynamicSection();

            expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls.length)
                .toBeGreaterThan(initialCount);
            act(() => screen.tree.unmount());
        });

        it('re-fires the resolver when machinePlatform changes (same machineId + homeDir)', async () => {
            listMachineFileBrowserDirectoryEntriesMock.mockReset();
            listMachineFileBrowserDirectoryEntriesMock.mockResolvedValue({
                ok: true,
                entries: [
                    { type: 'directory', name: 'Documents', path: '/home/alice/Documents' },
                ],
            });
            const { PathSelectionList } = await import('./PathSelectionList');

            const renderHarness = (platform: 'unix' | 'windows') => (
                <PathSelectionList
                    initialValue="~/"
                    favorites={[]}
                    recents={[]}
                    machineHomeDir="/home/alice"
                    machineId="m-1"
                    serverId={null}
                    machinePlatform={platform}
                    onCommit={() => {}}
                    onRequestClose={() => {}}
                />
            );

            const screen = await renderScreen(renderHarness('unix'));
            await flushDynamicSection();
            const initialCount = listMachineFileBrowserDirectoryEntriesMock.mock.calls.length;
            expect(initialCount).toBeGreaterThanOrEqual(1);

            await screen.update(renderHarness('windows'));
            await flushDynamicSection();

            expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls.length)
                .toBeGreaterThan(initialCount);
            act(() => screen.tree.unmount());
        });
    });
});
