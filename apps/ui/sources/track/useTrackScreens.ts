import { useSegments } from "expo-router";
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { tracking } from "./tracking";
import React from "react";

import { projectParameterFreeRoute } from './parameterFreeRouteProjection';

export function useTrackScreens() {
    const segments = useSegments();
    const route = projectParameterFreeRoute(segments).route;
    // No segments yet means the router has not resolved a route: that is not a screen view. The
    // root route still has its group segments and is sent as `home`.
    const resolved = segments.length > 0;
    React.useEffect(() => {
        if (resolved) tracking?.screen(route);
        recordBugReportUserAction('screen.navigate', { route });
    }, [resolved, route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
}
