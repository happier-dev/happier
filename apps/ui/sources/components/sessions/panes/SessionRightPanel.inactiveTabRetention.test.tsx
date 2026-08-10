import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));

/**
 * Stands in for the Agents surface and reports exactly what P-3 is about: does an inactive tab keep
 * subscribing to session state and re-rendering off it? The probe also holds local state so an
 * implementation that unmounts the tab (losing scroll and hydrated content) is distinguishable from
 * one that suspends it.
 */
const agentsProbe = vi.hoisted(() => {
    let storeValue = 0;
    const listeners = new Set<() => void>();
    return {
        renders: 0,
        reset() {
            storeValue = 0;
            listeners.clear();
            this.renders = 0;
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        getSnapshot() { return storeValue; },
        emitSessionUpdate() {
            storeValue += 1;
            for (const listener of [...listeners]) listener();
        },
    };
});

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        const platformOverride = {};
        Object.defineProperty(platformOverride, 'OS', {
            get: () => platform.os,
            enumerable: true,
            configurable: true,
        });
        return createReactNativeNativeMock({ platformOS: 'ios' }, { Platform: platformOverride });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => 'sidebar',
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: () => React.createElement('FilesView'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: () => React.createElement('GitView'),
}));

vi.mock('@/components/sessions/panes/SessionTranscriptNavigationPane', () => ({
    SessionTranscriptNavigationPane: () => React.createElement('NavigationView'),
}));

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: () => {
        agentsProbe.renders += 1;
        const sessionValue = React.useSyncExternalStore(
            agentsProbe.subscribe,
            agentsProbe.getSnapshot,
            agentsProbe.getSnapshot,
        );
        const [scrollOffset, setScrollOffset] = React.useState(0);
        return React.createElement('AgentsView', {
            testID: 'agents-probe',
            sessionValue,
            scrollOffset,
            onScroll: () => setScrollOffset(240),
        });
    },
}));

let scopeState: any = { right: { isOpen: true, activeTabId: 'git', tabState: {} } };

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        const [, bump] = React.useState(0);
        return {
            scopeState,
            openRight: vi.fn(),
            setRightTab: (tabId: string) => {
                scopeState.right.activeTabId = tabId;
                bump((value) => value + 1);
            },
            closeRight: vi.fn(),
            openDetailsTab: vi.fn(),
        };
    },
}));

function readProbeProps(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.findAllByType('AgentsView' as never);
    return nodes.length > 0 ? nodes[0]!.props : null;
}

/** The surface test id sits on both the `RightTabSurface` element and the `View` it renders. */
function findAgentsSurfaceHost(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen
        .findAllByTestId('session-rightpanel-surface-agents')
        .find((node) => typeof node.type === 'string') ?? null;
}

describe('SessionRightPanel (inactive tab retention)', () => {
    beforeEach(() => {
        platform.os = 'ios';
        agentsProbe.reset();
        scopeState = { right: { isOpen: true, activeTabId: 'git', tabState: {} } };
    });

    it('stops rendering the Agents surface off session updates once the tab goes inactive on native', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-rightpanel-tab:agents');
        expect(agentsProbe.renders).toBeGreaterThan(0);
        expect(readProbeProps(screen)).not.toBeNull();

        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        // The surface stays mounted so returning to it is instant; that is the behaviour being kept.
        expect(screen.findAllByTestId('session-rightpanel-surface-agents').length).toBeGreaterThan(0);

        const rendersWhenDeactivated = agentsProbe.renders;
        await act(async () => { agentsProbe.emitSessionUpdate(); });
        await act(async () => { agentsProbe.emitSessionUpdate(); });

        expect(agentsProbe.renders).toBe(rendersWhenDeactivated);
    });

    it('restores the Agents surface with its retained state and the latest session value on return', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-rightpanel-tab:agents');
        const probeProps = readProbeProps(screen);
        expect(probeProps).not.toBeNull();
        await act(async () => { probeProps!.onScroll(); });
        expect(readProbeProps(screen)!.scrollOffset).toBe(240);

        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        await act(async () => { agentsProbe.emitSessionUpdate(); });
        await act(async () => { agentsProbe.emitSessionUpdate(); });

        await screen.pressByTestIdAsync('session-rightpanel-tab:agents');

        const restored = readProbeProps(screen);
        expect(restored).not.toBeNull();
        // Suspended, not unmounted: local view state survives, so scroll position and hydrated
        // content are not thrown away, and the surface catches up to the current session value.
        expect(restored!.scrollOffset).toBe(240);
        expect(restored!.sessionValue).toBe(2);
    });

    it('takes an inactive native surface out of the screen-reader cursor', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-rightpanel-tab:agents');
        const active = findAgentsSurfaceHost(screen);
        expect(active).not.toBeNull();
        expect(active!.props.accessibilityElementsHidden).toBeUndefined();

        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        const inactive = findAgentsSurfaceHost(screen);
        expect(inactive!.props.accessibilityElementsHidden).toBe(true);
        expect(inactive!.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('leaves web behaviour unchanged: an inactive surface keeps rendering off session updates', async () => {
        platform.os = 'web';
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        await screen.pressByTestIdAsync('session-rightpanel-tab:agents');
        await screen.pressByTestIdAsync('session-rightpanel-tab:git');

        const rendersWhenDeactivated = agentsProbe.renders;
        await act(async () => { agentsProbe.emitSessionUpdate(); });

        expect(agentsProbe.renders).toBeGreaterThan(rendersWhenDeactivated);
        expect(readProbeProps(screen)!.sessionValue).toBe(1);
        // Web hides an inactive surface with `display:'none'`, which already removes it from the
        // accessibility tree; the native-only props must not leak onto it.
        const inactiveOnWeb = findAgentsSurfaceHost(screen);
        expect(inactiveOnWeb!.props.accessibilityElementsHidden).toBeUndefined();
    });
});
