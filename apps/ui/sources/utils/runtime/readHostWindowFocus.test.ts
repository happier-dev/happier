import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HostEventHandler = (payload: unknown) => void;

const host = vi.hoisted(() => ({
    desktop: true,
    nativeFocused: false as boolean,
    handlers: new Map<string, HostEventHandler>(),
    invokes: [] as Array<{ command: string; args?: Record<string, unknown> }>,
}));

// The native shell boundary: window focus events and the window focus query.
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const { createDesktopHostModuleMock } = await import('@/dev/testkit/mocks/desktopHost');
    return createDesktopHostModuleMock({ importOriginal, overrides: {
        isDesktopHost: () => host.desktop,
        getDesktopHostWindowLabel: () => (host.desktop ? 'main' : null),
        invokeDesktopHost: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
            host.invokes.push({ command, args });
            if (command === 'plugin:window|is_focused') return host.nativeFocused as T;
            throw new Error(`unexpected command ${command}`);
        },
        listenDesktopHostEvent: async <T,>(event: string, handler: (payload: T) => void) => {
            host.handlers.set(event, handler as HostEventHandler);
            return () => host.handlers.delete(event);
        },
    } });
});

function setDocument(doc: { visibilityState?: string; hasFocus?: () => boolean } | undefined): void {
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
}

async function flush(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('host window focus on desktop follows the native window', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        vi.resetModules();
        host.desktop = true;
        host.nativeFocused = false;
        host.handlers.clear();
        host.invokes.length = 0;
    });

    afterEach(() => {
        setDocument(originalDocument as never);
    });

    it('reports the native focus, not a stale document focus, and pushes each native change', async () => {
        // P03-DESKTOP-PERF case 1: a programmatically launched window hidden by the shell while
        // the webview document still claims focus.
        setDocument({ visibilityState: 'hidden', hasFocus: () => true });
        const focus = await import('./readHostWindowFocus');
        const presence = await import('@/desktop/window/desktopMainWindowPresence');
        const changes = vi.fn();
        focus.subscribeToHostWindowFocus(changes);
        await flush();

        expect(focus.readHostWindowFocus()).toBe(false);
        expect(presence.isDesktopMainWindowVisible()).toBe(false);
        expect(presence.isDesktopMainWindowFocused()).toBe(false);

        // Case 2: native focus while the document says it has none.
        setDocument({ visibilityState: 'visible', hasFocus: () => false });
        host.handlers.get('tauri://focus')?.(null);
        expect(focus.readHostWindowFocus()).toBe(true);
        expect(presence.isDesktopMainWindowFocused()).toBe(true);
        expect(changes).toHaveBeenCalledTimes(2);

        // A repeated native fact publishes nothing.
        host.handlers.get('tauri://focus')?.(null);
        expect(changes).toHaveBeenCalledTimes(2);

        host.handlers.get('tauri://blur')?.(null);
        expect(focus.readHostWindowFocus()).toBe(false);
        expect(changes).toHaveBeenCalledTimes(3);
        // One query for the initial state; every later change is pushed.
        expect(host.invokes.map((call) => call.command)).toEqual(['plugin:window|is_focused']);
    });

    it('a native event that lands before the initial query answer wins over that answer', async () => {
        setDocument({ visibilityState: 'visible', hasFocus: () => false });
        host.nativeFocused = false;
        const focus = await import('./readHostWindowFocus');
        focus.readHostWindowFocus();
        await Promise.resolve();
        host.handlers.get('tauri://focus')?.(null);
        await flush();

        expect(focus.readHostWindowFocus()).toBe(true);
    });

    it('motion and presence republish when only the native window focus changes', async () => {
        setDocument({ visibilityState: 'hidden', hasFocus: () => true });
        host.nativeFocused = true;
        const viewed = await import('./useHostActivelyViewed');
        const runtime = await import('./isRuntimeActive');
        const viewedChanges = vi.fn();
        const runtimeChanges = vi.fn();
        viewed.subscribeToHostActivelyViewed(viewedChanges);
        runtime.subscribeToRuntimeActiveChange(runtimeChanges, { includeWindowFocus: true });
        await flush();
        expect(viewed.readHostActivelyFocused()).toBe(true);

        // The shell hides the window; the document sends no blur.
        host.handlers.get('tauri://blur')?.(null);

        expect(viewed.readHostActivelyViewed()).toBe(false);
        expect(viewed.readHostActivelyFocused()).toBe(false);
        expect(viewedChanges).toHaveBeenCalled();
        expect(runtimeChanges).toHaveBeenCalled();
        expect(runtime.readComputerUiFocusState().focused).toBe(false);
    });

    it('a browser keeps the document focus fact and never touches the native bridge', async () => {
        host.desktop = false;
        setDocument({ visibilityState: 'visible', hasFocus: () => true });
        const focus = await import('./readHostWindowFocus');
        await flush();

        expect(focus.readHostWindowFocus()).toBe(true);
        expect(host.invokes).toEqual([]);
        expect(host.handlers.size).toBe(0);
    });
});
