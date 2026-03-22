import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getPathBrowserRowTestId,
    getPathBrowserToggleTestId,
    PATH_BROWSER_CONFIRM_TEST_ID,
    PATH_BROWSER_MODAL_TEST_ID,
} from './pathBrowserTestIds';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitForTestId(screen: ReturnType<typeof renderScreen> extends Promise<infer Result> ? Result : never, testID: string) {
    for (let index = 0; index < 8; index += 1) {
        const target = screen.findByTestId(testID);
        if (target) {
            return target;
        }
        await act(async () => {
            await Promise.resolve();
        });
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
    entries: Array<{ name: string; path: string; type: 'directory' }>;
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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
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
                        ...(data ?? []).map((item: any, index: number) => React.createElement(React.Fragment, { key: `${item.type}:${item.path}:${index}` }, renderItem({ item, index }))),
                    ],
                );
            }),
            Platform: {
                OS: 'web',
                select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
            },
        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null, props.subtitle ?? null),
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

    it('renders nested directories when expanding a child folder', async () => {
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');

        const screen = await renderScreen(<MachinePathBrowserModal
                    machineId="machine-1"
                    onResolve={vi.fn()}
                    onClose={vi.fn()}
                />);

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

        const stopPropagation = vi.fn();
        await act(async () => {
            const rootToggle = screen.findByTestId(getPathBrowserToggleTestId('/'));
            expect(rootToggle).toBeTruthy();
            rootToggle?.props.onMouseDownCapture?.({ stopPropagation });
            await rootToggle?.props.onPress({ stopPropagation, nativeEvent: { stopPropagation } });
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
            await act(async () => {
                await Promise.resolve();
            });
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
            await act(async () => {
                await Promise.resolve();
            });
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
            await act(async () => {
                await Promise.resolve();
            });
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

        await screen.pressByTestIdAsync(getPathBrowserToggleTestId('/'));

        await waitForTestId(screen, getPathBrowserRowTestId('/#truncated'));

        const infoRows = screen.findAllByTestId(getPathBrowserRowTestId('/#truncated'));
        const titledInfoRows = infoRows.filter((node) => typeof node.props?.title === 'string');
        expect(titledInfoRows.length).toBeGreaterThan(0);
        expect(titledInfoRows[0]?.props?.title).toBe('newSession.pathPicker.truncatedDirectoryInfo:1');
    });

    it('constrains the modal card to the viewport and lets the browser body shrink for internal scrolling', async () => {
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
});
