import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import type { BrowserContextAnnotationAdapter } from './runtimeAnnotationExecutor';

type BrowserContextAnnotationRegistration = Readonly<{
    token: symbol;
    adapter: BrowserContextAnnotationAdapter;
}>;

/**
 * Keep every mounted host for each exact Account/view. Closing a duplicate panel must expose
 * the still-mounted host again; it must not remove that view's annotation owner.
 */
const registrations = new Map<string, BrowserContextAnnotationRegistration[]>();

function registrationKey(input: Readonly<{ browserSessionId: string; viewId: string; scope: ServerAccountScope }>): string {
    return serverAccountScopedResourceKey(input.scope, browserViewKey(input));
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
        scope: ServerAccountScope;
        adapter: BrowserContextAnnotationAdapter;
    }>,
): () => void {
    const token = Symbol('browserContextAnnotationAdapter');
    const key = registrationKey(input);
    registrations.set(key, [...(registrations.get(key) ?? []), { token, adapter: input.adapter }]);
    return () => {
        const remaining = (registrations.get(key) ?? []).filter(registration => registration.token !== token);
        if (remaining.length) registrations.set(key, remaining);
        else registrations.delete(key);
    };
}

export function readRegisteredBrowserContextAnnotationAdapter(
    input: Readonly<{ browserSessionId: string; viewId: string; scope: ServerAccountScope }>,
): BrowserContextAnnotationAdapter | null {
    return registrations.get(registrationKey(input))?.at(-1)?.adapter ?? null;
}

export function clearBrowserContextAnnotationRegistryForTests(): void {
    registrations.clear();
}
