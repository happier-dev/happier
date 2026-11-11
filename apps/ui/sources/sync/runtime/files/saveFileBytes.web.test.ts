import { afterEach, describe, expect, it, vi } from 'vitest';
import { canOpenFileInDefaultApp, saveFileUri } from './saveFileBytes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(() => vi.unstubAllGlobals());

describe('desktop preview handoff', () => {
    it('hands the loaded Blob bytes to the scoped desktop opener and retains its native copy', async () => {
        const path = '/tmp/happier-downloads/preview/spec.pdf';
        const files = new Map<string, number[]>();
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_download_cache_create') { files.set(path, []); return path; }
            if (command === 'desktop_download_cache_write') files.get(String(args?.path))!.push(...args!.bytes as number[]);
            if (command === 'desktop_download_cache_remove') files.delete(String(args?.path));
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const fetch = vi.fn(async () => new Response(new Uint8Array([0, 255, 42])));
        vi.stubGlobal('fetch', fetch);
        await expect(saveFileUri({ uri: 'blob:already-loaded', fileName: 'spec.pdf', mimeType: 'application/pdf', action: 'open' })).resolves.toBe('saved');
        expect(fetch).toHaveBeenCalledWith('blob:already-loaded');
        expect(files.get(path)).toEqual([0, 255, 42]);
        expect(invoke.mock.calls.filter(call => call[0] === 'plugin:opener|open_path')).toEqual([
            ['plugin:opener|open_path', { path }],
        ]);
    });
});

describe('browser open admission', () => {
    it('opens only kinds the browser renders without running the file as Happier-origin script', () => {
        expect(canOpenFileInDefaultApp('application/pdf')).toBe(true);
        expect(canOpenFileInDefaultApp('application/pdf; charset=binary')).toBe(true);
        for (const mimeType of ['text/html', 'image/svg+xml', 'image/png', 'application/octet-stream', undefined]) {
            expect(canOpenFileInDefaultApp(mimeType)).toBe(false);
        }
    });

    it('keeps the desktop host opening every file in its default app', () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
        expect(canOpenFileInDefaultApp('text/html')).toBe(true);
        expect(canOpenFileInDefaultApp()).toBe(true);
    });
});
