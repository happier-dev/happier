import { Platform } from 'react-native';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

export type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Credentialed HTTP uses the same manual-redirect adapter; reading it never makes a request. */
export async function readRuntimeFetchHost(input: RequestInfo | URL): Promise<'browser' | 'native'> {
    return (await resolveDefaultRuntimeFetch(input)).host;
}

async function resolveDefaultRuntimeFetch(input: RequestInfo | URL): Promise<Readonly<{
    fetch: RuntimeFetch;
    host: 'browser' | 'native';
}>> {
    const { resolveTauriRuntimeFetch } = await import('@/utils/platform/tauri/transferFetch');
    const tauriRuntimeFetch = await resolveTauriRuntimeFetch(input);
    if (tauriRuntimeFetch) {
        return { fetch: tauriRuntimeFetch, host: 'native' };
    }

    // React Native's XHR-backed fetch lacks response streams and ignores redirect
    // control. Expo supplies both for bounded decoding and credentialed requests.
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
        const { fetch: nativeFetch } = await import('expo/fetch');
        // Expo's native Response uses its own implementation of the Fetch API.
        const expoFetch = nativeFetch as unknown as RuntimeFetch;
        return {
            // Expo accepts only include/omit. Native has no browser origin to
            // authorize ambient cookies; callers can still opt in with include.
            fetch: (input, init) => expoFetch(input, init?.credentials === 'same-origin'
                ? { ...init, credentials: 'omit' }
                : init),
            host: 'native',
        };
    }

    if (typeof globalThis.fetch !== 'function') {
        throw new Error('globalThis.fetch is not available');
    }

    return { fetch: (input, init) => globalThis.fetch(input, init), host: 'browser' };
}

const defaultRuntimeFetch = async (input: RequestInfo | URL, init?: RequestInit, onIssued?: () => void): Promise<Response> => {
    // Some fetch implementations (notably in certain Expo/React Native web builds) default `credentials`
    // to `include`, which breaks cross-origin requests against servers that correctly use
    // `Access-Control-Allow-Origin: *` (wildcard is not permitted when credentials are included).
    //
    // The WHATWG Fetch default is `same-origin`. Enforce that default unless a caller explicitly
    // overrides it to keep CORS behavior predictable.
    const mergedInit = init
        ? ({ ...init, credentials: init.credentials ?? 'same-origin' } satisfies RequestInit)
        : ({ credentials: 'same-origin' } satisfies RequestInit);
    // Platform adapters retain their required receiver, even when passed as ports.
    const { fetch: resolvedFetch } = await resolveDefaultRuntimeFetch(input);
    throwIfAborted(init?.signal ?? undefined);
    onIssued?.();
    return resolvedFetch(input, mergedInit);
};

let activeRuntimeFetch = defaultRuntimeFetch;

export function setRuntimeFetch(next: RuntimeFetch): void {
    activeRuntimeFetch = (input, init, onIssued) => {
        throwIfAborted(init?.signal ?? undefined);
        onIssued?.();
        return next(input, init);
    };
}

export function resetRuntimeFetch(): void {
    activeRuntimeFetch = defaultRuntimeFetch;
}

export function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return activeRuntimeFetch(input, init);
}

/** Browsers follow opaque hops; native responses use the shared HTTP redirect owner. */
export async function runtimeFetchManualResponse(input: RequestInfo | URL, init?: RequestInit, onIssued?: () => void): Promise<Response> {
    const redirect = init?.redirect ?? 'manual';
    // Expo's URLSession delegate does not establish cross-origin credential stripping.
    // Native manual responses let nextPluginHttpRedirect apply that policy itself.
    const nativeFollow = redirect === 'follow' && await readRuntimeFetchHost(input) === 'native';
    return activeRuntimeFetch(input, { ...init, redirect: nativeFollow ? 'manual' : redirect }, onIssued);
}
