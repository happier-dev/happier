import { afterEach, describe, expect, it, vi } from 'vitest';

const TAURI_INTERNALS_KEY = '__TAURI_INTERNALS__';

function setTauriInternals(value: unknown): void {
    if (value === undefined) {
        delete (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
        return;
    }
    (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = value;
}

afterEach(() => {
    setTauriInternals(undefined);
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock('@tauri-apps/plugin-http');
});

describe('runtimeFetch', () => {
    it('defaults credentials to same-origin when omitted', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features');

        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('same-origin');
    });

    it('preserves explicit credentials', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features', { credentials: 'omit' });

        const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('omit');
    });

    it('uses tauri-plugin-http fetch when running in Tauri desktop', async () => {
        const tauriFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('tauri-ok', { status: 200 }));
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: tauriFetchMock,
        }));
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features', { headers: { 'x-test': '1' } });

        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
        expect(globalFetchMock).not.toHaveBeenCalled();
        const init = tauriFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.credentials).toBe('same-origin');
    });

    it('falls back to global fetch for relative URLs in Tauri desktop', async () => {
        const tauriFetchMock = vi.fn(async () => new Response('tauri-ok', { status: 200 }));
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: tauriFetchMock,
        }));
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('/v1/features');

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        expect(tauriFetchMock).not.toHaveBeenCalled();
    });

    it('falls back to global fetch for non-http schemes in Tauri desktop', async () => {
        const tauriFetchMock = vi.fn(async () => new Response('tauri-ok', { status: 200 }));
        const globalFetchMock = vi.fn(async () => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: tauriFetchMock,
        }));
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch(new URL('file:///tmp/happier-transfer.bin'));

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
        expect(tauriFetchMock).not.toHaveBeenCalled();
    });

    it('falls back to global fetch when tauri-plugin-http cannot be loaded', async () => {
        const globalFetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('global-ok', { status: 200 }));
        vi.stubGlobal('fetch', globalFetchMock as unknown as typeof fetch);
        vi.doMock('@tauri-apps/plugin-http', () => {
            throw new Error('plugin unavailable');
        });
        setTauriInternals({ invoke: () => null });

        const { runtimeFetch } = await import('./runtimeFetch');
        await runtimeFetch('https://api.example.test/v1/features');

        expect(globalFetchMock).toHaveBeenCalledTimes(1);
    });
});
