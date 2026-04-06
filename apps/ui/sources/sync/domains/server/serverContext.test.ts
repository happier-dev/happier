import { afterEach, describe, expect, it, vi } from 'vitest';

function stubWebRuntime(
    origin: string,
    runtimeConfig: Record<string, unknown> | null = null,
): void {
    const hostname = (() => {
        try {
            return new URL(origin).hostname;
        } catch {
            return '';
        }
    })();
    vi.stubGlobal('window', {
        location: { origin, hostname },
        ...(runtimeConfig ? { __HAPPIER_WEB_RUNTIME_CONFIG__: runtimeConfig } : {}),
    });
    vi.stubGlobal('document', {});
}

async function importFresh() {
    vi.resetModules();
    return await import('./serverContext');
}

describe('serverContext', () => {
    const previousServerContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;

    afterEach(() => {
        vi.unstubAllGlobals();
        if (previousServerContext === undefined) {
            delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        } else {
            process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = previousServerContext;
        }
    });

    it('treats a Tauri dev origin as stack context when runtime config declares stack context', async () => {
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
        stubWebRuntime('http://127.0.0.1:8081', { serverContext: 'stack' });

        const { isStackContext } = await importFresh();

        expect(isStackContext()).toBe(true);
    });
});
