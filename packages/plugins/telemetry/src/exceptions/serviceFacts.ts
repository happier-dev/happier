import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { PluginServiceListFieldResourceInputV1Schema, type PluginServiceListFieldResourceResultV1 } from '@happier-dev/plugin-sdk/ui';

import { TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1, TELEMETRY_EXCEPTION_ENVIRONMENT_INDEX, type ExceptionIssueRecord } from './issueRecord.js';
import { exceptionLocalRefV1, TELEMETRY_EXCEPTION_SOURCE_V1 } from './source.js';
import { TELEMETRY_LAST_ISSUE_SEEN_FACT_ID, TELEMETRY_LATEST_ISSUE_ENTRY_FACT_ID, TELEMETRY_OPEN_ISSUES_FIELD } from './serviceFactIds.js';
import { TELEMETRY_ACCOUNT_EXECUTION, TELEMETRY_EXCEPTION_SOURCE_ACTIONS } from './sourceActions.js';

function environmentIssueDemand(options: PluginDynamicResourceInvocationOptionsV1) {
    if (options.context.kind !== 'surface') throw new PluginError({ code: 'plugin_resource_demand_unavailable' });
    if (!options.accountStorage) throw new PluginError({ code: 'plugin_account_storage_unavailable' });
    const { environmentIds } = PluginServiceListFieldResourceInputV1Schema.parse(options.context.launchInput);
    return {
        issues: options.accountStorage.collection(TELEMETRY_EXCEPTION_ISSUES_COLLECTION_V1),
        environmentIds: [...new Set(environmentIds)],
    };
}

const issueResource: PluginDynamicResourceRuntime = {
    async read(options) {
        const { issues, environmentIds } = environmentIssueDemand(options);
        if (!environmentIds.length) return JSON.stringify({ items: [] });
        const query = { index: TELEMETRY_EXCEPTION_ENVIRONMENT_INDEX, order: 'asc', prefixes: environmentIds.map(id => [id]) } as const;
        const perEnvironment = new Map(environmentIds.map(id => [id, { open: new Set<string>(), latest: null as { at: number; rowId: string; ownerAccountId: string | null } | null }]));
        const cancellation = { signal: options.signal };
        const include = (row: ExceptionIssueRecord, ownerAccountId: string | null, rowId: string) => {
            const summary = perEnvironment.get(row.environmentId);
            if (!summary) return;
            if (row.status === 'open') summary.open.add(JSON.stringify([ownerAccountId, rowId]));
            if (summary.latest === null || row.lastSeenAtMs > summary.latest.at) {
                summary.latest = { at: row.lastSeenAtMs, rowId, ownerAccountId };
            }
        };

        const readOwn = async () => {
            let cursor: string | undefined;
            do {
                const page = await issues.query({ ...query, ...(cursor ? { cursor } : {}) }, cancellation);
                for (const row of page.rows) include(row.value, null, row.rowId);
                cursor = page.nextCursor;
            } while (cursor);
        };
        const readShared = async () => {
            let cursor: string | undefined;
            do {
                const page = await issues.sharing.sharedWithMe({ query: { ...query, ...(cursor ? { cursor } : {}) } }, cancellation);
                for (const row of page.rows) {
                    if (row.access !== 'owner') include(row.value, row.ownerAccountId, row.rowId);
                }
                cursor = page.nextCursor;
            } while (cursor);
        };
        await Promise.all([readOwn(), readShared()]);
        return JSON.stringify({ items: [...perEnvironment].map(([environmentId, summary]) => ({
            environmentId, value: null, facts: {
                // No open issue is the healthy state: it says nothing rather than "Open issues 0" under every row (R20-D8).
                ...(summary.open.size > 0 ? { [TELEMETRY_OPEN_ISSUES_FIELD.id]: { value: summary.open.size } } : {}),
                [TELEMETRY_LAST_ISSUE_SEEN_FACT_ID]: { value: summary.latest?.at ?? null },
                ...(summary.latest ? { [TELEMETRY_LATEST_ISSUE_ENTRY_FACT_ID]: { value: buildTriageEntryRouteSegmentV1({
                    source: TELEMETRY_EXCEPTION_SOURCE_V1, ...exceptionLocalRefV1(summary.latest.rowId, summary.latest.ownerAccountId ?? undefined),
                }) } } : {}),
            },
        })) } satisfies PluginServiceListFieldResourceResultV1);
    },
    observe(invalidate, options) {
        // Own and shared notifications use the same entitled Account Collection change channel.
        return environmentIssueDemand(options).issues.watch({ kind: 'collection' }, invalidate);
    },
};

export const TELEMETRY_SERVICE_ISSUE_RESOURCES = {
    [TELEMETRY_OPEN_ISSUES_FIELD.source.resource]: {
        source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', hostAccess: ['account-storage'],
        execution: TELEMETRY_ACCOUNT_EXECUTION,
        runtime: issueResource,
    },
} as const;

export const TELEMETRY_ACCOUNT_DEFINITION = {
    id: 'happier.telemetry', version: '0.0.0', displayName: 'Telemetry',
    hostAccess: { required: [], optional: [{ id: 'account-storage', capability: 'storage.account', reason: 'Read the Project capture preference and keep native exception issues.', scope: { enabled: true } }] },
    actions: TELEMETRY_EXCEPTION_SOURCE_ACTIONS,
    resources: TELEMETRY_SERVICE_ISSUE_RESOURCES,
} as const;
