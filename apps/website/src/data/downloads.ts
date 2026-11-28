/**
 * Single source of truth for every download URL and install command on the site.
 *
 * The JSON manifest beside this module is also consumed by the docs generator
 * and outbound-link checker so those surfaces cannot drift onto another release
 * channel or a stale versioned filename.
 *
 *   - DownloadBadges linked Google Play at `id=dev.happier`. That listing has
 *     never existed (HTTP 404). The real package id is `dev.happier.app`,
 *     which spent months as a closed testing track reachable only through the
 *     opt-in URL below, and is now the public listing in ANDROID_PLAY_URL.
 *   - DownloadBadges once pinned desktop URLs to v0.2.0. Rolling releases now
 *     publish stable aliases specifically so public links never need a version bump.
 *
 * Anything that points off this site belongs here, and `yarn check:links`
 * (scripts/check-download-links.mjs) HEADs every one of them before a deploy.
 */
import downloads from './downloads.json';

const DESKTOP_ASSET_BASE = downloads.desktopAssetBase;

export const DESKTOP_RELEASES_PAGE = downloads.desktopReleasesPage;

export type DesktopPlatformId = 'mac-arm64' | 'mac-x86_64' | 'win-x86_64' | 'linux-x86_64' | 'linux-x86_64-deb' | 'linux-x86_64-rpm';

export type DesktopPlatform = {
    id: DesktopPlatformId;
    label: string;
    sublabel: string;
    href: string;
};

function desktopAsset(file: string): string {
    return `${DESKTOP_ASSET_BASE}/${file}`;
}

export const DESKTOP_PLATFORMS: ReadonlyArray<DesktopPlatform> = downloads.desktopPlatforms.map((platform) => ({
    ...platform,
    id: platform.id as DesktopPlatformId,
    href: desktopAsset(platform.file),
}));

export const LINUX_APPIMAGE_REQUIREMENTS_URL = downloads.linuxAppimageRequirementsUrl;

export const APP_STORE_URL = downloads.appStoreUrl;

/**
 * The direct APK, kept first-class beside the Play listing.
 *
 * It is not a legacy path: thousands of people chose the file over the store
 * while the Play track was still closed, and some keep choosing it — no Google
 * account, no store, reproducible from the release page. It follows the stable
 * rolling tag; preview and dev APKs remain available from their explicitly
 * named channel releases.
 */
export const ANDROID_APK_URL = downloads.androidApkUrl;

/**
 * The closed-track opt-in URL from before the listing went public. Still a
 * working entry point for accounts already on the tester list, and still
 * referenced by older docs, so it stays — as a footnote, not a badge.
 */
export const ANDROID_PLAY_TESTING_OPT_IN_URL = downloads.androidPlayTestingOptInUrl;

/**
 * The public Play listing.
 *
 * For a long time this docblock was a warning: the track was closed, the URL
 * 404ed for everyone but opted-in testers, and the Play-first badge was only
 * allowed to ship the day the listing went public. That day has come — the
 * listing is live, DownloadBadges leads with Play, and the APK stays one click
 * behind the chevron for the people who want the file.
 *
 * The safety net outlives the warning: `yarn check:links`
 * (scripts/check-download-links.mjs) HEADs this URL with every other outbound
 * link before a deploy, so a pulled listing or a re-closed track fails the
 * check instead of shipping as a dead badge.
 */
export const ANDROID_PLAY_URL = downloads.androidPlayUrl;

export const WEB_APP_URL = downloads.webAppUrl;
export const DOCS_URL = downloads.docsUrl;
export const SELF_HOST_DOCS_URL = `${DOCS_URL}deployment/self-host-runtime`;
export const LEGAL_URLS = {
    privacy: `${DOCS_URL}legal/privacy`,
    terms: `${DOCS_URL}legal/terms`,
    termsOfSale: `${DOCS_URL}legal/terms-of-sale`,
    refunds: `${DOCS_URL}legal/refunds`,
    imprint: `${DOCS_URL}legal/imprint`,
} as const;
export const GUIDES_URL = downloads.guidesUrl;
export const GITHUB_REPO_URL = downloads.githubRepoUrl;
/** The Sponsors listing named in .github/FUNDING.yml; a Supporter Pack route for anyone, self-hosters included. */
export const GITHUB_SPONSORS_URL = 'https://github.com/sponsors/happier-dev';

/** The repo spells it LICENCE. `…/blob/main/LICENSE` is a 404. */
export const LICENSE_URL = downloads.licenseUrl;

/** `docs.happier.dev/changelog` is a 404; the route is /releases. */
export const CHANGELOG_URL = downloads.changelogUrl;

export const INSTALL_SCRIPT_URL = downloads.installScriptUrl;
export const INSTALL_SCRIPT_PS1_URL = downloads.installScriptPs1Url;
export const RELEASE_PUBKEY_URL = downloads.releasePubkeyUrl;

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

export const INSTALL_COMMAND_UNIX = downloads.installCommandUnix;
export const INSTALL_COMMAND_WINDOWS = downloads.installCommandWindows;

/** The two-step, nothing-piped-to-a-shell version, for readers who want it. */
export const INSTALL_COMMAND_UNIX_INSPECTABLE = [
    'curl -fsSL https://happier.dev/install.sh -o happier-install.sh',
    'less happier-install.sh   # read it first',
    'bash happier-install.sh',
].join('\n');
