/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { installBrowserStorageLockBoundary } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// RNW's real DOM hosts and browser History remain in the composed path.
vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { StyleSheet } = await vi.importActual<typeof import('react-native')>('react-native-web');
    return createUnistylesMock({ styleSheet: { absoluteFillObject: StyleSheet.absoluteFillObject } });
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => window.location.pathname,
    params: () => Object.fromEntries(new URLSearchParams(window.location.search)),
}).module);
vi.mock('expo-router/build/fork/getPathFromState', async () =>
    (await import('@/dev/testkit/runtime/installedExpoPathSerializer')).loadInstalledExpoPathSerializer());
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const loadProduction = () => Promise.all([
    import('@/components/appShell/workspace/WorkspaceProvider'),
    import('@/components/appShell/workspace/DestinationInstanceHost'),
    import('@/components/appShell/workspace/destinationRoute'),
    import('@/components/appShell/destinations/compactAppDestinationCatalog'),
    import('@/sync/domains/state/storage'),
    import('@/keyboard/focusReturn'),
    import('./useNavigationFocusReturn'),
    import('@/components/ui/panels/RetainedPanelSurface'),
]);
const production = await (async () => {
    const locks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    const home = await serveActionHomes({ homes: [{ key: 'import', serverUrl: 'https://continuity-import.test',
        accountId: 'alice', currentAccount: true }], route: () => undefined });
    const disconnect = await home.restoreActiveConnection();
    try { return await loadProduction(); }
    finally { await disconnect(); await home.dispose(); locks(); }
})();
const [{ WorkspaceProvider }, { DestinationInstanceHost }, { useLocalSearchParams, useRouter },
    { hrefForDestinationRef, resolveCompactAppDestinations }, { storage }, { FocusReturnProvider },
    { useNavigationFocusReturn }, { RetainedPanelSurface }] = production;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
});

/** Inert page content; navigation, tab retention, focus effects and History are production owners. */
function Page(props: Readonly<{ phone: boolean }>) {
    const router = useRouter();
    const { view = 'listing' } = useLocalSearchParams<{ view?: string }>();
    const navigate = useNavigationFocusReturn();
    const listing = '/plugins/listing?selection=%7B%22type%22%3A%22registryItem%22%2C%22kind%22%3A%22skill%22%2C%22sourceId%22%3A%22catalog%22%2C%22itemId%22%3A%22review%22%7D';
    const next = props.phone ? listing : view === 'discover' ? '/plugins?view=jobs'
        : view === 'jobs' ? '/plugins?view=job&job=browser' : listing;
    return <div data-testid={`page-${view}`}>
        <div data-testid={`content-${view}`}>
            <button data-testid={`open-${view}`} onClick={() => navigate(() => router.pushRetainingCurrent(next))}>Open</button>
            <button data-testid={`back-${view}`} onClick={() => router.back()}>Back</button>
        </div>
    </div>;
}

async function mount(initialView: 'discover' | 'search', width: number) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.closest('[aria-hidden="true"]') ? new DOMRect() : new DOMRect(0, 0, width, 80);
    });
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
        const rects = this.closest('[aria-hidden="true"]') ? [] : [new DOMRect(0, 0, width, 80)];
        return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
    });
    // jsdom supplies focus/activeElement but no browser layout/scroll engine.
    // Model the browser's permitted scroll-on-focus at that OS boundary only.
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        focus.call(this, options);
        const scroller = this.closest<HTMLElement>('[data-testid^="page-"]');
        if (scroller && !options?.preventScroll) scroller.scrollTop = 81;
    });
    const locks = installBrowserStorageLockBoundary();
    cleanups.push(locks);
    installDisconnectedServerSocketBoundary();
    const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: `https://continuity-${initialView}-${width}.test`,
        accountId: 'alice', currentAccount: true }], route: () => undefined });
    cleanups.push(homes.dispose);
    const disconnect = await homes.restoreActiveConnection();
    cleanups.push(disconnect);
    const previous = storage.getState();
    cleanups.push(() => { storage.setState(previous, true); });
    storage.setState({ isDataReady: true });
    window.history.replaceState(null, '', `/plugins?view=${initialView}`);
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    await act(async () => { root.render(<FocusReturnProvider><WorkspaceProvider enabled={width !== 390} phone={width === 390} catalog={catalog}>
        {navigation => <>{Object.values(navigation.state.tabs).map(tab => {
            const group = navigation.state.groups[navigation.state.focusedGroupId];
            const active = tab.id === group.activeTabId;
            const href = hrefForDestinationRef(catalog, tab.target);
            if (!href) throw new Error('Unadmitted destination');
            return <RetainedPanelSurface key={tab.id} isActive={active}>
                <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={href.split('?')[0]!}
                    focused={active} visible={active} navigation={navigation.navigationForTab(tab.id)}><Page phone={width === 390} /></DestinationInstanceHost>
            </RetainedPanelSurface>;
        })}</>}
    </WorkspaceProvider></FocusReturnProvider>); });
    const element = (id: string) => {
        const nodes = Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
        const visible = nodes.filter(node => !node.closest('[aria-hidden="true"]'));
        if (visible.length === 1) return visible[0]!;
        if (nodes.length === 1) return nodes[0]!;
        throw new Error(`Missing or ambiguous ${id}`);
    };
    const click = async (id: string) => {
        await act(async () => { element(id).focus({ preventScroll: true }); element(id).click(); });
    };
    const returned = async (view: string) => {
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(element(`page-${view}`).closest('[aria-hidden="true"]')).toBeNull();
        });
    };
    await returned(initialView);
    return { element, click, returned };
}

