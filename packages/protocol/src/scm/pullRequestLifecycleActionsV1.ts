/** Canonical lifecycle vocabulary shared by provider facts and Workflow recipes. */
export const SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1 = [
    'opened', 'reopened', 'synchronize', 'closed', 'merged',
] as const;

/** Occurrences that can start new work; terminal Events remain observable. */
export const SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1 = Object.freeze(
    SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1.filter(action => action !== 'closed' && action !== 'merged'),
);
