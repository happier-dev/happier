import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
    ANDROID_APK_URL,
    APP_STORE_URL,
    DESKTOP_PLATFORMS,
    RELEASE_PUBKEY,
    RELEASE_PUBKEY_ID,
} from './downloads';

/**
 * Offline guards for the class of bug that took six outbound links down at
 * once. These check shape, not reachability — `scripts/check-download-links.mjs`
 * does reachability, and needs a network, so it stays out of the unit suite.
 */
describe('download URLs', () => {
    it('uses stable rolling aliases for every desktop download', () => {
        expect(DESKTOP_PLATFORMS).toHaveLength(4);
        for (const platform of DESKTOP_PLATFORMS) {
            expect(platform.href).not.toMatch(/-v\d/);
            expect(platform.href).toMatch(
                /^https:\/\/github\.com\/happier-dev\/happier\/releases\/download\/ui-desktop-stable\//,
            );
        }
    });

    it('offers exactly one asset per supported desktop target', () => {
        expect(DESKTOP_PLATFORMS.map((p) => p.id)).toEqual([
            'mac-arm64',
            'mac-x86_64',
            'win-x86_64',
            'linux-x86_64',
        ]);
    });

    // `play.google.com/store/apps/details?id=dev.happier` is a 404 and always
    // has been; `id=dev.happier.app` is a closed track that 404s for anyone who
    // is not an opted-in tester. Neither belongs in a badge. Android goes to the
    // APK, which is where 2,056 people have already gone.
    it('never links a Google Play store listing', () => {
        const surfaces = [ANDROID_APK_URL, APP_STORE_URL, ...DESKTOP_PLATFORMS.map((p) => p.href)];
        for (const url of surfaces) {
            expect(url).not.toContain('play.google.com/store');
        }
        expect(ANDROID_APK_URL).toMatch(/\.apk$/);
    });

    it('offers the stable APK through its canonical rolling alias', () => {
        expect(ANDROID_APK_URL).toBe(
            'https://github.com/happier-dev/happier/releases/download/ui-mobile-stable/happier-android.apk',
        );
    });

    it('keeps static public download surfaces on the canonical stable APK', () => {
        const staticSurfaces = {
            'index.html': readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
            'public/llms.txt': readFileSync(new URL('../../public/llms.txt', import.meta.url), 'utf8'),
        };

        for (const [name, surface] of Object.entries(staticSurfaces)) {
            expect(surface.includes(ANDROID_APK_URL), `${name} must link the stable APK`).toBe(true);
            expect(surface.includes('/ui-mobile-preview/'), `${name} must not link a preview APK`).toBe(false);
        }
    });

    // The key printed on the page must be the key the installer verifies
    // against. public/install.sh:26-27 is the other copy; if they ever diverge
    // the trust disclosure is worse than useless.
    it('prints the minisign key the installer actually trusts', () => {
        expect(RELEASE_PUBKEY_ID).toBe('91AE28177BF6E43C');
        expect(RELEASE_PUBKEY).toBe('RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t');
    });
});
