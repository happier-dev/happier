import * as React from 'react';

import { t } from '@/text';

/**
 * Returning-user greeting picker. Used by the welcome decision panel when
 * `localSettings.hasCompletedAuthOnce === true`.
 *
 * The hook picks ONE title and ONE subtitle from the two pools below and
 * locks the selection via useRef so it stays stable across re-renders. A
 * fresh pair is rolled only when the welcome panel remounts (e.g. the user
 * logs out and returns to the welcome screen).
 *
 * Title and subtitle are sampled INDEPENDENTLY so any of the 4 × 3 = 12
 * pairings is possible — combinations like "Welcome home." / "Ready to
 * dive in?" or "Glad you're here." / "What are we building today?" all
 * have equal probability. This is deliberate: it makes the returning
 * experience feel a little alive rather than serving the exact same two
 * lines every time.
 *
 * Each pool is declared as an array of getter functions (not raw key
 * strings) so the `t()` call sites remain literal — that keeps the
 * translation-key type-safety the rest of the app relies on, and means a
 * missing key would surface at type-check time rather than runtime.
 */

type GreetingGetter = () => string;

const TITLE_GETTERS: readonly GreetingGetter[] = [
    () => t('welcome.welcomeReturningTitle1'),
    () => t('welcome.welcomeReturningTitle2'),
    () => t('welcome.welcomeReturningTitle3'),
    () => t('welcome.welcomeReturningTitle4'),
];

const SUBTITLE_GETTERS: readonly GreetingGetter[] = [
    () => t('welcome.welcomeReturningSubtitle1'),
    () => t('welcome.welcomeReturningSubtitle2'),
    () => t('welcome.welcomeReturningSubtitle3'),
];

function pickRandom<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)]!;
}

export type ReturningGreeting = Readonly<{
    title: string;
    subtitle: string;
}>;

export function useReturningGreeting(): ReturningGreeting {
    const titleGetterRef = React.useRef<GreetingGetter | null>(null);
    const subtitleGetterRef = React.useRef<GreetingGetter | null>(null);
    if (!titleGetterRef.current) titleGetterRef.current = pickRandom(TITLE_GETTERS);
    if (!subtitleGetterRef.current) subtitleGetterRef.current = pickRandom(SUBTITLE_GETTERS);
    // Each render re-invokes the locked getter so a locale-change while the
    // panel is mounted still picks up the new translation immediately.
    return {
        title: titleGetterRef.current(),
        subtitle: subtitleGetterRef.current(),
    };
}
