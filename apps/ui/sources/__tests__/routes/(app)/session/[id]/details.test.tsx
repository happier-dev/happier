import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit';
import { getStyleValue, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));

let mockServerId: string | undefined;
let isFocused = true;
let mockDetailsParam: string | undefined;
let mockPathParam: string | undefined;
let mockShaParam: string | undefined;
let mockTerminalInstanceIdParam: string | undefined;
let mockSourceSurfaceParam: string | undefined;
let canGoBack = true;
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let viewport = { width: 1200, height: 900, scale: 1, fontScale: 1 };
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerSetParamsSpy = vi.fn();
const routerMock = createExpoRouterMock({
    params: () => ({ id: 'session-1', serverId: mockServerId, details: mockDetailsParam,
        path: mockPathParam, sha: mockShaParam, terminalInstanceId: mockTerminalInstanceIdParam, sourceSurface: mockSourceSurfaceParam }),
    navigation: createNavigationPropMock({ canGoBack: () => canGoBack }),
    router: { back: routerBackSpy, push: vi.fn(), replace: routerReplaceSpy, setParams: routerSetParamsSpy },
});
installSessionRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ useWindowDimensions: () => viewport }),
    router: () => routerMock.module,
    nativeNavigation: async () => ({
        ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }),
        useIsFocused: () => isFocused,
    }),
    safeAreaInsets: { top: 21, bottom: 31 },
});

// Global setup resets DOM ports before every case. Register this outer fixture
// before the pane harness so its Account rollback finishes before browser cleanup.
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let previousImage: PropertyDescriptor | undefined;
beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://session-pane.test' });
    previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
    Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: browser.window.Image });
});
afterEach(() => {
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
    else Reflect.deleteProperty(globalThis, 'Image');
    browser?.restore(); browser = undefined;
});

let holdSessionRead: Promise<void> | undefined;
let releaseSessionRead: (() => void) | undefined;
afterEach(() => releaseSessionRead?.());
const sessionReads: string[] = [];
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-1',
    scopeId: ({ sessionId }) => createSessionPaneScopeId(sessionId, mockServerId),
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path !== '/v2/sessions/session-1') return null;
        sessionReads.push(path);
        if (holdSessionRead) await waitForNetworkResponseForTests(holdSessionRead, init?.signal);
        return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({
            id: 'session-1', serverId: runtime.serverId, metadataVersion: 0,
        })));
    },
});
const { storage } = await import('@/sync/domains/state/storageStore');
const { createSessionCommitDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { SessionDetailsPanel } = await import('@/components/sessions/panes/SessionDetailsPanel');
const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');
const Screen = (await import('@/app/(app)/session/[id]/details')).default;
// React Test Renderer exposes the inner function of a simple memo component.
const detailsPanelType = Reflect.get(SessionDetailsPanel, 'type') ?? SessionDetailsPanel;
const cockpitType = Reflect.get(SessionCockpitShell, 'type') ?? SessionCockpitShell;
type ScreenResult = Awaited<ReturnType<typeof renderCanonicalScreen>>;

async function renderScreen(seed?: () => void | Promise<void>) {
    // The shared credential fixture also installs React Native. Override the
    // actual SDK viewport port, not the internal device/cockpit decision.
    const native = await import('react-native');
    vi.spyOn(native, 'useWindowDimensions').mockImplementation(() => viewport);
    // Presentation geometry reads the Dimensions authority (usePresentationWindowDimensions).
    vi.spyOn(native.Dimensions, 'get').mockImplementation(() => viewport);
    storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: mobileWorkspaceExperience });
    // The actual pane probe must mount before its public actions can seed retained state.
    // Mount the route only after those actions have settled, so it sees the same state as a real return.
    const screen = await renderCanonicalScreen(<></>, { wrapper: runtime.Wrapper, createNodeMock: element => Object.assign(
        document.createElement(element.type === 'TextInput' ? 'textarea' : 'div'), { setNativeProps() {},
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100) }) });
    if (seed) await seed();
    await screen.update(<Screen />);
    return screen;
}
async function openReadme() { await act(async () => runtime.pane.openDetailsTab(createWorkspaceFileDetailsTab('README.md'), { intent: 'pinned' })); }
function panel(screen: ScreenResult) { return screen.findByType(detailsPanelType); }
async function splitAndFocusEmptyGroup() {
    await openReadme();
    await act(async () => runtime.pane.splitDetailsGroup?.({ axis: 'horizontal' }));
    const emptyGroup = runtime.pane.scopeState?.details.groups?.find(group => group.tabs.length === 0);
    if (!emptyGroup || !runtime.pane.focusDetailsGroup) throw new Error('The real pane owner did not create an empty split group');
    await act(async () => runtime.pane.focusDetailsGroup?.(emptyGroup.id));
}
beforeEach(() => {
    mockServerId = undefined;
    isFocused = true;
    mockDetailsParam = undefined;
    mockPathParam = undefined;
    mockShaParam = undefined;
    mockTerminalInstanceIdParam = undefined;
    mockSourceSurfaceParam = undefined;
    canGoBack = true;
    mobileWorkspaceExperience = 'classic';
    viewport = { width: 1200, height: 900, scale: 1, fontScale: 1 };
    holdSessionRead = undefined; releaseSessionRead = undefined; sessionReads.length = 0;
    routerMock.resetParams();
    routerBackSpy.mockClear(); routerReplaceSpy.mockClear(); routerSetParamsSpy.mockClear();
});

