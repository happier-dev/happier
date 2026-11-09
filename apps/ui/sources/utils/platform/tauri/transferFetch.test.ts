import { describe, expect, it, vi } from 'vitest';

import { shouldUseTauriRuntimeFetch } from './transferFetch';

// The resolve/load/fallback paths are proven through the real owner chain in
// system/runtimeFetch.test.ts (real desktopHost over the bridge global).
describe('transferFetch', () => {
    it('ignores late native body bytes after response cancellation while preserving delivered bytes', async () => {
        let deliverBody: ((event: { index: number; message: number[] }) => void) | undefined;
        // Only the native IPC global is fake; HTTP, Channel and streams stay real.
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {
            transformCallback: (callback: typeof deliverBody) => { deliverBody = callback; return 1; },
            unregisterCallback: () => {},
            invoke: async (command: string) => {
                if (command === 'plugin:http|fetch') return 1;
                if (command === 'plugin:http|fetch_send') return {
                    status: 200, statusText: 'OK', url: 'https://example.test/', headers: [], rid: 2,
                };
                if (command === 'plugin:http|fetch_read_body') return;
                throw new Error(`Unexpected Tauri IPC: ${command}`);
            },
        } });
        try {
            const { fetch } = await import('@tauri-apps/plugin-http');
            const response = await fetch('https://example.test/');
            const reader = response.body!.getReader();
            const first = reader.read();
            if (!deliverBody) throw new Error('Native body channel was not registered');
            deliverBody({ index: 0, message: [66, 0] });
            expect(Array.from((await first).value!)).toEqual([66]);
            await reader.cancel();
            expect(() => deliverBody!({ index: 1, message: [65, 0] })).not.toThrow();
            expect(() => deliverBody!({ index: 2, message: [1] })).not.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('uses the Tauri runtime fetch only for absolute http/https request targets', () => {
        expect(shouldUseTauriRuntimeFetch('http://127.0.0.1:43123/machine-transfers/direct/exports/x')).toBe(true);
        expect(shouldUseTauriRuntimeFetch('https://machine.example.ts.net/__happier/transfer')).toBe(true);
        expect(shouldUseTauriRuntimeFetch(new URL('https://api.example.test/v1/features'))).toBe(true);
        expect(shouldUseTauriRuntimeFetch(new Request('http://localhost:3000/transfer'))).toBe(true);

        expect(shouldUseTauriRuntimeFetch('/v1/features')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('file:///tmp/happier-transfer.bin')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('not-a-url')).toBe(false);
    });
});
