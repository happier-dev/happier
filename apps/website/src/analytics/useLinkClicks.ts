import { useEffect } from 'react';

import {
    ANDROID_APK_URL,
    ANDROID_PLAY_TESTING_OPT_IN_URL,
    APP_STORE_URL,
    CHANGELOG_URL,
    DESKTOP_PLATFORMS,
    DESKTOP_RELEASES_PAGE,
    DOCS_URL,
    GITHUB_REPO_URL,
    GUIDES_URL,
    LICENSE_URL,
    RELEASE_PUBKEY_URL,
    WEB_APP_URL,
} from '../data/downloads';
import { DISCORD_INVITE_URL } from '../data/community';
import {
    trackDownloadBadgeClicked,
    trackOutboundClick,
    type DesktopVariant,
    type DownloadStore,
    type OutboundDestination,
} from './events';
// Shared with the components that emit their own events, so "which block of the
// page was this?" has one answer across the whole taxonomy.
import { locationOf } from './location';

/**
 * One delegated listener instruments every link on the site.
 *
 * The alternative — an `onClick` on each anchor — was rejected for two reasons,
 * and the second is the real one:
 *
 *   1. There are ~30 anchors across Nav, Footer, DownloadBadges, PrimaryCta,
 *      HandoffToComputer, SelfHost and CallToAction. Thirty edits is thirty
 *      chances to forget one, and a forgotten one is invisible: it looks like a
 *      link nobody clicks.
 *   2. A NEW link added six months from now is instrumented automatically. Every
 *      per-component scheme decays the moment someone adds an anchor without
 *      knowing the convention existed.
 *
 * Classification is driven off src/data/downloads.ts — the same constants that
 * build the hrefs — so a URL change updates the link and its analytics in one
 * edit. An href that matches nothing lands as `destination: 'other'` with the
 * literal href attached, which makes a missing case a visible data point rather
 * than a silent gap.
 *
 * Capture phase, so it still fires when a handler calls stopPropagation (the
 * desktop split button does, DownloadBadges.tsx), and `pointerdown` is NOT used:
 * a click that never completes is not a click.
 */

/** href → outbound destination. Longest match wins, so specific beats generic. */
const DESTINATIONS: ReadonlyArray<[string, OutboundDestination]> = [
    [ANDROID_PLAY_TESTING_OPT_IN_URL, 'play-testing'],
    [ANDROID_APK_URL, 'android-apk'],
    [APP_STORE_URL, 'app-store'],
    [LICENSE_URL, 'license'],
    [CHANGELOG_URL, 'changelog'],
    [RELEASE_PUBKEY_URL, 'release-pubkey'],
    [DESKTOP_RELEASES_PAGE, 'github-releases'],
    [DISCORD_INVITE_URL, 'discord'],
    [DOCS_URL, 'docs'],
    [GUIDES_URL, 'guides'],
    [WEB_APP_URL, 'webapp'],
    [GITHUB_REPO_URL, 'github'],
];

/** Store-badge hrefs that should read as a download, not a generic exit. */
const STORES: ReadonlyArray<[string, DownloadStore]> = [
    [ANDROID_PLAY_TESTING_OPT_IN_URL, 'android-play-testing'],
    [ANDROID_APK_URL, 'android-apk'],
    [APP_STORE_URL, 'ios'],
    [WEB_APP_URL, 'web'],
];

function classifyDestination(href: string): OutboundDestination {
    let best: OutboundDestination = 'other';
    let bestLength = 0;
    for (const [prefix, destination] of DESTINATIONS) {
        if (href.startsWith(prefix) && prefix.length > bestLength) {
            best = destination;
            bestLength = prefix.length;
        }
    }
    return best;
}

function classifyStore(href: string): DownloadStore | null {
    for (const [url, store] of STORES) if (href.startsWith(url)) return store;
    return null;
}

function classifyDesktop(href: string): DesktopVariant | null {
    if (href === DESKTOP_RELEASES_PAGE) return 'releases-page';
    const match = DESKTOP_PLATFORMS.find((platform) => platform.href === href);
    return match ? match.id : null;
}

export function useLinkClicks(): void {
    useEffect(() => {
        function onClick(event: MouseEvent) {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const anchor = target.closest<HTMLAnchorElement>('a[href]');
            if (!anchor) return;

            const href = anchor.href;
            // In-page anchors (#features) are navigation, not an exit, and the
            // scroll funnel already covers where people go.
            if (!/^https?:/i.test(href)) return;
            if (new URL(href).host === window.location.host) return;

            const location = locationOf(anchor);
            const desktop = classifyDesktop(href);
            if (desktop) {
                trackDownloadBadgeClicked({
                    store: 'desktop',
                    location,
                    variant: desktop,
                    // The split button only navigates directly when it is sure
                    // (DownloadBadges); an explicit pick from the popover is not
                    // a detection, so record it as such.
                    detected: anchor.dataset.detected === 'true',
                });
                return;
            }

            const store = classifyStore(href);
            if (store) {
                trackDownloadBadgeClicked({ store, location });
                return;
            }

            trackOutboundClick({ destination: classifyDestination(href), location, href });
        }

        document.addEventListener('click', onClick, { capture: true });
        return () => document.removeEventListener('click', onClick, { capture: true });
    }, []);
}
