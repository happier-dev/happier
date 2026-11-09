import { BrowserContextCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';

import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control';
import { attachActiveBrowserPageReference, createBrowserContextState } from '@/sync/domains/browser/context';

import { DEMO_NOW_MS } from './constants';

export const DEMO_BROWSER_SESSION_ID = 'demo-browser-storefront';
export const DEMO_BROWSER_VIEW_ID = 'demo-browser-storefront-page';
export const DEMO_BROWSER_PAGE_URL = 'https://northstar.example.test/checkout';

/** Capture tooling fulfills this example URL with public/demo/storefront.html. */
export function buildDemoBrowserWorld() {
    const url = DEMO_BROWSER_PAGE_URL;
    const target = {
        kind: 'externalUrl',
        targetId: 'demo-storefront-preview',
        url,
        display: { title: 'Storefront · Checkout', addressLabel: 'Storefront preview' },
    } satisfies BrowserViewTargetV1;
    const capabilities = buildBrowserAdapterCapabilities({
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['webIframe'],
    });
    const state = applyBrowserControlEvent(applyBrowserControlEvent(createBrowserControlState(), {
        kind: 'sessionCreated', eventId: 'demo-browser-session-created',
        browserSessionId: DEMO_BROWSER_SESSION_ID, profileId: 'demo-browser-profile', occurredAt: DEMO_NOW_MS,
    }), {
        kind: 'viewOpened', eventId: 'demo-browser-page-opened',
        browserSessionId: DEMO_BROWSER_SESSION_ID, viewId: DEMO_BROWSER_VIEW_ID,
        target, platform: 'web', adapterKind: 'externalUrl', engineKind: 'webIframe',
        currentUrl: url,
        adapterCapabilities: capabilities, occurredAt: DEMO_NOW_MS,
    });
    const contextCapabilities = BrowserContextCapabilitiesSchema.parse({
        enabled: true, available: true,
        supportedContextKinds: ['browserPageReference'],
        supportedAdapterKinds: ['externalUrl'],
    });
    const attachedPage = attachActiveBrowserPageReference({
        state: createBrowserContextState(),
        browserContextEnabled: true,
        contextCapabilities,
        view: state.viewsById[DEMO_BROWSER_VIEW_ID] ?? null,
        capturedAtMs: DEMO_NOW_MS,
    });
    return { state, contextState: attachedPage.state, contextCapabilities };
}
