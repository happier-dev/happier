import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
    resolvePickerStackOptions,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();

vi.mock('@/text', () => ({ t: (key: string) => key }));

type PlatformSelectOptions<T> = { ios?: T; default?: T };

type Captured = Array<PickerStackOptionsInput>;
const capturedOptions: Captured = [];

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'ios', select: <T,>(options: PlatformSelectOptions<T>) => options.ios ?? options.default },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    TurboModuleRegistry: { getEnforcing: () => ({}) },
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: { options: PickerStackOptionsInput }) => {
            capturedOptions.push(options);
            return null;
        },
    },
    useRouter: () => routerMock,
    useNavigation: () => navigationMock,
    useLocalSearchParams: () => ({ machineId: 'm1', selectedPath: '' }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: any) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('react-native-unistyles', () => {
    const colors = { ...PICKER_THEME_COLORS, shadow: { color: '#000', opacity: 0.2 } };
    const theme = { colors };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 900 },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => [{ id: 'm1', metadata: { homeDir: '/home' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        if (key === 'usePathPickerSearch') return false;
        return null;
    },
    useSettingMutable: () => [[], vi.fn()],
}));

// Simulate the user typing (causes parent state update + re-render).
vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: ({ onChangeSelectedPath }: { onChangeSelectedPath: (p: string) => void }) => {
        React.useEffect(() => {
            onChangeSelectedPath('/');
        }, [onChangeSelectedPath]);
        return null;
    },
}));

describe('PathPickerScreen (header options stability)', () => {
    it('keeps headerRight stable across keystroke-driven re-renders', async () => {
        capturedOptions.length = 0;
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;

        await act(async () => {
            renderer.create(React.createElement(PathPickerScreen));
            // Flush microtasks so the mocked PathSelector's useEffect can run.
            await Promise.resolve();
        });

        expect(capturedOptions.length).toBeGreaterThanOrEqual(2);

        const first = resolvePickerStackOptions(capturedOptions[0]);
        const last = resolvePickerStackOptions(capturedOptions[capturedOptions.length - 1]);

        expect(typeof first?.headerRight).toBe('function');
        expect(first?.headerRight).toBe(last?.headerRight);
    });
});
