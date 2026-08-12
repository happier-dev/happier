import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { SESSION_HEADER_ICON_SIZE_PX } from './sessionHeaderIconMetrics';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const layoutState = vi.hoisted(() => ({
    windowWidthPx: 1400,
    deviceType: 'tablet' as 'phone' | 'tablet',
    // The pane host normalizes web to `tablet`, so a phone layout is only reachable on a native
    // platform. Driving the real normalization is the point: a test that could not reach the phone
    // case would certify the dead control it exists to catch.
    platformOS: 'web' as 'web' | 'ios',
}));
const routerPushSpy = vi.hoisted(() => vi.fn());

installSessionActionsCommonModuleMocks({
    text: () =>
        createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) =>
                key === 'session.openSubagents' && values && typeof values.count === 'number'
                    ? `session.openSubagents:${values.count}`
                    : key,
        }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: layoutState.windowWidthPx, height: 900 }),
            Platform: Object.defineProperty({}, 'OS', {
                get: () => layoutState.platformOS,
                enumerable: true,
            }) as any,
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? true : undefined),
        });
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => layoutState.deviceType,
}));

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: 'session:s1',
        scopeState: {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
        },
        openRight: openRightSpy,
        closeRight: vi.fn(),
        setRightTab: setRightTabSpy,
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

describe('SessionHeaderSubagentsButton', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        layoutState.windowWidthPx = 1400;
        layoutState.deviceType = 'tablet';
        layoutState.platformOS = 'web';
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        routerPushSpy.mockClear();
    });

    it('opens the right panel on the agents tab when the layout can host one', async () => {
        const modulePromise = import('./SessionHeaderSubagentsButton');
        await expect(modulePromise).resolves.toHaveProperty('SessionHeaderSubagentsButton');
        const { SessionHeaderSubagentsButton } = await modulePromise;

        const screen = await renderScreen(
            <SessionHeaderSubagentsButton sessionId="s1" scopeId="session:s1" activeCount={2} />
        );

        const pressable = screen.findByProps({ accessibilityLabel: 'session.openSubagents:2' });
        await pressTestInstanceAsync(pressable);

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'agents' });
        expect(setRightTabSpy).toHaveBeenCalledWith('agents');
        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(findTestInstanceByTypeContainingText(screen, 'Text', '2')).toBeTruthy();
        expect(
            findTestInstanceByTypeWithProps(screen, 'Icon', {
                name: 'robot',
                size: SESSION_HEADER_ICON_SIZE_PX,
            }),
        ).toBeTruthy();
    });

    /**
     * The dead control this button used to be. `resolvePaneLayout` returns `right: 'hidden'` on every
     * phone, so opening the pane there was a press that changed nothing at all — on the device where
     * this glyph is the only way into the roster.
     */
    it('opens the agents screen when the layout has no right pane to host', async () => {
        layoutState.deviceType = 'phone';
        layoutState.windowWidthPx = 390;
        layoutState.platformOS = 'ios';
        const { SessionHeaderSubagentsButton } = await import('./SessionHeaderSubagentsButton');

        const screen = await renderScreen(
            <SessionHeaderSubagentsButton sessionId="s1" scopeId="session:s1" activeCount={2} />
        );

        await pressTestInstanceAsync(screen.findByProps({ accessibilityLabel: 'session.openSubagents:2' }));

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/agents');
        expect(openRightSpy).not.toHaveBeenCalled();
    });

    it('keeps the session server scope on the screen it opens', async () => {
        layoutState.deviceType = 'phone';
        layoutState.windowWidthPx = 390;
        layoutState.platformOS = 'ios';
        const { SessionHeaderSubagentsButton } = await import('./SessionHeaderSubagentsButton');

        const screen = await renderScreen(
            <SessionHeaderSubagentsButton sessionId="s1" scopeId="session:s1" serverId="srv_2" activeCount={1} />
        );

        await pressTestInstanceAsync(screen.findByProps({ accessibilityLabel: 'session.openSubagents:1' }));

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/agents?serverId=srv_2');
    });

    // The header slot reports what is happening now. It used to appear for any session that had
    // ever run a subagent — permanently lit, and so carrying no information. The always-available
    // destination is the folded overflow item, which is what a phone actually shows.
    it('renders nothing when no agent is currently active', async () => {
        const { SessionHeaderSubagentsButton } = await import('./SessionHeaderSubagentsButton');

        const screen = await renderScreen(
            <SessionHeaderSubagentsButton sessionId="s1" scopeId="session:s1" activeCount={0} />
        );

        expect(screen.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
        expect(screen.root.findAllByProps({ name: 'robot' })).toHaveLength(0);
    });
});
