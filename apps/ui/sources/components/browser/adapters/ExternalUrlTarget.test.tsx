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

    it('keeps a slow page loading with a quiet hint and an escape, and drops the hint when it loads (E-OE F07)', async () => {
        vi.useFakeTimers();
        const screen = await renderScreen(
            <ExternalUrlTarget testID="external-url" view={createExternalUrlView()} />,
        );
        // Nothing covers the page while it loads normally.
        expect(screen.findHostByTestId('external-url-slow-hint')).toBeNull();

        await act(async () => {
            vi.advanceTimersByTime(5000);
        });

        // Slow is not "refuses to be embedded": the frame stays, a hint names the escape.
        expect(screen.findByType('iframe')).toBeTruthy();
        expect(screen.findByTestId('external-url-non-framable')).toBeNull();
        const escape = screen.findByTestId('external-url-slow-hint-action');
        expect(escape).toBeTruthy();
        await act(async () => {
            (escape?.props as { onPress?: () => void }).onPress?.();
        });
        await vi.waitFor(() => {
            expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
        });

        await act(async () => {
            (screen.findByType('iframe').props as { onLoad?: () => void }).onLoad?.();
        });
        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
        });
        expect(screen.findHostByTestId('external-url-slow-hint')).toBeNull();
    });

    it('shows the non-framable fallback and opens the system browser when the frame reports an error', async () => {
        const screen = await renderScreen(
            <ExternalUrlTarget testID="external-url" view={createExternalUrlView()} />,
        );

        await act(async () => {
            (screen.findByType('iframe').props as { onError?: () => void }).onError?.();
        });

        const action = screen.findByTestId('external-url-non-framable-action');
        expect(action).toBeTruthy();

        await act(async () => {
            (action?.props as { onPress?: () => void }).onPress?.();
        });
        await vi.waitFor(() => {
            expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/');
        });
    });
});