describe('/session/[id]/details', () => {
    it('restores file details from route params before falling back to the session route', async () => {
        mockDetailsParam = 'file'; mockPathParam = 'README.md';
        await renderScreen();
        expect(runtime.pane.scopeState?.details.tabs).toEqual(expect.arrayContaining([expect.objectContaining({
            key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' },
        })]));
        expect(runtime.pane.scopeState?.details.activeTabKey).toBe('file:README.md');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });
    it('still restores the URL-selected details tab when split groups already exist', async () => {
        mockDetailsParam = 'file'; mockPathParam = 'README.md';
        await renderScreen(async () => {
            await act(async () => runtime.pane.openDetailsTab(createWorkspaceFileDetailsTab('OTHER.md'), { intent: 'pinned' }));
            await act(async () => runtime.pane.splitDetailsGroup?.({ axis: 'horizontal' }));
            const empty = runtime.pane.scopeState?.details.groups?.find(group => !group.tabs.length);
            if (!empty || !runtime.pane.focusDetailsGroup) throw new Error('Expected an actual empty details group');
            await act(async () => runtime.pane.focusDetailsGroup?.(empty.id));
        });
        expect(runtime.pane.scopeState?.details.tabs).toEqual(expect.arrayContaining([expect.objectContaining({
            key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' },
        })]));
        expect(runtime.pane.scopeState?.details.groups).toHaveLength(2);
    });
    it('returns to the Session route when there are no details tabs to display', async () => {
        await renderScreen();
        // Responsive pane presentation replaces the Session route with Details, so its previous
        // history entry need not be this Session: return by replacing with the Session href.
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });
    it('does not redirect away before the session has hydrated', async () => {
        mockServerId = runtime.serverId;
        holdSessionRead = new Promise(resolve => { releaseSessionRead = resolve; });
        storage.setState({ sessions: {} });
        const screen = await renderScreen();
        await waitForHomeGovernance(() => expect(sessionReads.length).toBeGreaterThan(0));
        expect(screen.findAllByType(detailsPanelType)).toHaveLength(0);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
        await screen.unmount();
        releaseSessionRead?.();
    });
    it('renders the shared SessionDetailsPanel when tabs exist', async () => {
        const screen = await renderScreen(openReadme);
        const root = screen.findHostByTestId('session-details-screen');
        expect(root).toBeTruthy();
        expect(panel(screen).props.sessionId).toBe('session-1');
        expect(panel(screen).props.scopeId).toBe(createSessionPaneScopeId('session-1'));
        expect(panel(screen).props.presentation).toBe('screen');
        expect(getStyleValue(root!, 'paddingTop')).toBe(21);
        expect(getStyleValue(root!, 'paddingBottom')).toBe(31);
    });
    it('renders a Details page link as the session cockpit shell on phone in cockpit mode', async () => {
        viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        mobileWorkspaceExperience = 'cockpit'; mockServerId = runtime.serverId;
        mockDetailsParam = 'file'; mockPathParam = 'README.md';
        const screen = await renderScreen();
        const cockpit = screen.findByType(cockpitType);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.routeServerId).toBe(runtime.serverId);
        expect(cockpit.props.surface).toBe('tabs');
        expect(cockpit.props.safeAreaPadding).toBe(false);
        const root = screen.findHostByTestId('session-cockpit-route-screen');
        expect(root).toBeTruthy();
        expect(getStyleValue(root!, 'paddingTop')).toBe(0);
        expect(getStyleValue(root!, 'paddingBottom')).toBe(31);
        // The real cockpit owns its nested panel; there must be no second classic-route panel.
        expect(screen.findAllByType(detailsPanelType).filter(node => node.props.showHeaderActions !== false)).toHaveLength(0);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
    // Owner 2026-11-17: the phone cockpit's Tabs surface lives on the Session route. An old `/details` link that
    // names no page lands there instead of building a second cockpit.
    it('redirects a page-less Details link on a phone cockpit to the Tabs surface of the Session route', async () => {
        viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        mobileWorkspaceExperience = 'cockpit'; mockServerId = runtime.serverId;
        const screen = await renderScreen();
        expect(routerReplaceSpy).toHaveBeenCalledWith(`/session/session-1?mobileSurface=tabs&serverId=${encodeURIComponent(runtime.serverId)}`);
        expect(screen.findAllByType(cockpitType)).toHaveLength(0);
    });
    it('does not dismiss the cockpit details route when details pane state closes', async () => {
        viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        mobileWorkspaceExperience = 'cockpit';
        mockDetailsParam = 'file'; mockPathParam = 'README.md';
        await renderScreen(openReadme);
        await act(async () => runtime.pane.closeDetails());
        expect(runtime.pane.scopeState?.details.isOpen).toBe(false);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
    it('stays on the fullscreen details route when the focused split group is empty but another group still has tabs', async () => {
        await renderScreen(splitAndFocusEmptyGroup);
        const groups = runtime.pane.scopeState?.details.groups ?? [];
        expect(groups).toHaveLength(2);
        expect(groups.find(group => group.isFocused)?.tabs).toHaveLength(0);
        expect(groups.some(group => group.tabs.some(tab => tab.key === 'file:README.md'))).toBe(true);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
    it('hydrates the session for deep links by requesting session visibility', async () => {
        mockServerId = runtime.serverId;
        storage.setState({ sessions: {} });
        const screen = await renderScreen(openReadme);
        await waitForHomeGovernance(() => expect(sessionReads.length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => expect(storage.getState().sessions['session-1']?.serverId).toBe(runtime.serverId));
        await waitForHomeGovernance(() => expect(screen.findAllByType(detailsPanelType)).toHaveLength(1));
    });
    it('keeps the fullscreen details route params in sync with the selected split details tab after mount', async () => {
        mockDetailsParam = 'file'; mockPathParam = 'README.md';
        await renderScreen(async () => {
            await openReadme();
            const commit = createSessionCommitDetailsTab('abc1234');
            if (!commit) throw new Error('Expected a valid commit tab');
            await act(async () => {
                runtime.pane.openDetailsTab(commit, { intent: 'pinned' });
                runtime.pane.setActiveDetailsTab('file:README.md');
            });
        });
        routerSetParamsSpy.mockClear();
        await act(async () => runtime.pane.setActiveDetailsTab('commit:abc1234'));
        expect(runtime.pane.scopeState?.details.activeTabKey).toBe('commit:abc1234');
        await waitForHomeGovernance(() => expect(routerSetParamsSpy).toHaveBeenCalledWith({
            details: 'commit', path: undefined, sha: 'abc1234', terminalInstanceId: undefined,
        }));
    });
    it('passes an onRequestClose that closes the pane and returns to the Session route', async () => {
        const screen = await renderScreen(async () => { await openReadme(); await act(async () => runtime.pane.openRight()); });
        await act(async () => panel(screen).props.onRequestClose());
        expect(runtime.pane.scopeState?.details.isOpen).toBe(false);
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
        expect(routerBackSpy).not.toHaveBeenCalled();
    });
    it('closes details pane state when the fullscreen details route unmounts', async () => {
        const screen = await renderScreen(openReadme);
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
        await screen.update(<></>);
        expect(runtime.pane.scopeState?.details.isOpen).toBe(false);
    });
    it('falls back to the source surface when a sourced details route has no back stack', async () => {
        canGoBack = false; mockServerId = runtime.serverId; mockSourceSurfaceParam = 'git';
        const screen = await renderScreen(openReadme);
        await act(async () => panel(screen).props.onRequestClose());
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith(`/session/session-1/git?serverId=${encodeURIComponent(runtime.serverId)}`);
    });
});
