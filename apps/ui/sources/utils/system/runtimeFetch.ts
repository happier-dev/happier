export type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function resolveDefaultRuntimeFetch(input: RequestInfo | URL): Promise<RuntimeFetch> {
    const { resolveTauriRuntimeFetch } = await import('@/utils/platform/tauri/transferFetch');
    const tauriRuntimeFetch = await resolveTauriRuntimeFetch(input);
    if (tauriRuntimeFetch) {
        return tauriRuntimeFetch;
    }

    const globalFetch = globalThis.fetch;
    if (typeof globalFetch !== 'function') {
        throw new Error('globalThis.fetch is not available');
    }

    return (globalFetch as unknown as RuntimeFetch);
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
    const runtimeFetch = await resolveDefaultRuntimeFetch(input);
    return runtimeFetch(input, mergedInit);
};

let activeRuntimeFetch: RuntimeFetch = defaultRuntimeFetch;

export function setRuntimeFetch(next: RuntimeFetch): void {
    activeRuntimeFetch = next;
}

export function resetRuntimeFetch(): void {
    activeRuntimeFetch = defaultRuntimeFetch;
}

export function runtimeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return activeRuntimeFetch(input, init);
}
