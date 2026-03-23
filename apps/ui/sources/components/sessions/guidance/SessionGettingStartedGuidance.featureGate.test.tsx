import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: null, manifest: null },
}));

vi.mock('expo-updates', () => ({
    channel: null,
    releaseChannel: null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props, null),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
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

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 's1', generation: 1 }),
    listServerProfiles: () => [{ id: 's1', name: 'cloud', serverUrl: 'https://api.happier.dev' }],
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

vi.mock('@/config', () => ({
    config: { variant: 'production', cliNpmDistTag: undefined },
}));

installSessionGuidanceCommonModuleMocks();

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
        tree = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;

        expect(tree.toJSON()).toBeNull();
    });
});