it('returns through All jobs and job to each original control without moving retained scroll', async () => {
    const h = await mount('discover', 1440);
    h.element('page-discover').scrollTop = 199;
    await h.click('open-discover'); await h.returned('jobs');
    h.element('page-jobs').scrollTop = 320;
    await h.click('open-jobs'); await h.returned('job');
    await h.click('back-job'); await h.returned('jobs');
    expect(h.element('page-jobs').scrollTop).toBe(320);
    expect(document.activeElement).toBe(h.element('open-jobs'));
    await h.click('back-jobs'); await h.returned('discover');
    expect(h.element('page-discover').scrollTop).toBe(199);
    expect(document.activeElement).toBe(h.element('open-discover'));
});

it.each(['discover', 'search'] as const)('preserves phone %s scroll and trigger through listing push and real Back', async view => {
    const h = await mount(view, 390);
    const open = h.element(`open-${view}`);
    h.element(`page-${view}`).scrollTop = 650;
    await h.click(`open-${view}`);
    await h.returned('listing');
    await h.click('back-listing'); await h.returned(view);
    expect(h.element(`page-${view}`).scrollTop).toBe(650);
    expect(document.activeElement).toBe(open);
});

it.each(['none', 'move', 'stay'] as const)('restores phone Search after a bottom clamp without overriding reader input (input=%s)', async readerInput => {
    // Browser layout boundary: jsdom cannot clamp scrollTop or deliver ResizeObserver measurements.
    const observers = new Set<BrowserResizeObserver>();
    class BrowserResizeObserver implements ResizeObserver {
        readonly targets = new Set<Element>();
        constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
        observe(target: Element) { this.targets.add(target); }
        unobserve(target: Element) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
    }
    vi.stubGlobal('ResizeObserver', BrowserResizeObserver);
    const h = await mount('search', 390);
    const page = h.element('page-search');
    const content = h.element('content-search');
    const open = h.element('open-search');
    let height = 8524;
    let top = 0;
    Object.defineProperties(page, {
        scrollHeight: { get: () => height },
        clientHeight: { get: () => 788 },
        scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 788)); } },
    });
    const resize = async () => {
        await act(async () => {
            // Footer/rows can change the content wrapper without resizing the viewport.
            for (const observer of observers) if (observer.targets.has(content)) observer.callback([], observer);
        });
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        page.scrollTop = 7736;
        page.dispatchEvent(new Event('scroll'));
        await h.click('open-search'); await h.returned('listing');
        page.scrollTop = 0;
        page.dispatchEvent(new Event('scroll'));
        height = 8470;
        await h.click('back-listing'); await h.returned('search');
        // A real browser queues this event for its clamped restoration, not reader input.
        page.dispatchEvent(new Event('scroll'));
        if (readerInput !== 'none') {
            page.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
            if (readerInput === 'move') {
                page.scrollTop = 6500;
                page.dispatchEvent(new Event('scroll'));
            }
        }
        height = 8524;
        await resize();
        expect(page.scrollTop).toBe(readerInput === 'none' ? 7736 : readerInput === 'move' ? 6500 : 7682);
        expect(document.activeElement).toBe(open);
        expect(Array.from(observers).some(observer => observer.targets.has(page) || observer.targets.has(content))).toBe(false);
    }
    // A wheel at the temporary bottom may not emit scroll at all. The next push/Back must
    // retain that accepted position, not revive the older, cancelled pending request.
    if (readerInput === 'stay') {
        await h.click('open-search'); await h.returned('listing');
        page.scrollTop = 0;
        await h.click('back-listing'); await h.returned('search');
        expect(page.scrollTop).toBe(7682);
    }
});
