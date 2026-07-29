import type { BrowserContextAnnotationAdapter } from './runtimeAnnotationExecutor';

type BrowserContextAnnotationRegistration = Readonly<{
    token: symbol;
    adapter: BrowserContextAnnotationAdapter;
}>;

/**
 * UX-7: keyed by `${browserSessionId}:${viewId}` so each live view owns its own annotation adapter
 * slot. The previous single-slot registry was last-write-wins — a second view's mount evicted the
 * first, leaving all-but-one view unbacked (and ANNO-7 multi-tab isolation impossible). A `Map`
 * lets every mounted view coexist; the runtime-action front door resolves the exact view's owner.
 */
const registrations = new Map<string, BrowserContextAnnotationRegistration>();

function registryKey(input: Readonly<{ browserSessionId: string; viewId: string }>): string {
    return `${input.browserSessionId}:${input.viewId}`;
}

/**
 * Registers the active in-app annotation adapter (the BrowserShell host that owns the live view +
 * capture provider + `BrowserContextState` `onStateChange`). The default runtime action executor
 * resolves through this registry so every `browser.context.annotation.*` action — dispatched from
 * the toolbar OR by an agent — reaches a real owner through the `ActionExecutor.execute` front door
 * instead of failing closed. Keyed by `browserSessionId`/`viewId` so a stale host can't service a
 * different session's annotation request and so concurrent views never evict one another.
 */
export function registerBrowserContextAnnotationAdapter(
    input: Readonly<{
        browserSessionId: string;
        viewId: string;
        adapter: BrowserContextAnnotationAdapter;
    }>,
): () => void {
    const token = Symbol('browserContextAnnotationAdapter');
    const key = registryKey(input);
    registrations.set(key, { token, adapter: input.adapter });
    return () => {
        // Token-checked: only clear the slot if this exact registration still owns it. A remount that
        // re-registered the same key before this disposer fires must not be clobbered.
        if (registrations.get(key)?.token === token) {
            registrations.delete(key);
        }
    };
}

export function readRegisteredBrowserContextAnnotationAdapter(
    input: Readonly<{ browserSessionId: string; viewId: string }>,
): BrowserContextAnnotationAdapter | null {
    return registrations.get(registryKey(input))?.adapter ?? null;
}

export function clearBrowserContextAnnotationRegistryForTests(): void {
    registrations.clear();
}
