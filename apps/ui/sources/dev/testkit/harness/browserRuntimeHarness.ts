import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

/** A real DOM/event/storage port for browser fixtures; no Home or UI decisions are substituted. */
export async function installBrowserRuntimeForTests(options: Readonly<{ url: string; userAgent?: string; onNavigate?: (url: string) => void }>) {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: options.url, pretendToBeVisual: true });
    const { window } = dom;
    // JSDOM cannot navigate to another document. Replace only its native
    // Location.assign port, leaving the actual Window/Document and URL reader intact.
    let restoreNavigation: (() => void) | null = null;
    if (options.onNavigate) {
        const implementation = Reflect.ownKeys(window.location).map(key => Reflect.get(window.location, key))
            .find((value: unknown): value is object => Boolean(value && typeof value === 'object'
                && typeof Reflect.get(value, 'assign') === 'function' && typeof Reflect.get(value, 'href') === 'string'));
        if (!implementation) throw new Error('JSDOM Location navigation port is unavailable');
        const originalAssign: unknown = Reflect.get(implementation, 'assign');
        const navigate = (url: string) => options.onNavigate!(new URL(url, window.location.href).href);
        Reflect.set(implementation, 'assign', navigate);
        restoreNavigation = () => {
            if (Reflect.get(implementation, 'assign') === navigate) Reflect.set(implementation, 'assign', originalAssign);
        };
    }
    if (options.userAgent) Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: options.userAgent });
    const globals = {
        window,
        document: window.document,
        location: window.location,
        navigator: window.navigator,
        localStorage: window.localStorage,
        sessionStorage: window.sessionStorage,
        HTMLElement: window.HTMLElement,
        Element: window.Element,
        Node: window.Node,
        MutationObserver: window.MutationObserver,
        getComputedStyle: window.getComputedStyle.bind(window),
        requestAnimationFrame: window.requestAnimationFrame.bind(window),
        cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    };
    const prior = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries(globals)) {
        prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const locks = installWebLockManagerMock();
    let restored = false;
    return {
        window,
        document: window.document,
        storage: window.localStorage,
        reconfigureUrl(url: string) { dom.reconfigure({ url }); },
        restore() {
            if (restored) return;
            restored = true;
            locks.restore();
            restoreNavigation?.();
            window.close();
            for (const [name, descriptor] of prior) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
}
