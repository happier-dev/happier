import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getPathBrowserRowTestId,
    getPathBrowserToggleTestId,
    PATH_BROWSER_CONFIRM_TEST_ID,
    PATH_BROWSER_CREATE_FOLDER_TEST_ID,
    PATH_BROWSER_MODAL_TEST_ID,
} from './pathBrowserTestIds';
import { flushHookEffects, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitForTestId(screen: ReturnType<typeof renderScreen> extends Promise<infer Result> ? Result : never, testID: string) {
    for (let index = 0; index < 8; index += 1) {
        const target = screen.findByTestId(testID);
        if (target) {
            return target;
        }
        await flushHookEffects({ cycles: 1, turns: 1 });
    }
    return screen.findByTestId(testID);
}

const listMachineFileBrowserRootsMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<{
    ok: true;
    roots: Array<{ id: string; label: string; path: string }>;
}>>(async () => ({
    ok: true as const,
    roots: [{ id: '/', label: '/', path: '/' }],
})));
const listMachineFileBrowserDirectoryEntriesMock = vi.hoisted(() => vi.fn<(params: { directoryPath: string }) => Promise<{
    ok: true;
    entries: Array<{ name: string; path: string; type: 'directory' | 'file' }>;
    truncated: boolean;
}>>(async (params: { directoryPath: string }) => {
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
const machineRipgrepMock = vi.hoisted(() => vi.fn<(machineId: string, args: readonly string[], cwd?: string, options?: unknown) => Promise<{
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}>>(async () => ({
    success: true,
    stdout: '',
    exitCode: 0,
})));
const modalPromptMock = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<string | null>>(async () => null));
const modalAlertMock = vi.hoisted(() => vi.fn());

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
            OS: 'web',
            select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                text: '#111',
                textSecondary: '#666',
                textLink: '#06f',
                divider: '#ddd',
                shadow: { color: '#000' },
                button: { primary: { background: '#06f', tint: '#fff' } },
                header: { tint: '#111' },
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, vars?: Record<string, unknown>) => typeof vars?.count === 'number' ? `${key}:${vars.count}` : key,
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    // Render icon + rightElement so tests can locate nested toggle pressables by testID.
    Item: (props: any) => React.createElement('Item', props, props.icon ?? null, props.rightElement ?? null, props.subtitle ?? null),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiItemDensity') return 'comfortable';
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        if (!props.open) return null;
        return React.createElement('Popover', props, props.children({ maxHeight: 400, maxWidth: 520, placement: 'bottom' }));
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/modal', () => createModalModuleMock({
    spies: {
        prompt: (...args: any[]) => modalPromptMock(...args),
        alert: (...args: any[]) => modalAlertMock(...args),
        confirm: vi.fn(async () => false),
    },
}).module);

vi.mock('@/sync/ops/machines', () => ({
    machineCreateDirectory: (machineId: string, path: string, options?: unknown) => machineCreateDirectoryMock(machineId, path, options),
}));

vi.mock('@/sync/ops/machineRipgrep', () => ({
    machineRipgrep: (machineId: string, args: readonly string[], cwd?: string, options?: unknown) =>
        machineRipgrepMock(machineId, args, cwd, options),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/sync/domains/input/machineFileBrowser', () => ({
    getCachedMachineFileBrowserDirectoryMetadata: () => null,
    getCachedMachineFileBrowserEntries: () => null,
    getCachedMachineFileBrowserRoots: () => null,
    listMachineFileBrowserDirectoryEntries: (params: unknown) => listMachineFileBrowserDirectoryEntriesMock(params as any),
    listMachineFileBrowserRoots: (params: unknown) => listMachineFileBrowserRootsMock(params as any),
    warmMachineFileBrowserDirectoryCache: (params: unknown) => listMachineFileBrowserDirectoryEntriesMock(params as any),
    warmMachineFileBrowserRoots: (params: unknown) => listMachineFileBrowserRootsMock(params as any),
}));

