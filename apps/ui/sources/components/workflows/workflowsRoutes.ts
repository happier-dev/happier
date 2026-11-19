/** Where each way into a new workflow goes; the editor owns what happens next. */
export const WORKFLOWS_NEW_ROUTE = '/workflows/new';
export const WORKFLOWS_IMPORT_ROUTE = '/workflows/new?importJson=1';
export const WORKFLOWS_RUN_SETTINGS_ROUTE = '/workflows/settings';
export const WORKFLOWS_EVENTS_ROUTE = '/workflows/events';
export const WORKFLOWS_RUNS_ROUTE = '/workflows/runs';
/** One observed event, read in the main pane beside the column or pushed on a phone. */
export function createWorkflowEventRoute(eventKey: string): `/workflows/events/${string}` {
    return `${WORKFLOWS_EVENTS_ROUTE}/${encodeURIComponent(eventKey)}`;
}
