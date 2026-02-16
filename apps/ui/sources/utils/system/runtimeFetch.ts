export type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultRuntimeFetch: RuntimeFetch = (input, init) => {
    const globalFetch = globalThis.fetch;
    if (typeof globalFetch !== 'function') {
        throw new Error('globalThis.fetch is not available');
    }
    return (globalFetch as unknown as RuntimeFetch)(input, init);
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
