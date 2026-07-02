import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import renderer, { act } from 'react-test-renderer';

import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        FlatList: 'FlatList',
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        Platform: {
            OS: 'ios',
            select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T }) =>
                options.ios ?? options.native ?? options.default ?? options.web,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', () => createModalModuleMock().module);

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/sync/domains/input/machineFileBrowser', () => ({
    clearCachedMachineFileBrowserEntries: () => {},
    clearCachedMachineFileBrowserRoots: () => {},
    getCachedMachineFileBrowserDirectoryMetadata: () => null,
    getCachedMachineFileBrowserEntries: () => null,
    getCachedMachineFileBrowserRoots: () => null,
    listMachineFileBrowserDirectoryEntries: async () => ({ ok: true, entries: [], truncated: false }),
    listMachineFileBrowserRoots: async () => ({ ok: true, roots: [] }),
    warmMachineFileBrowserDirectoryCache: async () => ({ ok: true, entries: [], truncated: false }),
    warmMachineFileBrowserRoots: async () => ({ ok: true, roots: [] }),
}));

vi.mock('@/sync/ops/machines', () => ({
    machineCreateDirectory: async () => ({ success: true }),
}));

vi.mock('@/sync/ops/machineRipgrep', () => ({
    machineRipgrep: async () => ({ success: true, stdout: '', exitCode: 0 }),
}));

describe('MachinePathBrowserModal native chrome stability', () => {
    it('does not republish card chrome after the host applies the first chrome update', async () => {
        const { MachinePathBrowserModal } = await import('./MachinePathBrowserModal');
        const publishCountRef = { current: 0 };

        function Harness() {
            const [, forceRender] = React.useReducer((value: number) => value + 1, 0);
            const forcedOnceRef = React.useRef(false);
            const setChrome = React.useCallback(() => {
                publishCountRef.current += 1;
                if (forcedOnceRef.current) return;
                forcedOnceRef.current = true;
                forceRender();
            }, []);

            const onClose = React.useCallback(() => {}, []);
            const onResolve = React.useCallback(() => {}, []);

            return (
                <MachinePathBrowserModal
                    machineId="machine-1"
                    onClose={onClose}
                    onResolve={onResolve}
                    setChrome={setChrome}
                />
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        try {
            await act(async () => {
                tree = renderer.create(<Harness />);
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            expect(publishCountRef.current).toBe(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
