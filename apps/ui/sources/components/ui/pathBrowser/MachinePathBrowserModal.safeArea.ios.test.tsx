import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

import { PATH_BROWSER_MODAL_TEST_ID } from './pathBrowserTestIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        FlatList: 'FlatList',
        useWindowDimensions: () => ({
            width: 390,
            height: 844,
            scale: 1,
            fontScale: 1,
        }),
        Platform: {
            OS: 'ios',
            select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default,
        },
    });
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
        insets: { top: 44, bottom: 34, left: 0, right: 0 },
        frame: { x: 0, y: 0, width: 390, height: 844 },
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                text: '#111',
                textSecondary: '#666',
                divider: '#ddd',
                header: { tint: '#111' },
                shadowLevels: [{}, {}, {}, {}, {}, {}],
                input: { background: '#fff' },
            },
        },
    });
});

vi.mock('@/shadowElevation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/shadowElevation')>();
    return {
        ...actual,
        shadowLevelStyle: () => ({}),
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key, translateLoose: (key: string) => key });
});

vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowser', () => ({
    FilesystemBrowser: () => React.createElement('FilesystemBrowser'),
}));

vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowserRow', () => ({
    FilesystemBrowserRow: () => React.createElement('FilesystemBrowserRow'),
}));

vi.mock('@/components/ui/filesystemBrowser/FilesystemBrowserToolbarChrome', () => ({
    FilesystemBrowserToolbarChrome: () => React.createElement('FilesystemBrowserToolbarChrome'),
}));

vi.mock('@/hooks/ui/filesystem/useLazyDirectoryTree', () => ({
    useLazyDirectoryTree: () => ({
        nodes: [],
        rootLoading: false,
        rootError: null,
        retryRoot: vi.fn(),
        retryDirectory: vi.fn(),
        toggleDirectory: vi.fn(),
    }),
}));

vi.mock('@/sync/domains/input/machineFileBrowser', () => ({
    listMachineFileBrowserRoots: vi.fn(async () => ({ ok: true, roots: [] })),
    listMachineFileBrowserDirectoryEntries: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
    warmMachineFileBrowserRoots: vi.fn(async () => undefined),
    warmMachineFileBrowserDirectoryCache: vi.fn(async () => undefined),
    clearCachedMachineFileBrowserEntries: vi.fn(),
    clearCachedMachineFileBrowserRoots: vi.fn(),
    getCachedMachineFileBrowserRoots: vi.fn(() => null),
    getCachedMachineFileBrowserEntries: vi.fn(() => null),
    getCachedMachineFileBrowserDirectoryMetadata: vi.fn(() => null),
}));

vi.mock('@/sync/ops/machines', () => ({
    machineCreateDirectory: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/ops/machineRipgrep', () => ({
    machineRipgrep: vi.fn(async () => ({ success: true, stdout: '', exitCode: 0 })),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
    Octicons: (props: any) => React.createElement('Octicons', props),
}));

const modalMock = createModalModuleMock({
    spies: {
        prompt: async () => null,
    },
});

vi.mock('@/modal', () => modalMock.module);

describe('MachinePathBrowserView (iOS safe-area)', () => {
    it('pads the modal header by the iOS safe-area inset when chrome is not provided', async () => {
        const { MachinePathBrowserView } = await import('./MachinePathBrowserModal');
        const screen = await renderScreen(
            <MachinePathBrowserView
                machineId="m1"
                title="Pick a path"
                variant="modal"
                interaction="confirm"
                onPickPath={vi.fn()}
            />,
        );

        const tree = screen.tree as renderer.ReactTestRenderer;
        const modal = tree.root.findByProps({ testID: PATH_BROWSER_MODAL_TEST_ID });
        const flattenStyle = (style: unknown): Record<string, unknown> => {
            if (Array.isArray(style)) {
                return Object.assign({}, ...style.filter(Boolean));
            }
            return (style && typeof style === 'object') ? (style as Record<string, unknown>) : {};
        };

        const header = modal.findAllByType('View' as any).find((view: any) => {
            const style = flattenStyle(view.props?.style);
            return style.paddingHorizontal === 16 && style.borderBottomWidth === 1;
        });

        expect(header).toBeTruthy();
        const headerStyle = flattenStyle((header as any).props.style);

        expect(headerStyle.paddingTop).toBe(60);
    });
});
