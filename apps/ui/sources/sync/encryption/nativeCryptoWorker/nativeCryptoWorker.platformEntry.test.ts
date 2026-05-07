import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('native crypto worker platform entries', () => {
    afterEach(() => {
        vi.doUnmock('react-native');
        vi.doUnmock('./nativeCryptoWorker.native');
        vi.doUnmock('./nativeCryptoWorker.web');
        vi.resetModules();
    });

    it.each(['android', 'ios'] as const)('routes %s bundles through the native implementation', (platform) => {
        const source = readFileSync(new URL(`./nativeCryptoWorker.${platform}.ts`, import.meta.url), 'utf8');

        expect(source).toContain("from './nativeCryptoWorker.native'");
    });

    it('uses the native implementation from the shared entry on Android', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
        vi.doMock('./nativeCryptoWorker.native', () => ({
            createNativeCryptoWorker: () => ({
                probe: async () => ({ available: true, failureReason: 0, nativeVersion: 7 }),
            }),
        }));
        vi.doMock('./nativeCryptoWorker.web', () => ({
            createNativeCryptoWorker: () => {
                throw new Error('web worker should not be used on Android');
            },
        }));

        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker');

        await expect(createNativeCryptoWorker().probe()).resolves.toMatchObject({
            available: true,
            nativeVersion: 7,
        });
    });

    it('keeps the web fallback from the shared entry on web', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
        vi.doMock('./nativeCryptoWorker.native', () => ({
            createNativeCryptoWorker: () => {
                throw new Error('native worker should not be used on web');
            },
        }));
        vi.doMock('./nativeCryptoWorker.web', () => ({
            createNativeCryptoWorker: () => ({
                probe: async () => ({ available: false, failureReason: 1 }),
            }),
        }));

        const { createNativeCryptoWorker } = await import('./nativeCryptoWorker');

        await expect(createNativeCryptoWorker().probe()).resolves.toEqual({
            available: false,
            failureReason: 1,
        });
    });
});
