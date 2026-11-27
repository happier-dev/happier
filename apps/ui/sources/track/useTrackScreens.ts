import { useSegments } from "expo-router";
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { tracking } from "./tracking";
import React from "react";

const UUID_SEGMENT_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT_REGEX = /^\d+$/;
const OPAQUE_ID_SEGMENT_REGEX = /^[A-Za-z0-9_-]{20,}$/;

function sanitizeRouteSegment(segment: string): string {
    const value = String(segment ?? '').trim();
    if (!value) return '';
    if (NUMERIC_SEGMENT_REGEX.test(value) || UUID_SEGMENT_REGEX.test(value) || OPAQUE_ID_SEGMENT_REGEX.test(value)) {
        return ':id';
    }
    return value;
}

// expo-router drops a trailing `index`, so the root screen's segments are only its groups.
const ROOT_SCREEN_NAME = 'home';

/** The screen name for these route segments, or '' while the router has resolved none. */
function resolveScreenName(segments: readonly string[]): string {
    if (segments.length === 0) return '';
    // Using segments before normalizing to avoid leaking any params
    const route = segments
        .filter(segment => !segment.startsWith('('))
        .map(sanitizeRouteSegment)
        .join('/');
    return route || ROOT_SCREEN_NAME;
}

export function useTrackScreens() {
    const route = resolveScreenName(useSegments());
    React.useEffect(() => {
        // No segments yet (the router has not resolved a route): not a screen.
        if (route) tracking?.screen(route);
        recordBugReportUserAction('screen.navigate', { route });
    }, [route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
}
