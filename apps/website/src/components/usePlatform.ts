import { useEffect, useState } from 'react';

/**
 * What the visitor is holding, to the precision the page actually acts on.
 *
 * The site's whole job is to get an install command onto the machine that runs
 * the user's code. That makes exactly one distinction load-bearing: does this
 * device have a shell the visitor can paste into, or not? Everything else is
 * labelling.
 *
 * `unknown` is the server/prerender value. It must render something sensible on
 * its own, because it is what a crawler and a no-JS reader see.
 */
export type Platform = 'mac' | 'windows' | 'linux' | 'ios' | 'ipados' | 'android' | 'unknown';

/** Devices where "paste this into your terminal" is a dead end. */
export const HANDHELD: ReadonlyArray<Platform> = ['ios', 'ipados', 'android'];

export function isHandheld(platform: Platform): boolean {
    return HANDHELD.includes(platform);
}

export function detectPlatform(): Platform {
    if (typeof navigator === 'undefined') return 'unknown';

    const ua = navigator.userAgent;
    const lower = ua.toLowerCase();
    const platformString = (navigator.platform ?? '').toLowerCase();
    const touchPoints = navigator.maxTouchPoints ?? 0;

    if (/android/.test(lower)) return 'android';
    if (/iphone|ipod/.test(lower)) return 'ios';

    // iPadOS 13+ ships a desktop UA string: it claims to be a Macintosh. The
    // only reliable tell in a plain browser is that a Mac reports 0 touch
    // points and an iPad reports 5. Without this branch every iPad visitor is
    // handed `curl … | bash`, which they cannot run.
    const claimsMac = /macintosh|mac os x/.test(lower) || platformString.includes('mac');
    if (/ipad/.test(lower) || (claimsMac && touchPoints > 1)) return 'ipados';

    if (claimsMac) return 'mac';
    if (/win/.test(lower) || platformString.includes('win')) return 'windows';
    if (/linux|x11|cros/.test(lower)) return 'linux';

    return 'unknown';
}

/**
 * Detection runs in an effect, never during render, so the server-rendered /
 * prerendered markup and the first client paint agree. A mismatch here would
 * hydrate-error the one component the entire page converts through.
 */
export function usePlatform(): Platform {
    const [platform, setPlatform] = useState<Platform>('unknown');

    useEffect(() => {
        setPlatform(detectPlatform());
    }, []);

    return platform;
}
