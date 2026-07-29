import type { BrowserRenderEngineKindV1 } from '@happier-dev/protocol';
import { BrowserRenderEngineKindV1Schema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    browserViewLifecycleEvent,
    isClientRenderedBrowserEngine,
} from './lifecycle';

const TARGET = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;

describe('browser control lifecycle', () => {
    it('classifies every render engine kind as client-rendered or daemon-authoritative (exhaustive)', () => {
        // Build-failing exhaustiveness: a new engine kind in the protocol enum must be classified here.
        const expected: Record<BrowserRenderEngineKindV1, boolean> = {
            webIframe: true,
            nativeWebView: true,
            desktopWebView: true,
            electronWebContentsView: true,
            streamedSurface: false,
            unavailable: false,
        };
        for (const kind of BrowserRenderEngineKindV1Schema.options) {
            expect(isClientRenderedBrowserEngine(kind), `engine ${kind}`).toBe(expected[kind]);
        }
    });

    it('maps a load-finished signal onto navigationFinished (carrying the url when present)', () => {
        expect(browserViewLifecycleEvent(TARGET, { kind: 'loadFinished', url: 'https://example.test/app' })).toEqual({
            kind: 'navigationFinished',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            occurredAt: 0,
            eventId: 'browser_lifecycle:view_1:loadFinished',
            currentUrl: 'https://example.test/app',
        });
        // A urlless load-end (cross-origin iframe onLoad) still finishes — the reducer keeps the url.
        expect(browserViewLifecycleEvent(TARGET, { kind: 'loadFinished' })).toMatchObject({
            kind: 'navigationFinished',
        });
    });

    it('maps a load-failed signal onto navigationFailed with the error code', () => {
        expect(browserViewLifecycleEvent(TARGET, { kind: 'loadFailed', errorCode: 'webview_load_failed' })).toMatchObject({
            kind: 'navigationFailed',
            errorCode: 'webview_load_failed',
        });
    });

    it('maps load-started onto navigationStarted only when a url is present', () => {
        expect(browserViewLifecycleEvent(TARGET, { kind: 'loadStarted', url: 'https://example.test/' })).toMatchObject({
            kind: 'navigationStarted',
            pendingUrl: 'https://example.test/',
        });
        // navigationStarted requires a pendingUrl, so a urlless start is dropped.
        expect(browserViewLifecycleEvent(TARGET, { kind: 'loadStarted' })).toBeNull();
    });

    it('maps loading-progress onto loadingProgressChanged', () => {
        expect(browserViewLifecycleEvent(TARGET, { kind: 'loadingProgress', progress: 0.5 })).toMatchObject({
            kind: 'loadingProgressChanged',
            loadingProgress: 0.5,
        });
    });
});
