/** Finite Account HTTP operations; shared by declarations and portable activation. */
import { TriageSourcesContributionProtocolV1, TriageSourceConnectedAccountInputsV1, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID, SENTRY_ACTION_IDS, SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID, SENTRY_CONNECTED_ACCOUNT_PURPOSE } from './sentryContracts.js';
import { SentryIssueEventsInputV1Schema, SentryIssueEventsResultV1Schema, SentryReadEventInputV1Schema, SentryReadEventResultV1Schema, SentryReadIssueInputV1Schema, SentryReadIssueResultV1Schema, SentryTagValuesInputV1Schema, SentryTagValuesResultV1Schema } from './detail/detailContracts.js';
import { listSentryIssueEvents, listSentryTagValues, readSentryEvent, readSentryIssue } from './source/detailOperations.js';
import { getSentrySourceEntry, listSentryInstances, scanSentrySource } from './source/operations.js';
import { SentryIssueAssignInputV1Schema, SentryIssueWriteInputV1Schema } from './source/writeContracts.js';
import { archiveSentryIssue, assignSentryIssue, resolveSentryIssue } from './source/writeOperations.js';
import { listSentryScopeUnits } from './source/scopeUnits.js';
const ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'sentry-account-runtime', exportName: 'activate' } } as const;
const sources = TriageSourcesContributionProtocolV1;
export const READ_HOST_ACCESS = [
    SENTRY_CONNECTED_ACCOUNT_PURPOSE,
    SENTRY_CLOUD_NETWORK_HOST_ACCESS_ID,
    SENTRY_ACCOUNT_NETWORK_HOST_ACCESS_ID,
];
const INSTANCE_ACCOUNT_BINDINGS = [{
        path: 'instance.binding.account',
        purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
    }];
export const SENTRY_ACCOUNT_ACTIONS = {
    [SENTRY_ACTION_IDS.resolve]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Resolve Sentry issue',
        description: 'Resolves one exact Sentry issue and confirms its live state.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Resolve this Sentry issue?', body: 'Changes this issue to Resolved in Sentry. Requires event:write.', confirmLabel: 'Resolve' },
        inputSchema: SentryIssueWriteInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: resolveSentryIssue,
    },
    [SENTRY_ACTION_IDS.archive]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Archive Sentry issue',
        description: 'Archives one exact Sentry issue forever and confirms its live state.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Archive this Sentry issue forever?', body: 'Sets this issue to Archived forever in Sentry. This does not discard incoming events. Requires event:write.', confirmLabel: 'Archive' },
        inputSchema: SentryIssueWriteInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: archiveSentryIssue,
    },
    [SENTRY_ACTION_IDS.assign]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Assign Sentry issue',
        description: 'Assigns one exact Sentry issue to the selected native user or team id.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Assign this Sentry issue?', body: 'Changes the assignee in Sentry and may notify that user or team. Requires event:write.', confirmLabel: 'Assign' },
        inputSchema: SentryIssueAssignInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: assignSentryIssue,
    },
    [SENTRY_ACTION_IDS.listInstances]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Discover Sentry organizations',
        description: 'Lists the Sentry organizations each connected Sentry account can reach.',
        surfaces: sources.operations.listInstances.declaration.surfaces,
        // Mounted-only placement. `plugin` stays because the Triage daemon
        // consumes it and `ui` because this source's own mounted surfaces hold
        // present-user authority; the explicit empty list only withdraws the
        // Action from global placement discovery — it disables no invocation.
        placementBindings: [],
        dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
        inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
        resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        run: listSentryInstances,
    },
    [SENTRY_ACTION_IDS.listScopeUnits]: {
        execution: ACCOUNT_EXECUTION,
        title: 'List Sentry projects',
        description: 'Lists searchable projects in this organization, or reads its saved project selection.',
        surfaces: sources.operations.listScopeUnits.declaration.surfaces,
        placementBindings: [],
        dangerLevel: sources.operations.listScopeUnits.declaration.dangerLevel,
        inputSchema: TriageSourceConnectedAccountInputsV1.listScopeUnits.jsonSchema,
        resultSchema: sources.operations.listScopeUnits.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: [{ path: 'draft.binding.account', purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE }],
        run: listSentryScopeUnits,
    },
    [SENTRY_ACTION_IDS.scan]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Scan Sentry issues',
        description: 'Reads one page of the configured Sentry organization issue walk.',
        surfaces: sources.operations.scan.declaration.surfaces,
        dangerLevel: sources.operations.scan.declaration.dangerLevel,
        inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
        resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: scanSentrySource,
    },
    [SENTRY_ACTION_IDS.readIssue]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read one Sentry issue projection',
        description: 'Reads the live summary, assignment choices, the tag distribution, or the recorded activity of'
            + ' one Sentry issue.',
        // Native reads share the configured-account owner across UI and agent
        // surfaces; the empty list only removes global placement discovery.
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: SentryReadIssueInputV1Schema.jsonSchema,
        resultSchema: SentryReadIssueResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: readSentryIssue,
    },
    [SENTRY_ACTION_IDS.listIssueEvents]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read retained Sentry occurrences',
        description: 'Reads one page of the events Sentry retained for one issue in the queried'
            + ' window.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: SentryIssueEventsInputV1Schema.jsonSchema,
        resultSchema: SentryIssueEventsResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: listSentryIssueEvents,
    },
    [SENTRY_ACTION_IDS.readEvent]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read one Sentry occurrence',
        description: 'Reads the representative or one selected occurrence of a Sentry issue as a'
            + ' redacted projection.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: SentryReadEventInputV1Schema.jsonSchema,
        resultSchema: SentryReadEventResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: readSentryEvent,
    },
    [SENTRY_ACTION_IDS.listTagValues]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read one Sentry tag distribution',
        description: 'Reads one page of the value distribution of a single tag key on one issue.',
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: [],
        inputSchema: SentryTagValuesInputV1Schema.jsonSchema,
        resultSchema: SentryTagValuesResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: listSentryTagValues,
    },
    [SENTRY_ACTION_IDS.get]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read a Sentry issue',
        description: 'Reads one Sentry issue authoritatively through its configured organization.',
        surfaces: sources.operations.get.declaration.surfaces,
        // Mounted-only placement. `plugin` stays because the Triage daemon
        // consumes it and `ui` because this source's own mounted surfaces hold
        // present-user authority; the explicit empty list only withdraws the
        // Action from global placement discovery — it disables no invocation.
        placementBindings: [],
        dangerLevel: sources.operations.get.declaration.dangerLevel,
        inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
        resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: getSentrySourceEntry,
    }
} as const;
