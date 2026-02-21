export type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultRuntimeFetch: RuntimeFetch = (input, init) => {
    const globalFetch = globalThis.fetch;
    if (typeof globalFetch !== 'function') {
        throw new Error('globalThis.fetch is not available');
    }
    // Some fetch implementations (notably in certain Expo/React Native web builds) default `credentials`
    // to `include`, which breaks cross-origin requests against servers that correctly use
    // `Access-Control-Allow-Origin: *` (wildcard is not permitted when credentials are included).
    //
    // The WHATWG Fetch default is `same-origin`. Enforce that default unless a caller explicitly
    // overrides it to keep CORS behavior predictable.
    const mergedInit = init
        ? ({ ...init, credentials: init.credentials ?? 'same-origin' } satisfies RequestInit)
        : ({ credentials: 'same-origin' } satisfies RequestInit);
    return (globalFetch as unknown as RuntimeFetch)(input, mergedInit);
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