describe('MachinePathBrowserModal', () => {
    beforeEach(() => {
        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockClear();
        flatListScrollToIndexMock.mockClear();
        machineCreateDirectoryMock.mockClear();
        machineRipgrepMock.mockClear();
        modalPromptMock.mockClear();
        modalAlertMock.mockClear();
    });

    it('expands the machine root and confirms the selected folder', async () => {
        const onResolve = vi.fn();
        const onClose = vi.fn();
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={onResolve}
                    onClose={onClose}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        const usersRow = await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users'));

        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);

        expect(listMachineFileBrowserRootsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
        }));
        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls).toEqual(expect.arrayContaining([
            [expect.objectContaining({
                machineId: 'machine-1',
                directoryPath: '/',
                includeFiles: false,
            })],
        ]));
        expect(onResolve).toHaveBeenCalledWith('/Users');
        expect(onClose).toHaveBeenCalled();
    });

    it('supports a scoped popover view rooted at a specific directory without listing machine roots', async () => {
        const onPickPath = vi.fn();
        const onRequestClose = vi.fn();
        const { MachinePathBrowserView } = await import('./MachinePathBrowserModal');

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
        const { MachinePathBrowserView } = await import('./MachinePathBrowserModal');

        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true as const,
            entries: [
                { name: 'apps', path: '/repo/apps', type: 'directory' as const },
            ],
            truncated: false,
        });
        machineRipgrepMock.mockResolvedValueOnce({
            success: true,
            exitCode: 0,
            stdout: 'apps/ui/README.md\napps/ui/src/index.ts\n',
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

        expect(machineRipgrepMock).toHaveBeenCalledWith(
            'machine-1',
            expect.arrayContaining(['--files']),
            '/repo',
            expect.anything(),
        );

        await waitForTestId(screen, getPathBrowserRowTestId('/repo/apps/ui/README.md'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/repo/apps/ui/README.md'));

        expect(onPickPath).toHaveBeenCalledWith('/repo/apps/ui/README.md');
        vi.useRealTimers();
    });

    it('can search deep paths on the machine within the selected directory when not scoped', async () => {
        vi.useFakeTimers();
        const onPickPath = vi.fn();
        const { MachinePathBrowserView } = await import('./MachinePathBrowserModal');

        listMachineFileBrowserRootsMock.mockClear();
        listMachineFileBrowserDirectoryEntriesMock.mockReset();
        listMachineFileBrowserDirectoryEntriesMock.mockResolvedValueOnce({
            ok: true as const,
            entries: [
                { name: 'Users', path: '/Users', type: 'directory' as const },
            ],
            truncated: false,
        });

        machineRipgrepMock.mockResolvedValueOnce({
            success: true,
            exitCode: 0,
            stdout: 'leeroy/.ssh/config\n',
        });

        const screen = await renderScreen(
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

        expect(machineRipgrepMock).toHaveBeenCalledWith(
            'machine-1',
            expect.arrayContaining(['--files']),
            '/Users',
            expect.anything(),
        );

        await waitForTestId(screen, getPathBrowserRowTestId('/Users/leeroy/.ssh'));
        await screen.pressByTestIdAsync(getPathBrowserRowTestId('/Users/leeroy/.ssh'));
        await screen.pressByTestIdAsync(PATH_BROWSER_CONFIRM_TEST_ID);

        expect(onPickPath).toHaveBeenCalledWith('/Users/leeroy/.ssh');
        vi.useRealTimers();
    });

    it('renders nested directories when expanding a child folder', async () => {
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));

        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/Users'));

        await waitForTestId(screen, getPathBrowserRowTestId('/Users/leeroy'));

        expect(listMachineFileBrowserDirectoryEntriesMock.mock.calls).toEqual(expect.arrayContaining([
            [expect.objectContaining({
                machineId: 'machine-1',
                directoryPath: '/Users',
                includeFiles: false,
            })],
        ]));
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users/leeroy'))).toBeTruthy();
    });

    it('stops web toggle events from bubbling to the row while expanding the directory', async () => {
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        const stopPropagation = vi.fn();
        await act(async () => {
            const rootToggle = screen.findByTestId(getPathBrowserToggleTestId('/'));
            expect(rootToggle).toBeTruthy();
            rootToggle?.props.onMouseDownCapture?.({ stopPropagation });
            invokeTestInstanceHandler(rootToggle, 'onPress', { stopPropagation, nativeEvent: { stopPropagation } });
        });

        await waitForTestId(screen, getPathBrowserRowTestId('/Users'));

        expect(stopPropagation).toHaveBeenCalled();
        expect(listMachineFileBrowserDirectoryEntriesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            directoryPath: '/',
            includeFiles: false,
        }));
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users'))).toBeTruthy();
    });

    it('pre-expands and preselects the current directory path so the user can navigate up or elsewhere', async () => {
        const onResolve = vi.fn();
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    onResolve={onResolve}
                    onClose={vi.fn()}
                />);

        let confirmButton = await waitForTestId(screen, PATH_BROWSER_CONFIRM_TEST_ID);
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

        expect(onResolve).toHaveBeenCalledWith('/Users/leeroy');
    });

    it('shows the initial path chain while the root listing is still pending', async () => {
        listMachineFileBrowserRootsMock.mockImplementationOnce(async () => await new Promise(() => {}));

        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    initialPath="/Users/leeroy"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        expect(screen.findByTestId(getPathBrowserRowTestId('/'))).toBeTruthy();
        expect(screen.findByTestId(getPathBrowserRowTestId('/Users'))).toBeTruthy();
    });

    it('scrolls the preselected directory into view once its ancestor chain has loaded', async () => {
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
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
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
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

        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
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

    it('fills the modal card to the viewport clamp so the browser list has measurable height for internal scrolling', async () => {
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

        const modal = screen.findByTestId(PATH_BROWSER_MODAL_TEST_ID);
        expect(modal).toBeTruthy();
        if (!modal) {
            return;
        }
        const modalStyle = Array.isArray(modal.props.style)
            ? Object.assign({}, ...modal.props.style)
            : modal.props.style;

        expect(modalStyle).toEqual(expect.objectContaining({
            height: 852,
            maxHeight: 852,
            width: 560,
        }));

        const body = screen.findAll((node) => {
            return node.props?.style
                && node.props.style.flex === 1
                && node.props.style.minHeight === 0;
        })[0];

        expect(body).toBeTruthy();

        const footerButtons = screen.findAll((node) => {
            return node.props?.title === 'common.cancel' || node.props?.title === 'common.use';
        });
        expect(footerButtons.length).toBeGreaterThanOrEqual(2);
        expect(footerButtons.every((node) => node.props.size === 'normal')).toBe(true);
    });

    it('keeps the modal on its inline chrome path even when CustomModal injects setChrome', async () => {
        const setChrome = vi.fn();
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(
            <MachinePathBrowserModal
                machineId="machine-1"
                onResolve={vi.fn()}
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(setChrome).not.toHaveBeenCalled();
        expect(screen.findByTestId(PATH_BROWSER_MODAL_TEST_ID)).toBeTruthy();
    });

    it('does not republish equivalent modal chrome on a parent rerender', async () => {
        const setChrome = vi.fn();
        const onPickPath = vi.fn();
        const onRequestClose = vi.fn();
        const { MachinePathBrowserView } = await import('./MachinePathBrowserModal');

        const renderView = () => (
            <MachinePathBrowserView
                machineId="machine-1"
                variant="modal"
                interaction="confirm"
                setChrome={setChrome}
                onPickPath={onPickPath}
                onRequestClose={onRequestClose}
            />
        );

        const screen = await renderScreen(renderView());
        await flushHookEffects({ cycles: 2, turns: 2 });
        setChrome.mockClear();

        act(() => {
            screen.tree.update(renderView());
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(setChrome).toHaveBeenCalledTimes(0);
    });

    it('publishes modal chrome only once during initial mount when state is unchanged', async () => {
        const setChrome = vi.fn();
        const { MachinePathBrowserView } = await import('./MachinePathBrowserModal');

        await renderScreen(
            <MachinePathBrowserView
                machineId="machine-1"
                variant="modal"
                interaction="confirm"
                setChrome={setChrome}
                onPickPath={vi.fn()}
                onRequestClose={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(setChrome).toHaveBeenCalledTimes(1);
    });

    it('creates a folder under the selected directory via the header action', async () => {
        modalPromptMock.mockResolvedValueOnce('new-folder');
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
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

        expect(machineCreateDirectoryMock).toHaveBeenCalledWith(
            'machine-1',
            '/Users/new-folder',
            expect.anything(),
        );
    });

    it('opens a context menu on right click and creates a folder in the clicked directory', async () => {
        modalPromptMock.mockResolvedValueOnce('child');
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
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

        expect(machineCreateDirectoryMock).toHaveBeenCalledWith(
            'machine-1',
            '/Users/child',
            expect.anything(),
        );
    });

    it('opens a context menu on long press and creates a folder in the pressed directory', async () => {
        modalPromptMock.mockResolvedValueOnce('child');
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
            machineId="machine-1"
            onResolve={vi.fn()}
            onClose={vi.fn()}
        />);

        await waitForTestId(screen, getPathBrowserToggleTestId('/'));
        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        const usersRow = await waitForTestId(screen, getPathBrowserRowTestId('/Users'));
        await act(async () => {
            invokeTestInstanceHandler(usersRow, 'onLongPress');
        });

        await waitForTestId(screen, 'dropdown-option-create-folder');
        await screen.pressByTestIdAsync('dropdown-option-create-folder');

        expect(machineCreateDirectoryMock).toHaveBeenCalledWith(
            'machine-1',
            '/Users/child',
            expect.anything(),
        );
    });
});
