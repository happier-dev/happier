import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks, setSessionGettingStartedGuidanceDismissedForTests } from './sessionGuidanceTestHelpers';

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

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

const tauriState = vi.hoisted(() => ({
    desktop: false,
}));

const connectTerminalHookState = vi.hoisted(() => ({
    calls: 0,
}));

const routerMockState = vi.hoisted(() => ({
    push: vi.fn(),
    useRouterCalls: 0,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriState.desktop,
}));

vi.mock('@/config', () => ({
    config: { variant: 'production', cliNpmDistTag: undefined },
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => {
        connectTerminalHookState.calls += 1;
        return {
            connectTerminal: () => {},
            connectWithUrl: () => {},
            isLoading: false,
        };
    },
}));

vi.mock('@/hooks/session/useVisibleSessionListSummaryState', () => ({
    useVisibleSessionListSummaryState: () => ({
        selection: {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        },
        summary: {
            sessionsReady: true,
            sessionCount: 0,
        },
    }),
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        activeTarget: { kind: 'server', id: 's1' },
        activeServerId: 's1',
        allowedServerIds: ['s1'],
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 's1', serverUrl: 'http://127.0.0.1:3005', generation: 1 }),
    getServerProfilesGeneration: () => 1,
    listServerProfiles: () => [{ id: 's1', name: 'dev', serverUrl: 'http://127.0.0.1:3005' }],
    subscribeActiveServer: () => () => {},
    subscribeServerProfiles: () => () => {},
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => 'neutral',
}));

installSessionGuidanceCommonModuleMocks({
    router: () => ({
        router: { push: routerMockState.push },
        useRouter: () => {
            routerMockState.useRouterCalls += 1;
            return { push: routerMockState.push };
        },
    }),
});

describe('SessionGettingStartedGuidance (desktop-only setup CTA)', () => {
    beforeEach(() => {
        connectTerminalHookState.calls = 0;
        routerMockState.push.mockClear();
        routerMockState.useRouterCalls = 0;
        setSessionGettingStartedGuidanceDismissedForTests(false);
    });

    it('shows the Open setup CTA on web surfaces', async () => {
        tauriState.desktop = false;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
        expect(connectTerminalHookState.calls).toBe(0);
        expect(routerMockState.useRouterCalls).toBe(0);
    });

    it('shows the Open setup CTA on Tauri desktop', async () => {
        tauriState.desktop = true;
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
    });

    it('suppresses optional setup guidance after the user dismissed the setup wizard', async () => {
        tauriState.desktop = false;
        setSessionGettingStartedGuidanceDismissedForTests(true);
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="sidebar" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).toThrow();
    });

    it('keeps blocking new-session setup guidance visible after the user dismissed optional guidance', async () => {
        tauriState.desktop = false;
        setSessionGettingStartedGuidanceDismissedForTests(true);
        vi.resetModules();
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const tree: renderer.ReactTestRenderer = (await renderScreen(<SessionGettingStartedGuidance variant="newSessionBlocking" />)).tree;
        expect(() => tree.root.findByProps({ testID: 'session-getting-started-open-setup' })).not.toThrow();
    });
});
