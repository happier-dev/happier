import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import { ExternalUrlTarget } from './ExternalUrlTarget';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async (_url: string) => true));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: (url: string) => openExternalUrlMock(url),
}));

function createExternalUrlView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_external_1',
        target: {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://example.com/',
            display: { title: 'Example', addressLabel: 'example.com' },
        },
        platform: 'web',
        adapterKind: 'externalUrl',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['webIframe'],
        }),
        currentUrl: 'https://example.com/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Example',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://example.com/',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

describe('ExternalUrlTarget (web)', () => {
    beforeEach(() => {
        openExternalUrlMock.mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('fails closed until a policy-backed external browsing adapter exists', async () => {
        const screen = await renderScreen(<ExternalUrlTarget testID="external-url" />);

        expect(screen.findByTestId('external-url-unavailable')).toBeTruthy();
    });

    it('renders the web iframe inline for an allowed external URL on web', async () => {
        const screen = await renderScreen(
            <ExternalUrlTarget testID="external-url" view={createExternalUrlView()} />,
        );

        // The iframe engine renders for a webIframe external URL (B-RC4) — not the "unavailable" state.
        expect(screen.findByTestId('external-url')).toBeTruthy();
    });

    it('renders an always-present open-in-browser escape over the web iframe (verdict-independent) and opens the system browser when pressed', async () => {
        const screen = await renderScreen(
            <ExternalUrlTarget testID="external-url" view={createExternalUrlView()} />,
        );

        // The iframe renders (pending/framable verdict) AND an always-present escape is shown:
        // cross-origin framability is not reliably detectable (an X-Frame-Options frame can fire
        // onLoad against a blank document → a false "framable" verdict and a silent blank frame),
        // so this escape is NOT gated on the verdict — it is the guaranteed exit on every web frame.
        expect(screen.findByTestId('external-url')).toBeTruthy();
        const escape = screen.findByTestId('external-url-external-escape');
        expect(escape).toBeTruthy();

        await act(async () => {
            (escape?.props as { onPress?: () => void }).onPress?.();
        });
        await vi.waitFor(() => {
            expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
        });
    });

    it('shows the non-framable fallback and opens the system browser when the load times out', async () => {
        vi.useFakeTimers();
        const screen = await renderScreen(
            <ExternalUrlTarget testID="external-url" view={createExternalUrlView()} />,
        );

        await act(async () => {
            vi.advanceTimersByTime(5000);
        });

        const action = screen.findByTestId('external-url-non-framable-open');
        expect(action).toBeTruthy();

        await act(async () => {
            (action?.props as { onPress?: () => void }).onPress?.();
        });
        await vi.waitFor(() => {
            expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
        });
    });
});
