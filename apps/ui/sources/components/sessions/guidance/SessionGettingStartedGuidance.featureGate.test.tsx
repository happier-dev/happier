import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    Platform: { OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    surfaceHighest: '#fff',
                    status: { connected: '#0a0' },
                },
            };
            return typeof styles === 'function' ? styles(theme) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                surfaceHighest: '#fff',
                status: { connected: '#0a0' },
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => {
        if (key === 'components.emptyMainScreen.installCommand') return '$ npm i -g @happier-dev/cli';
        if (key === 'components.emptySessionsTablet.startNewSessionButton') return 'Start New Session';
        if (key === 'components.emptyMainScreen.openCamera') return 'Open Camera';
        if (key === 'connect.enterUrlManually') return 'Enter URL manually';
        return key;
    },
}));

vi.mock('@/modal', () => ({
    Modal: { prompt: vi.fn(async () => null), alert: vi.fn() },
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({
        connectTerminal: () => {},
        connectWithUrl: () => {},
        isLoading: false,
    }),
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => [],
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        activeTarget: { kind: 'server', id: 's1' },
        activeServerId: 's1',
        allowedServerIds: ['s1'],
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useMachineListByServerId: () => ({ s1: [] }),
    useMachineListStatusByServerId: () => ({ s1: 'idle' }),
    useSetting: () => [],
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [{ id: 's1', name: 'cloud', serverUrl: 'https://api.happier.dev' }],
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

describe('SessionGettingStartedGuidance (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.sessionGettingStartedGuidance';
    });

    afterEach(() => {
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('returns null when build policy denies session getting started guidance', async () => {
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionGettingStartedGuidance variant="sidebar" />);
        });

        expect(tree.toJSON()).toBeNull();
    });
});

