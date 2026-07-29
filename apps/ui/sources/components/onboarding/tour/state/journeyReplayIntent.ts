import { Platform } from 'react-native';

import { journeyBeatById, type JourneyBeatId } from './journeyBeats';

// The journey replay deep-link (`?happier_journey_beat=<id>`) is a production
// entry point, not a debug-only one: it renders the journey for a returning user
// on demand. Consumers must keep it gated on the `app.ui.onboardingTour` feature
// decision so a flag-off build ignores the param entirely. This module is the
// single owner of the replay-intent read: both the Home route gate and
// `PreAuthOnboardingWizardEntry` consume it, so they can never disagree about
// whether an explicit replay was requested.
export const JOURNEY_REPLAY_BEAT_QUERY_PARAM = 'happier_journey_beat';

export function readWebQueryParam(name: string): string {
    if (Platform.OS !== 'web') return '';

    const location =
        typeof window !== 'undefined'
            ? window.location
            : (globalThis as unknown as { location?: { href?: unknown; search?: unknown } }).location;
    const search = typeof location?.search === 'string' ? location.search : '';
    const href = typeof location?.href === 'string' ? location.href : '';
    const fallbackSearch = !search && href.includes('?') ? href.slice(href.indexOf('?')) : '';
    const query = search || fallbackSearch;
    if (!query) return '';

    const value = new URLSearchParams(query).get(name);
    return typeof value === 'string' ? value.trim() : '';
}

export function readJourneyReplayBeatId(): JourneyBeatId | undefined {
    const candidate = readWebQueryParam(JOURNEY_REPLAY_BEAT_QUERY_PARAM);
    if (!candidate) return undefined;
    return journeyBeatById.has(candidate as JourneyBeatId) ? candidate as JourneyBeatId : undefined;
}
