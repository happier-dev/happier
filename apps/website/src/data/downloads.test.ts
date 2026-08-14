import { describe, expect, it } from 'vitest';

import {
    ANDROID_APK_URL,
    APP_STORE_URL,
    DESKTOP_PLATFORMS,
    DESKTOP_VERSION,
    RELEASE_PUBKEY,
    RELEASE_PUBKEY_ID,
} from './downloads';

/**
 * Offline guards for the class of bug that took six outbound links down at
 * once. These check shape, not reachability — `scripts/check-download-links.mjs`
 * does reachability, and needs a network, so it stays out of the unit suite.
 */
describe('download URLs', () => {
    // Every asset published to `ui-desktop-stable` carries the version in its
    // filename. The shipped component built version-LESS names on the belief
    // that the rolling tag republished under stable names, so all four desktop
    // downloads 404'd in production. Anything that drops the version here is
    // reintroducing that bug.
    it('carries the release version in every desktop asset filename', () => {
        expect(DESKTOP_PLATFORMS).toHaveLength(4);
        for (const platform of DESKTOP_PLATFORMS) {
            expect(platform.href).toContain(`-v${DESKTOP_VERSION}.`);
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

    // The key printed on the page must be the key the installer verifies
    // against. public/install.sh:26-27 is the other copy; if they ever diverge
    // the trust disclosure is worse than useless.
    it('prints the minisign key the installer actually trusts', () => {
        expect(RELEASE_PUBKEY_ID).toBe('91AE28177BF6E43C');
        expect(RELEASE_PUBKEY).toBe('RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t');
    });
});
