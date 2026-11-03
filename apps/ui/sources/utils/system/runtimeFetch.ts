import { Platform } from 'react-native';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';

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

const defaultRuntimeFetch: RuntimeFetch = async (input, init) => {
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
    return resolvedFetch(input, mergedInit);
};

let activeRuntimeFetch: RuntimeFetch = defaultRuntimeFetch;

export function setRuntimeFetch(next: RuntimeFetch): void {
    activeRuntimeFetch = next;
}

export function resetRuntimeFetch(): void {
    activeRuntimeFetch = defaultRuntimeFetch;
}

export function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return init?.redirect === 'manual'
        ? fetchWithCredentialRedirectRefusal(input, init, activeRuntimeFetch)
        : activeRuntimeFetch(input, init);
}

/** The plugin HTTP owner consumes each response and owns its redirect policy. */
export function runtimeFetchManualResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return activeRuntimeFetch(input, { ...init, redirect: 'manual' });
}
