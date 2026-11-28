export const TELEMETRY_OPEN_ISSUES_FIELD = {
    id: 'open-issues', title: 'Open issues', source: { resource: 'environment-open-issues' },
    value: { kind: 'number', unit: '{issue}' }, byline: true,
} as const;

export const TELEMETRY_LAST_ISSUE_SEEN_FACT_ID = 'last-issue-seen';
export const TELEMETRY_LATEST_ISSUE_ENTRY_FACT_ID = 'latest-issue-entry';
