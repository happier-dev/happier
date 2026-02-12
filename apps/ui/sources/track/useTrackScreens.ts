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

export function useTrackScreens() {
    const route = useSegments()
        .filter(segment => !segment.startsWith('('))
        .map(sanitizeRouteSegment)
        .join('/'); // Using segments before normalizing to avoid leaking any params
    React.useEffect(() => {
        tracking?.screen(route);
        recordBugReportUserAction('screen.navigate', { route });
    }, [route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
}
