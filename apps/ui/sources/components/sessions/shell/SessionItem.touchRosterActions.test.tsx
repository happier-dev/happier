// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { createSessionFixture, renderScreen as renderCanonicalScreen, standardCleanup } from '@/dev/testkit';
import { createModelBackedSessionItemTestComponent } from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { SESSION_ACTION_PIN_ID } from '@/components/sessions/actions/sessionActionIds';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

const navigateToSession = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
    // Install the browser port before any import can read the cached primary-pointer fact.
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(pointer: coarse)' || query === '(hover: none)', media: query,
        addEventListener() {}, removeEventListener() {},
    }));
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { navigate: navigateToSession } }).module;
    },
});
vi.doUnmock('@/agents/registry/registryUiBehavior');
vi.doUnmock('@/hooks/session/useDraft');
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

function installTouchBrowserBoundary() {
    // Primary-pointer detection reads the browser's global media API before the row mounts.
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(pointer: coarse)' || query === '(hover: none)', media: query,
        addEventListener() {}, removeEventListener() {},
    }));
}
installTouchBrowserBoundary();
const { SessionItem } = await import('./SessionItem');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);
let previousState = storage.getState();
let serverId: string;
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests> | undefined;

function createSession(id: string) {
    return createSessionFixture({ id, metadata: null, presence: 1 });
}

function renderScreen(element: React.ReactElement) {
    return renderCanonicalScreen(<InjectedAuthProvider credentials={{ token: 'touch-row-test' }}>
        {element}
    </InjectedAuthProvider>);
}

describe('SessionItem row actions on a touch screen', () => {
    beforeEach(async () => {
        installTouchBrowserBoundary();
        previousState = storage.getState();
        await home.reset();
        serverId = await home.addHome({ name: 'Touch row Home', serverUrl: 'https://touch-row.test', accountId: 'u1' });
        portalBoundary = installReactDomPortalBoundaryForTests();
    });
    afterEach(async () => {
        await standardCleanup();
        portalBoundary?.restore();
        portalBoundary = undefined;
        await home.reset();
        storage.setState(previousState, true);
        vi.unstubAllGlobals();
        navigateToSession.mockClear();
    });

    it('keeps a Bot roster row\'s actions beside it without hover (lab b-rail Ap), while an ordinary row still reveals on hover only', async () => {
        const roster = await renderScreen(<ModelBackedSessionItem session={createSession('bot_1')} serverId={serverId}
            selected={false} variant="default" compact embedded showTalkAction actionMenuSurface="botsRoster" onTogglePinned={vi.fn()} />);
        // The row's trailing actions are drawn with no hover at all.
        expect(roster.findAll(node => node.props?.accessibilityLabel === 'sessionInfo.pinSession').length).toBeGreaterThan(0);
        await roster.unmount();

        const ordinary = await renderScreen(<ModelBackedSessionItem session={createSession('sess_1')} serverId={serverId}
            selected={false} variant="default" compact onTogglePinned={vi.fn()} />);
        expect(ordinary.findAll(node => node.props?.accessibilityLabel === 'sessionInfo.pinSession')).toHaveLength(0);
        await ordinary.unmount();
    });

    it('mounts no closed menu or copy-feedback component per row until one opens', async () => {
        const { ContextMenu } = await import('@/components/ui/forms/dropdown/ContextMenu');
        const { CopiedPill } = await import('@/components/ui/copy/CopiedPill');
        const screen = await renderScreen(<ModelBackedSessionItem session={createSession('sess_closed')} serverId={serverId}
            selected={false} variant="default" compact onTogglePinned={vi.fn()} />);
        // Every list row pays for what it mounts: closed menus and hidden feedback cost nothing.
        expect(screen.findAll(node => node.type === ContextMenu)).toHaveLength(0);
        expect(screen.findAll(node => node.type === CopiedPill)).toHaveLength(0);
        const row = screen.findHostByTestId('session-list-item-sess_closed');
        if (!row) throw new Error('Expected the ordinary touch-browser row');
        await act(async () => { row.props.onLongPress(); });
        expect(screen.findAll(node => node.type === ContextMenu && node.props.open === true)).toHaveLength(1);
        await screen.unmount();
    });

    it('opens the ordinary row pin menu on touch-browser long-press and suppresses the release navigation', async () => {
        const screen = await renderScreen(<ModelBackedSessionItem session={createSession('sess_touch_menu')} serverId={serverId}
            selected={false} variant="default" compact onTogglePinned={vi.fn()} />);
        const row = screen.findHostByTestId('session-list-item-sess_touch_menu');
        if (!row) throw new Error('Expected the ordinary touch-browser row');
        expect(row.props.onLongPress).toEqual(expect.any(Function));
        await act(async () => { row.props.onLongPress(); });
        const menus = screen.findAll(node => node.props.open === true
            && Array.isArray(node.props.items)
            && node.props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_PIN_ID));
        expect(menus.length).toBeGreaterThan(0);
        await act(async () => { row.props.onPress(); });
        expect(navigateToSession).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
