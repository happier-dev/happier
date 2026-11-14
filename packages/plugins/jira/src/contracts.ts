import type { TriageListSortFieldV1 } from '@happier-dev/triage-protocol/v1';

export const JIRA_PLUGIN_ID = 'happier.jira';
export const JIRA_ACCOUNT_PURPOSE = 'jira-account';
export const JIRA_SOURCE_ID = 'jira-issues';
export const JIRA_ACTIONS = {
  listCreationPlaces: 'jira/list-creation-places',
    listInstances: 'triage/list-instances', listScopeUnits: 'triage/list-projects', scan: 'triage/scan', get: 'triage/get',
    detail: 'triage/read-detail', create: 'issues/create', edit: 'issues/edit',
    transition: 'issues/transition', comment: 'issues/comment', issueTypes: 'issues/list-types',
} as const;

/** JQL's date fields share the projected timestamp order in both directions. */
export const JIRA_SORT_COLUMNS: ReadonlyMap<TriageListSortFieldV1, string> = new Map<TriageListSortFieldV1, string>([
    ['updated', 'updated'], ['created', 'created'], ['due', 'duedate'],
]);
