import { buildTriageEntryRouteSegmentV1, INTERNAL_TASK_SOURCE_V1, internalTaskLocalRefV1 } from '@happier-dev/triage-protocol/v1';

const parameter = '{id}';
const taskSelection = buildTriageEntryRouteSegmentV1({
    source: INTERNAL_TASK_SOURCE_V1,
    ...internalTaskLocalRefV1(parameter),
}).replace(encodeURIComponent(parameter), parameter);

/** Historical Tasks URLs select the same internal task through the app-page owner. */
export const TRIAGE_LEGACY_TASK_ROUTE_ALIASES = [
    { pathname: '/zen' },
    { pathname: '/zen/new' },
    { pathname: '/zen/view', subPath: taskSelection },
    { pathname: '/zen/[id]', subPath: taskSelection },
];
