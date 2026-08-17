/**
 * Single source of truth for every download URL and install command on the site.
 *
 * This file exists because three separate surfaces were each hand-typing URLs
 * and three of them were dead on 2026-08-08:
 *
 *   - DownloadBadges linked Google Play at `id=dev.happier`. That listing does
 *     not exist (HTTP 404). The real package id is `dev.happier.app`, and even
 *     that has no public store page — it is a closed testing track, reachable
 *     only through the opt-in URL below.
 *   - DownloadBadges built desktop URLs from version-less filenames
 *     (`happier-ui-desktop-darwin-aarch64.dmg`). Every asset actually published
 *     to the `ui-desktop-stable` tag carries the version in the filename, so all
 *     four desktop downloads returned 404.
 *
 * Anything that points off this site belongs here, and `yarn check:links`
 * (scripts/check-download-links.mjs) HEADs every one of them before a deploy.
 */

/**
 * Version baked into the `ui-desktop-stable` asset filenames.
 *
 * The rolling tag is stable; the filenames under it are not. Bump this in the
 * same commit that publishes a new desktop release, and let `check:links` catch
 * it if you forget.
 */
export const DESKTOP_VERSION = '0.2.0';

const DESKTOP_ASSET_BASE =
    'https://github.com/happier-dev/happier/releases/download/ui-desktop-stable';

export const DESKTOP_RELEASES_PAGE =
    'https://github.com/happier-dev/happier/releases/tag/ui-desktop-stable';

export type DesktopPlatformId = 'mac-arm64' | 'mac-x86_64' | 'win-x86_64' | 'linux-x86_64';

export type DesktopPlatform = {
    id: DesktopPlatformId;
    label: string;
    sublabel: string;
    href: string;
};

function desktopAsset(file: string): string {
    return `${DESKTOP_ASSET_BASE}/${file}`;
}

export const DESKTOP_PLATFORMS: ReadonlyArray<DesktopPlatform> = [
    {
        id: 'mac-arm64',
        label: 'macOS',
        sublabel: 'Apple Silicon',
        href: desktopAsset(`happier-ui-desktop-darwin-aarch64-v${DESKTOP_VERSION}.dmg`),
    },
    {
        id: 'mac-x86_64',
        label: 'macOS',
        sublabel: 'Intel',
        href: desktopAsset(`happier-ui-desktop-darwin-x86_64-v${DESKTOP_VERSION}.dmg`),
    },
    {
        id: 'win-x86_64',
        label: 'Windows',
        sublabel: 'x64 · .exe installer',
        href: desktopAsset(`happier-ui-desktop-windows-x86_64-v${DESKTOP_VERSION}.exe`),
    },
    {
        id: 'linux-x86_64',
        label: 'Linux',
        sublabel: 'x64 · AppImage',
        href: desktopAsset(`happier-ui-desktop-linux-x86_64-v${DESKTOP_VERSION}.AppImage`),
    },
];

export const APP_STORE_URL =
    'https://apps.apple.com/app/happier-claude-codex-opencode/id6758554297';

/**
 * Android has no public store listing.
 *
 * `play.google.com/store/apps/details?id=dev.happier.app` is 404 for anyone who
 * is not an opted-in tester, because the track is closed. The opt-in URL is the
 * only working Play entry point, and it only works after a Google account joins
 * the tester list — so it is not a badge, it is a footnote.
 *
 * The APK on the `ui-mobile-preview` tag is the path Android users are actually
 * taking: 2,056 downloads as of 2026-08-08, against 762 Android users in
 * PostHog over 90 days. Lead with it and say plainly that it is a direct
 * download.
 */
export const ANDROID_APK_URL =
    'https://github.com/happier-dev/happier/releases/download/ui-mobile-preview/happier-preview.apk';

export const ANDROID_PLAY_TESTING_OPT_IN_URL =
    'https://play.google.com/apps/testing/dev.happier.app';

export const WEB_APP_URL = 'https://app.happier.dev/';
export const DOCS_URL = 'https://docs.happier.dev/';
export const GUIDES_URL = 'https://guides.happier.dev/';
export const GITHUB_REPO_URL = 'https://github.com/happier-dev/happier';

/** The repo spells it LICENCE. `…/blob/main/LICENSE` is a 404. */
export const LICENSE_URL = 'https://github.com/happier-dev/happier/blob/main/LICENCE';

/** `docs.happier.dev/changelog` is a 404; the route is /releases. */
export const CHANGELOG_URL = 'https://docs.happier.dev/releases';

export const INSTALL_SCRIPT_URL = 'https://happier.dev/install.sh';
export const INSTALL_SCRIPT_PS1_URL = 'https://happier.dev/install.ps1';
export const RELEASE_PUBKEY_URL = 'https://happier.dev/happier-release.pub';

/**
 * The minisign public key the installer verifies every release against.
 *
 * Printed on the page so a reader can compare it against the copy compiled into
 * install.sh (line 25-29) and the copy served at /happier-release.pub without
 * running anything.
 */
export const RELEASE_PUBKEY_ID = '91AE28177BF6E43C';
export const RELEASE_PUBKEY =
    'RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t';

export const INSTALL_COMMAND_UNIX = 'curl -fsSL https://happier.dev/install | bash';
export const INSTALL_COMMAND_WINDOWS = 'iwr https://happier.dev/install.ps1 -useb | iex';

/** The two-step, nothing-piped-to-a-shell version, for readers who want it. */
export const INSTALL_COMMAND_UNIX_INSPECTABLE = [
    'curl -fsSL https://happier.dev/install.sh -o happier-install.sh',
    'less happier-install.sh   # read it first',
    'bash happier-install.sh',
].join('\n');
