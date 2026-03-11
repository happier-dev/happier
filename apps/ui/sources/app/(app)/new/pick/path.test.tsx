import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setParams = vi.fn();
const replace = vi.fn();
const safeRouterBack = vi.fn();
let capturedPathSelectorProps: any = null;
let localSearchParams: Record<string, string> = {
    machineId: 'machine-1',
    selectedPath: '/repo/current',
};
const paramListeners = new Set<() => void>();

function emitLocalSearchParamsChange() {
    for (const listener of paramListeners) listener();
}

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Platform: { OS: 'web' },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    header: { tint: '#000' },
                    textSecondary: '#666',
                    input: { background: '#fff' },
                    divider: '#ddd',
                },
            };
            return typeof styles === 'function' ? styles(theme) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                textSecondary: '#666',
                input: { background: '#fff' },
                divider: '#ddd',
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: (_props: any) => null,
    },
    useRouter: () => ({
        setParams,
        replace,
    }),
    useLocalSearchParams: () => {
        const ReactModule = require('react') as typeof import('react');
        return ReactModule.useSyncExternalStore(
            (listener) => {
                paramListeners.add(listener);
                return () => {
                    paramListeners.delete(listener);
                };
            },
            () => localSearchParams,
            () => localSearchParams,
        );
    },
    useNavigation: () => ({
        getState: () => ({
            index: 0,
            routes: [{ key: 'path-picker' }],
        }),
        dispatch: vi.fn(),
    }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', params }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => [{ id: 'machine-1', metadata: { homeDir: '/home/test' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        if (key === 'usePathPickerSearch') return false;
        return null;
    },
    useSettingMutable: () => [[], vi.fn()],
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: any) => {
        capturedPathSelectorProps = props;
        return React.createElement('PathSelector', props);
    },
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: any[]) => safeRouterBack(...args),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 920 },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

describe('PathPickerScreen', () => {
    beforeEach(() => {
        capturedPathSelectorProps = null;
        localSearchParams = {
            machineId: 'machine-1',
            selectedPath: '/repo/current',
        };
        paramListeners.clear();
        setParams.mockReset();
        replace.mockReset();
        safeRouterBack.mockReset();
    });

    it('replaces to new session with path params when confirming without a previous route', async () => {
        const PathPickerScreen = (await import('./path')).default;

        await act(async () => {
            renderer.create(React.createElement(PathPickerScreen));
        });

        expect(capturedPathSelectorProps).toBeTruthy();

        await act(async () => {
            capturedPathSelectorProps.onSubmitSelectedPath('/repo/selected');
        });

        expect(replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                path: '/repo/selected',
            },
        });
        expect(setParams).not.toHaveBeenCalled();
        expect(safeRouterBack).not.toHaveBeenCalled();
    });

    it('uses the direct-entry path query as a fallback selected path', async () => {
        localSearchParams = {
            machineId: 'machine-1',
            path: '/repo/direct-entry',
        };

        const PathPickerScreen = (await import('./path')).default;

        await act(async () => {
            renderer.create(React.createElement(PathPickerScreen));
        });

        expect(capturedPathSelectorProps?.selectedPath).toBe('/repo/direct-entry');
    });

    it('updates the selected path when route params change after mount', async () => {
        const PathPickerScreen = (await import('./path')).default;

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PathPickerScreen));
        });

        expect(capturedPathSelectorProps?.selectedPath).toBe('/repo/current');

        localSearchParams = {
            machineId: 'machine-1',
            selectedPath: '/repo/updated',
        };

        await act(async () => {
            emitLocalSearchParamsChange();
        });

        expect(capturedPathSelectorProps?.selectedPath).toBe('/repo/updated');
    });
});
