import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { HeaderActionsScope, useStackHeaderActionsClaimed, useStackHeaderActionsPublisher, type LentHeaderMenuRow } from '@/components/navigation/stackHeaderActions';
import * as reducer from '@/sync/domains/browser/control/reducer';

const windowSize = vi.hoisted(() => ({ width: 390, height: 844 }));

// The phone composition is decided by the window as well as the container (canonical React Native boundary mock).
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ ...windowSize, scale: 3, fontScale: 1 }) });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const session = createSessionFixture({ id: 'session_1', metadataLayoutVersion: 0, metadata: { path: '/repo', host: 'mac', flavor: 'claude' } as never });
    const storage = createStorageStoreMock({ sessions: { session_1: session } });
    return createStorageModuleStub({ storage, getStorage: () => storage, useSession: (id: string) => (id === 'session_1' ? session : null) });
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const SCOPE = 'details-group:test';
const pin = vi.fn();
const close = vi.fn();
const ROWS: readonly LentHeaderMenuRow[] = [
    { id: 'details-tab-pin', title: 'Pin tab', testID: 'details-tab-menu-pin', iconName: 'push-pin', onSelect: pin },
    { id: 'details-tab-close', title: 'Close tab', testID: 'details-tab-menu-close', iconName: 'x', onSelect: close },
];
const renderNothing = () => null;

/** The Details group's side of the contract (DetailsTabGroupPanel): it lends, and keeps its strip while nobody claims. */
function LendingGroup(props: React.PropsWithChildren) {
    useStackHeaderActionsPublisher(SCOPE, renderNothing, ROWS);
    const claimed = useStackHeaderActionsClaimed(SCOPE);
    return <>
        {claimed ? null : <React.Fragment><StripMarker /></React.Fragment>}
        <HeaderActionsScope scopeKey={SCOPE}>{props.children}</HeaderActionsScope>
    </>;
}
function StripMarker() { return <ReactNativeView testID="group-strip" />; }
const ReactNativeView = (props: { testID: string }) => React.createElement('View', props);

describe('BrowserShell takes a lending Details group\'s controls on a phone (DESIGN-ACCEPT-140 item 8)', () => {
    it.each(['launchpad', 'page'] as const)('folds the group strip in the %s state and carries pin and close in its one ⋯', async (mode) => {
        windowSize.width = 390;
        const { BrowserShell } = await import('./BrowserShell');
        const state = mode === 'page' ? await pageState() : reducer.createBrowserControlState();
        const screen = await renderScreen(
            <LendingGroup>
                <BrowserShell browserSessionId="browser_session_1" platform="web" state={state} onCommand={vi.fn()}
                    onOpenNewTab={vi.fn()} onCloseTab={vi.fn()} testID="browser-shell" />
            </LendingGroup>,
        );
        try {
            // One tab bar on a phone: the Browser claims what the strip offered, so the strip folds.
            expect(screen.findByTestId('group-strip')).toBeFalsy();
            const menus = screen.findAll((node) => node.props?.testID === 'browser-shell-overflow' && Array.isArray(node.props.items));
            expect(menus.length).toBeGreaterThan(0);
            const items = menus[0]!.props.items as { id: string; onPress: () => void }[];
            expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(['details-tab-pin', 'details-tab-close']));
            // The group's close (it also ends the pane with its last page) stands in for the page's own Close tab.
            expect(items.map((item) => item.id)).not.toContain('close-tab');
            items.find((item) => item.id === 'details-tab-close')!.onPress();
            expect(close).toHaveBeenCalled();
        } finally {
            await screen.unmount();
        }
    });

    it('leaves a wide window\'s strip alone: a desktop Browser claims nothing', async () => {
        windowSize.width = 1440;
        const { BrowserShell } = await import('./BrowserShell');
        const screen = await renderScreen(
            <LendingGroup>
                <BrowserShell browserSessionId="browser_session_1" platform="web" state={await pageState()} onCommand={vi.fn()}
                    onOpenNewTab={vi.fn()} onCloseTab={vi.fn()} testID="browser-shell" />
            </LendingGroup>,
        );
        try {
            expect(screen.findByTestId('group-strip')).toBeTruthy();
        } finally {
            await screen.unmount();
            windowSize.width = 390;
        }
    });
});

async function pageState() {
    const { buildBrowserAdapterCapabilities } = await import('@/sync/domains/browser/adapters/capabilities');
    return [
        { kind: 'sessionCreated', eventId: 'e1', browserSessionId: 'browser_session_1', profileId: 'profile_1', occurredAt: 1 },
        {
            kind: 'viewOpened', eventId: 'e2', browserSessionId: 'browser_session_1', viewId: 'view_1',
            target: { kind: 'externalUrl', targetId: 'page_1', url: 'https://en.wikipedia.org/wiki/Checkout' }, platform: 'web',
            currentUrl: 'https://en.wikipedia.org/wiki/Checkout', adapterKind: 'externalUrl', engineKind: 'webIframe',
            adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'] }),
            occurredAt: 2,
        },
        { kind: 'viewFocused', eventId: 'e3', browserSessionId: 'browser_session_1', viewId: 'view_1', occurredAt: 3 },
    ].reduce((state, event) => reducer.applyBrowserControlEvent(state, event as never), reducer.createBrowserControlState());
}
