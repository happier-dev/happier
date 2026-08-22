import { afterEach, describe, expect, it, vi } from 'vitest';

const isDesktopHostMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('../desktopHost', () => ({
    isDesktopHost: () => isDesktopHostMock(),
}));

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock('@tauri-apps/plugin-http');
    isDesktopHostMock.mockReset();
    isDesktopHostMock.mockReturnValue(false);
});

describe('transferFetch', () => {
    it('uses the Tauri runtime fetch only for absolute http/https request targets', async () => {
        const { shouldUseTauriRuntimeFetch } = await import('./transferFetch');

        expect(shouldUseTauriRuntimeFetch('http://127.0.0.1:43123/machine-transfers/direct/exports/x')).toBe(true);
        expect(shouldUseTauriRuntimeFetch('https://machine.example.ts.net/__happier/transfer')).toBe(true);
        expect(shouldUseTauriRuntimeFetch(new URL('https://api.example.test/v1/features'))).toBe(true);
        expect(shouldUseTauriRuntimeFetch(new Request('http://localhost:3000/transfer'))).toBe(true);

        expect(shouldUseTauriRuntimeFetch('/v1/features')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('file:///tmp/happier-transfer.bin')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('not-a-url')).toBe(false);
    });

    it('loads and caches the Tauri plugin fetch for desktop http/https transfer requests', async () => {
        const pluginFetch = vi.fn(async () => new Response('ok', { status: 200 }));
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: pluginFetch,
        }));
        isDesktopHostMock.mockReturnValue(true);

        const { resolveTauriRuntimeFetch } = await import('./transferFetch');

        const first = await resolveTauriRuntimeFetch('http://127.0.0.1:43123/machine-transfers/direct/exports/x');
        const second = await resolveTauriRuntimeFetch('https://machine.example.ts.net/__happier/transfer');

        expect(first).toBe(pluginFetch);
        expect(second).toBe(pluginFetch);
    });

    it('does not load the Tauri plugin fetch for relative or non-http targets', async () => {
        const pluginFetch = vi.fn(async () => new Response('ok', { status: 200 }));
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: pluginFetch,
        }));
        isDesktopHostMock.mockReturnValue(true);

        const { resolveTauriRuntimeFetch } = await import('./transferFetch');

        await expect(resolveTauriRuntimeFetch('/v1/features')).resolves.toBeNull();
        await expect(resolveTauriRuntimeFetch('file:///tmp/happier-transfer.bin')).resolves.toBeNull();

        expect(pluginFetch).not.toHaveBeenCalled();
    });

    it('returns null when not running in Tauri desktop even for absolute transfer URLs', async () => {
        const pluginFetch = vi.fn(async () => new Response('ok', { status: 200 }));
        vi.doMock('@tauri-apps/plugin-http', () => ({
            fetch: pluginFetch,
        }));
        isDesktopHostMock.mockReturnValue(false);

        const { resolveTauriRuntimeFetch } = await import('./transferFetch');

        await expect(resolveTauriRuntimeFetch('http://127.0.0.1:43123/machine-transfers/direct/exports/x')).resolves.toBeNull();
        expect(pluginFetch).not.toHaveBeenCalled();
    });

    it('returns null when the Tauri plugin fetch cannot be loaded', async () => {
        vi.doMock('@tauri-apps/plugin-http', () => {
            throw new Error('plugin unavailable');
        });
        isDesktopHostMock.mockReturnValue(true);

        const { resolveTauriRuntimeFetch } = await import('./transferFetch');

        await expect(resolveTauriRuntimeFetch('https://machine.example.ts.net/__happier/transfer')).resolves.toBeNull();
    });
});
