import { useSegments } from "expo-router";
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
import { tracking } from "./tracking";
import React from "react";

import { projectParameterFreeRoute } from './parameterFreeRouteProjection';

export function useTrackScreens() {
    const route = projectParameterFreeRoute(useSegments()).route;
    React.useEffect(() => {
        tracking?.screen(route);
        recordBugReportUserAction('screen.navigate', { route });
    }, [route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
}
