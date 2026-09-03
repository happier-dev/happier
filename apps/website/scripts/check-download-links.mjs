#!/usr/bin/env node
/**
 * HEAD every outbound URL the marketing site sends a visitor to, and fail if
 * any of them is not reachable.
 *
 * On 2026-08-08 the deployed site had six dead outbound links at once — all
 * four desktop downloads, the Google Play badge, the LICENSE link, and the
 * changelog link — and nothing in the repo could have caught any of them,
 * because they were string literals inside JSX. This script is the missing
 * check. Run it before every deploy:
 *
 *     node scripts/check-download-links.mjs
 *
 * It is deliberately NOT a vitest: it needs the network, and a unit suite that
 * fails when GitHub has a bad minute is a suite people learn to ignore.
 */

import { readFileSync } from 'node:fs';

const downloads = JSON.parse(readFileSync(new URL('../src/data/downloads.json', import.meta.url), 'utf8'));
const desktopAssets = downloads.desktopPlatforms.map(
    ({ file }) => `${downloads.desktopAssetBase}/${file}`,
);

const TARGETS = [
    ...desktopAssets,
    downloads.desktopReleasesPage,

    // Mobile
    downloads.appStoreUrl,
    downloads.androidApkUrl,

    // Installer + trust surface
    'https://happier.dev/install',
    downloads.installScriptUrl,
    downloads.installScriptPs1Url,
    downloads.releasePubkeyUrl,

    // Product surfaces
    downloads.webAppUrl,
    downloads.docsUrl,
    'https://docs.happier.dev/security',
    'https://docs.happier.dev/providers',
    'https://docs.happier.dev/releases',
    'https://docs.happier.dev/getting-started/onboarding',
    'https://docs.happier.dev/deployment/self-host-runtime',
    downloads.guidesUrl,

    // Repo — note the British spelling; /LICENSE is a 404.
    downloads.githubRepoUrl,
    downloads.licenseUrl,
    'https://github.com/happier-dev/happier/graphs/contributors',

    // Published stats the counters read.
    'https://stats.happier.dev/downloads.json',
    'https://stats.happier.dev/discord.json',

    // Community
    'https://discord.gg/W6Pb8KuHfg',
];

const results = await Promise.all(
    TARGETS.map(async (url) => {
        try {
            let res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
            // Some CDNs reject HEAD outright; retry as a ranged GET before failing.
            if (res.status === 405 || res.status === 403) {
                res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
            }
            return { url, status: res.status, ok: res.status < 400 };
        } catch (error) {
            return { url, status: String(error?.message ?? error), ok: false };
        }
    }),
);

let failed = 0;
for (const { url, status, ok } of results) {
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(status).padEnd(6)} ${url}`);
}

if (failed > 0) {
    console.error(`\n${failed} of ${results.length} links are dead. Do not deploy.`);
    process.exit(1);
}
console.log(`\nAll ${results.length} links reachable.`);
