/**
 * Single source of truth for every download URL and install command on the site.
 *
 * The JSON manifest beside this module is also consumed by the docs generator
 * and outbound-link checker so those surfaces cannot drift onto another release
 * channel or a stale versioned filename.
 *
 *   - DownloadBadges linked Google Play at `id=dev.happier`. That listing does
 *     not exist (HTTP 404). The real package id is `dev.happier.app`, and even
 *     that has no public store page — it is a closed testing track, reachable
 *     only through the opt-in URL below.
 *   - DownloadBadges once pinned desktop URLs to v0.2.0. Rolling releases now
 *     publish stable aliases specifically so public links never need a version bump.
 *
 * Anything that points off this site belongs here, and `yarn check:links`
 * (scripts/check-download-links.mjs) HEADs every one of them before a deploy.
 */
import downloads from './downloads.json';

const DESKTOP_ASSET_BASE = downloads.desktopAssetBase;

export const DESKTOP_RELEASES_PAGE = downloads.desktopReleasesPage;

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

export const DESKTOP_PLATFORMS: ReadonlyArray<DesktopPlatform> = downloads.desktopPlatforms.map((platform) => ({
    ...platform,
    id: platform.id as DesktopPlatformId,
    href: desktopAsset(platform.file),
}));

export const APP_STORE_URL = downloads.appStoreUrl;

/**
 * Android has no public store listing.
 *
 * `play.google.com/store/apps/details?id=dev.happier.app` is 404 for anyone who
 * is not an opted-in tester, because the track is closed. The opt-in URL is the
 * only working Play entry point, and it only works after a Google account joins
 * the tester list — so it is not a badge, it is a footnote.
 *
 * The public direct download follows the stable rolling tag. Preview and dev
 * APKs remain available from their explicitly named channel releases.
 */
export const ANDROID_APK_URL = downloads.androidApkUrl;

export const ANDROID_PLAY_TESTING_OPT_IN_URL = downloads.androidPlayTestingOptInUrl;

/**
 * The public Play listing — WHICH DOES NOT EXIST YET.
 *
 * This is here because the badge above it now leads with Play and keeps the APK
 * as the secondary choice, on the plan that the site and the listing go public
 * together. Until that happens this URL 404s for everyone, which is precisely
 * the failure the docblock above spent a paragraph arguing against.
 *
 * SO: do not deploy the site with this badge before the listing is live. If the
 * two ever have to ship apart, swap the Android badge's primary href back to
 * ANDROID_APK_URL — the popover already offers the other one either way, so it
 * is a one-line change and nothing else moves.
 */
export const ANDROID_PLAY_URL = downloads.androidPlayUrl;

export const WEB_APP_URL = downloads.webAppUrl;
export const DOCS_URL = downloads.docsUrl;
export const GUIDES_URL = downloads.guidesUrl;
export const GITHUB_REPO_URL = downloads.githubRepoUrl;

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
