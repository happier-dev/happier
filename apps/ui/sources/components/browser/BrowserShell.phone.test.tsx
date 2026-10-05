import * as React from 'react';
import type { BrowserEventV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';

// The phone composition is decided by the window (a compact device) as well as the container, so
// this file pins the window at a 390 × 844 phone through the canonical React Native boundary mock.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const session = createSessionFixture({ id: 'session_1', metadataLayoutVersion: 0, metadata: { path: '/repo', host: 'mac', flavor: 'claude' } as never });
    const storage = createStorageStoreMock({ sessions: { session_1: session } });
    return createStorageModuleStub({
        storage,
        getStorage: () => storage,
        useSession: (id: string) => (id === 'session_1' ? session : null),
    });
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

vi.mock('@/sync/domains/local/services/preview/useLocalServicePreviewState', () => ({
    useLocalServicePreviewState: () => null,
}));

async function createPageState() {
    const reducer = await import('@/sync/domains/browser/control/reducer');
    const events: readonly BrowserEventV1[] = [{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: 'browser_session_1',
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: { kind: 'externalUrl', targetId: 'page_1', url: 'https://app.lumen.test/login' },
        platform: 'web',
        currentUrl: 'https://app.lumen.test/login',
        adapterKind: 'externalUrl',
        engineKind: 'webIframe',
        adapterCapabilities: {
            ...buildBrowserAdapterCapabilities({
                adapterKind: 'externalUrl',
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: ['webIframe'],
            }),
            navigation: { canNavigate: true, canGoBack: true, canGoForward: false, canReload: true, canStop: false },
        },
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        occurredAt: 1_002,
    }, {
        kind: 'navigationFinished',
        eventId: 'event_loaded',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        currentUrl: 'https://app.lumen.test/login',
        occurredAt: 1_003,
    }];
    return events.reduce(
        (state, event) => reducer.applyBrowserControlEvent(state, event),
        reducer.createBrowserControlState(),
    );
}

describe('BrowserShell on a phone', () => {
    it('recomposes the chrome: the host capsule on top, the page controls in a bottom bar', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={await createPageState()}
                onCommand={vi.fn()}
                testID="browser-shell"
            />,
        );

        // The address capsule names the host only; the path waits for a tap.
        expect(screen.findByTestId('browser-shell-address')?.props.value).toBe('app.lumen.test');

        // Back, forward, reload and ⋯ live in the bottom bar, not beside the address.
        const bar = screen.findByTestId('browser-shell-bottom-bar');
        expect(bar).toBeTruthy();
        for (const control of ['browser-shell-back', 'browser-shell-forward', 'browser-shell-reload', 'browser-shell-overflow']) {
            expect(bar?.findAll((node) => node.props.testID === control).length, control).toBeGreaterThan(0);
        }
        const top = screen.findByTestId('browser-shell-top-bar');
        expect(top?.findAll((node) => node.props.testID === 'browser-shell-back')).toHaveLength(0);
    });

    it('keeps the page tools out of the bar while the agent drives its own browser (lab A)', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const { createBrowserContextState } = await import('@/sync/domains/browser/context');
        const opened: readonly BrowserEventV1[] = [{
            kind: 'sessionCreated', eventId: 'e1', browserSessionId: 'browser_session_1', profileId: 'profile_1', occurredAt: 1,
        }, {
            kind: 'viewOpened', eventId: 'e2', browserSessionId: 'browser_session_1', viewId: 'view_1',
            target: { kind: 'externalUrl', targetId: 'page_1', url: 'http://localhost:5173/login' },
            platform: 'web', currentUrl: 'http://localhost:5173/login', adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
            adapterCapabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'chromiumSidecar', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'],
            }),
            occurredAt: 2,
        }, { kind: 'viewFocused', eventId: 'e3', browserSessionId: 'browser_session_1', viewId: 'view_1', occurredAt: 3 }];
        const base = opened.reduce((state, event) => reducer.applyBrowserControlEvent(state, event), reducer.createBrowserControlState());
        const withController = (controller: 'agent' | 'human') => reducer.applyBrowserControlEvent(base, {
            kind: 'controllerChanged', eventId: `c_${controller}`, browserSessionId: 'browser_session_1', viewId: 'view_1', occurredAt: 4,
            state: { browserSessionId: 'browser_session_1', viewId: 'view_1', controller, controlEpoch: controller === 'agent' ? 1 : 2 },
        } as BrowserEventV1);
        const context: NonNullable<React.ComponentProps<typeof BrowserShell>['browserContext']> = {
            state: createBrowserContextState(),
            contextCapabilities: {
                enabled: true, available: true, supportedContextKinds: ['browserPageReference'], supportedAdapterKinds: ['chromiumSidecar'],
                screenshot: { supported: false, requiresAttachmentUploads: true }, text: { maxSelectionChars: 2048, maxSummaryChars: 8192 },
                disabledReasons: [], policyDeniedReasons: [],
            },
            attachmentsUploadsEnabled: true,
            onStateChange: vi.fn(),
            nowMs: () => 1,
        };
        const render = (state: ReturnType<typeof withController>) => (
            <BrowserShell browserSessionId="browser_session_1" platform="web" state={state} onCommand={vi.fn()} browserContext={context} agent={{ sessionId: 'session_1' }} testID="browser-shell" />
        );

        const screen = await renderScreen(render(withController('agent')));
        expect(screen.findByTestId('browser-shell-attach-page')).toBeFalsy();
        // The capsule names the session's agent even though in-app automation is not part of this
        // surface: the daemon's view is the agent's browser either way.
        expect(screen.getTextContent()).toContain('browserPresence.agentBrowsing');
        expect(screen.getTextContent()).not.toContain('browserPresence.agentFallbackName');

        // A host that knows the agent without this client holding the Session record names it too.
        await screen.update(
            <BrowserShell browserSessionId="browser_session_1" platform="web" state={withController('agent')} onCommand={vi.fn()} browserContext={context} agent={{ sessionId: 'elsewhere', knownAgentId: 'claude' }} testID="browser-shell" />,
        );
        expect(screen.getTextContent()).not.toContain('browserPresence.agentFallbackName');

        // The person has the page: Attach page returns, so what they signed in to can go to the chat.
        await screen.update(render(withController('human')));
        expect(screen.findByTestId('browser-shell-attach-page')).toBeTruthy();
    });

    it('shows the launchpad on its own, with no browser chrome around it (lab W)', async () => {
        const { BrowserShell } = await import('./BrowserShell');
        const reducer = await import('@/sync/domains/browser/control/reducer');
        const screen = await renderScreen(
            <BrowserShell
                browserSessionId="browser_session_1"
                platform="web"
                state={reducer.createBrowserControlState()}
                onCommand={vi.fn()}
                onNavigateInPlace={vi.fn()}
                testID="browser-shell"
            />,
        );

        expect(screen.findByTestId('browser-shell-launchpad-url-entry')).toBeTruthy();
        expect(screen.findByTestId('browser-shell-address')).toBeFalsy();
        expect(screen.findByTestId('browser-shell-bottom-bar')).toBeFalsy();
    });
});
