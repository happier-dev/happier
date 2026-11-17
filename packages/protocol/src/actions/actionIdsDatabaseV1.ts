/** Qualified semantic database Actions; dependency-neutral identity owner for every feature consumer. */
export const DATABASE_PLUGIN_ID_V1 = 'happier.database' as const;
export const DATABASE_TARGETS_LIST_ACTION_ID_V1 = 'happier.database/actions/targets/list' as const;
export const DATABASE_TARGETS_CONNECT_ACTION_ID_V1 = 'happier.database/actions/targets/connect' as const;
export const DATABASE_TARGETS_FORGET_ACTION_ID_V1 = 'happier.database/actions/targets/forget' as const;
export const DATABASE_DESCRIBE_ACTION_ID_V1 = 'happier.database/actions/describe' as const;
export const DATABASE_SCHEMAS_LIST_ACTION_ID_V1 = 'happier.database/actions/schemas/list' as const;
export const DATABASE_RELATIONS_LIST_ACTION_ID_V1 = 'happier.database/actions/relations/list' as const;
export const DATABASE_STRUCTURE_READ_ACTION_ID_V1 = 'happier.database/actions/structure/read' as const;
export const DATABASE_ROWS_READ_ACTION_ID_V1 = 'happier.database/actions/rows/read' as const;
export const DATABASE_ROWS_EXPORT_ACTION_ID_V1 = 'happier.database/actions/rows/export' as const;
export const DATABASE_CELL_READ_ACTION_ID_V1 = 'happier.database/actions/cell/read' as const;
export const DATABASE_STATEMENT_RUN_ACTION_ID_V1 = 'happier.database/actions/statement/run' as const;
export const DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1 = 'happier.database/actions/statement/explain' as const;
export const DATABASE_EDITS_APPLY_ACTION_ID_V1 = 'happier.database/actions/edits/apply' as const;
export const DATABASE_ACCESS_READ_ACTION_ID_V1 = 'happier.database/actions/access/read' as const;
export const DATABASE_ACCESS_SET_ACTION_ID_V1 = 'happier.database/actions/access/set' as const;
export const UI_DATABASE_OPEN_ACTION_ID_V1 = 'happier.database/actions/ui/open' as const;
export const UI_DATABASE_NAVIGATE_ACTION_ID_V1 = 'happier.database/actions/ui/navigate' as const;
export const UI_DATABASE_DRAFT_READ_ACTION_ID_V1 = 'happier.database/actions/ui/draft/read' as const;
export const DATABASE_STATS_READ_ACTION_ID_V1 = 'happier.database/actions/stats/read' as const;
export const DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1 = 'happier.database/actions/activity/cancel' as const;
export const DATABASE_STATS_ENABLE_ACTION_ID_V1 = 'happier.database/actions/stats/enable' as const;
export const DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1 = 'happier.database/actions/insights/findings/list' as const;
export const DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1 = 'happier.database/actions/insights/findings/read' as const;
export const DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1 = 'happier.database/actions/insights/brief/build' as const;
export const DATABASE_CAPTURE_STATUS_ACTION_ID_V1 = 'happier.telemetry/actions/capture/status' as const;
export const DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1 = 'happier.telemetry/actions/capture/queries/list' as const;
export const DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1 = 'happier.telemetry/actions/capture/query/get' as const;
export const DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1 = 'happier.telemetry/actions/capture/traces/list' as const;
export const DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1 = 'happier.telemetry/actions/capture/trace/get' as const;
export const DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1 = 'happier.telemetry/actions/capture/logs/list' as const;
export const DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1 = 'happier.telemetry/actions/capture/endpoints/list' as const;
export const DATABASE_CAPTURE_CLEAR_ACTION_ID_V1 = 'happier.telemetry/actions/capture/clear' as const;
export const DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1 = 'happier.telemetry/actions/capture/configure' as const;
export const TELEMETRY_METRICS_READ_ACTION_ID_V1 = 'happier.telemetry/actions/capture/metrics/read' as const;
export const TELEMETRY_COSTS_READ_ACTION_ID_V1 = 'happier.telemetry/actions/capture/costs/read' as const;
export const TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1 = 'happier.telemetry/actions/health/key-flow' as const;
export const TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1 = 'happier.telemetry/actions/capture/regressions/compare' as const;
export const TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1 = 'happier.telemetry/actions/capture/regressions/schedule' as const;
export const TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1 = 'happier.telemetry/actions/capture/exceptions/occurrences/read' as const;
export const TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1 = 'happier.telemetry/actions/capture/exceptions/issues/transition' as const;
export const TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1 = 'happier.telemetry/actions/capture/exceptions/issues/refresh' as const;

export const DATABASE_ACTION_IDS_V1 = [
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
    DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
    DATABASE_TARGETS_FORGET_ACTION_ID_V1,
    DATABASE_DESCRIBE_ACTION_ID_V1,
    DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
    DATABASE_RELATIONS_LIST_ACTION_ID_V1,
    DATABASE_STRUCTURE_READ_ACTION_ID_V1,
    DATABASE_ROWS_READ_ACTION_ID_V1,
    DATABASE_ROWS_EXPORT_ACTION_ID_V1,
    DATABASE_CELL_READ_ACTION_ID_V1,
    DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    DATABASE_EDITS_APPLY_ACTION_ID_V1,
    DATABASE_ACCESS_READ_ACTION_ID_V1,
    DATABASE_ACCESS_SET_ACTION_ID_V1,
    UI_DATABASE_OPEN_ACTION_ID_V1,
    UI_DATABASE_NAVIGATE_ACTION_ID_V1,
    UI_DATABASE_DRAFT_READ_ACTION_ID_V1,
    DATABASE_STATS_READ_ACTION_ID_V1,
    DATABASE_ACTIVITY_CANCEL_ACTION_ID_V1,
    DATABASE_STATS_ENABLE_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
    DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
    DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
    DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
    TELEMETRY_METRICS_READ_ACTION_ID_V1,
    TELEMETRY_COSTS_READ_ACTION_ID_V1,
    TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1,
    TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1,
    TELEMETRY_REGRESSIONS_SCHEDULE_ACTION_ID_V1,
    TELEMETRY_EXCEPTION_OCCURRENCES_READ_ACTION_ID_V1,
    TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1,
    TELEMETRY_EXCEPTION_ISSUES_REFRESH_ACTION_ID_V1,
] as const;

export type DatabaseActionIdV1 = typeof DATABASE_ACTION_IDS_V1[number];

export function isDatabaseActionIdV1(id: string): id is DatabaseActionIdV1 {
    return DATABASE_ACTION_IDS_V1.some(actionId => actionId === id);
}

/** The manifest-local identity comes from the qualified canonical identity. */
export function databaseActionLocalIdV1<T extends DatabaseActionIdV1>(id: T): T extends `${string}/actions/${infer LocalId}` ? LocalId : never {
    // Every admitted value is a member of the qualified literal union above.
    return id.slice(id.indexOf('/actions/') + '/actions/'.length) as T extends `${string}/actions/${infer LocalId}` ? LocalId : never;
}
