/** Finite Account HTTP operations; shared by declarations and portable activation. */
import { TriageSourcesContributionProtocolV1, TriageSourceConnectedAccountInputsV1, TriageTaskWriteResultV1Schema, TriageListScopeUnitsResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { PosthogConfigurationDirectoryInputV1Schema, PosthogConfigurationDirectoryResultV1Schema } from './connect/configurationContract.js';
import { POSTHOG_ACTION_IDS, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_NETWORK_HOST_ACCESS_ID } from './posthogContracts.js';
import { PosthogNativeOverviewInputV1Schema, PosthogNativeOverviewResultV1Schema } from './source/detail/nativeOverviewContract.js';
import { PosthogIssueActivityInputV1Schema, PosthogIssueActivityResultV1Schema } from './source/detail/issueActivityContract.js';
import { PosthogSampledEventsInputV1Schema, PosthogSampledEventsResultV1Schema } from './source/detail/issueEventsContract.js';
import { PosthogCodeVariablesInputV1Schema, PosthogCodeVariablesResultV1Schema } from './source/detail/codeVariablesContract.js';
import { getPosthogSourceEntry, readPosthogNativeOverview, listPosthogInstances, readPosthogActivity, readPosthogConfigurationDirectory, readPosthogScopeUnits, readPosthogCodeVariablesForIssue, readPosthogSampledEvents, scanPosthogSource, resolvePosthogIssue, suppressPosthogIssue, unsuppressPosthogIssue, assignPosthogIssue } from './source/operations.js';
import { PosthogIssueAssignInputV1Schema, PosthogIssueWriteInputV1Schema } from './source/writeContracts.js';
const ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'posthog-account-runtime', exportName: 'activate' } } as const;
const sources = TriageSourcesContributionProtocolV1;
const READ_HOST_ACCESS = [POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_NETWORK_HOST_ACCESS_ID];
const INSTANCE_ACCOUNT_BINDINGS = [{
        path: 'instance.binding.account',
        purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    }];
export const POSTHOG_ACCOUNT_ACTIONS = {
    [POSTHOG_ACTION_IDS.resolve]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Resolve PostHog issue',
        description: 'Resolves one exact PostHog issue and confirms its live CRUD state.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Resolve this PostHog issue?', body: 'Changes this issue to Resolved in PostHog. Requires error_tracking:write.', confirmLabel: 'Resolve' },
        inputSchema: PosthogIssueWriteInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: resolvePosthogIssue,
    },
    [POSTHOG_ACTION_IDS.suppress]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Suppress PostHog issue',
        description: 'Suppresses one exact PostHog issue. PostHog will drop future events for this issue.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Suppress this PostHog issue?', body: 'PostHog will drop future events for this issue. Unsuppress allows future events again but does not recover dropped events. Requires error_tracking:write.', confirmLabel: 'Suppress issue' },
        inputSchema: PosthogIssueWriteInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: suppressPosthogIssue,
    },
    [POSTHOG_ACTION_IDS.unsuppress]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Unsuppress PostHog issue',
        description: 'Returns one exact PostHog issue to Active so PostHog can accept future events again.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Unsuppress this PostHog issue?', body: 'Returns this issue to Active in PostHog and allows future events again. Previously dropped events are not recovered. Requires error_tracking:write.', confirmLabel: 'Unsuppress issue' },
        inputSchema: PosthogIssueWriteInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: unsuppressPosthogIssue,
    },
    [POSTHOG_ACTION_IDS.assign]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Assign PostHog issue',
        description: 'Assigns one exact PostHog issue to the selected native user or role id.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: ['detailsPanel'],
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Assign this PostHog issue?', body: 'Changes the assignee in PostHog and may notify that user or role. Requires error_tracking:write.', confirmLabel: 'Assign' },
        inputSchema: PosthogIssueAssignInputV1Schema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: assignPosthogIssue,
    },
    [POSTHOG_ACTION_IDS.listScopeUnits]: {
        execution: ACCOUNT_EXECUTION,
        title: 'List PostHog environments',
        description: 'Lists selectable environments or the retained configured selection.',
        surfaces: sources.operations.listScopeUnits.declaration.surfaces,
        dangerLevel: 'safe', placementBindings: [],
        inputSchema: TriageSourceConnectedAccountInputsV1.listScopeUnits.jsonSchema,
        resultSchema: TriageListScopeUnitsResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: [{ path: 'draft.binding.account', purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }],
        run: readPosthogScopeUnits,
    },
    [POSTHOG_ACTION_IDS.configuration]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Configure PostHog error issues',
        description: 'Reads one user-requested page of PostHog organizations or environments.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: PosthogConfigurationDirectoryInputV1Schema.jsonSchema,
        resultSchema: PosthogConfigurationDirectoryResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: [{
                path: 'binding.account',
                purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            }],
        run: readPosthogConfigurationDirectory,
    },
    [POSTHOG_ACTION_IDS.listInstances]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Discover PostHog organizations',
        description: 'Lists the PostHog organizations each connected PostHog account can reach.',
        surfaces: sources.operations.listInstances.declaration.surfaces,
        // Mounted-only placement. `plugin` stays because the Triage daemon
        // consumes it and `ui` remains admitted by the shared get contract;
        // native Overview now consumes its own projection of this same read.
        // The explicit empty list only
        // withdraws the Action from global placement discovery — it
        // disables no invocation.
        placementBindings: [],
        dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
        inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
        resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        run: listPosthogInstances,
    },
    [POSTHOG_ACTION_IDS.scan]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Scan PostHog error issues',
        description: 'Reads one page of the configured PostHog error-issue walk.',
        surfaces: sources.operations.scan.declaration.surfaces,
        dangerLevel: sources.operations.scan.declaration.dangerLevel,
        inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
        resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: scanPosthogSource,
    },
    [POSTHOG_ACTION_IDS.issueEvents]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read sampled PostHog occurrences',
        description: 'Reads one bounded page of sampled exception events for one PostHog issue.',
        // Native reads share the configured-account owner across UI and agent
        // surfaces; the empty list only removes global placement discovery.
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: PosthogSampledEventsInputV1Schema.jsonSchema,
        resultSchema: PosthogSampledEventsResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: readPosthogSampledEvents,
    },
    [POSTHOG_ACTION_IDS.issueActivity]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read PostHog issue activity',
        description: 'Reads one page of the recorded activity for one PostHog issue.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: PosthogIssueActivityInputV1Schema.jsonSchema,
        resultSchema: PosthogIssueActivityResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: readPosthogActivity,
    },
    [POSTHOG_ACTION_IDS.codeVariables]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Reveal captured PostHog code variables',
        description: 'Rereads one selected occurrence and returns its captured variables after confirmation.',
        dangerLevel: 'safe',
        confirmation: {
            title: { key: 'plugins.posthog.ui.codeVariables.confirmTitle', fallback: 'Reveal sensitive captured variables?' },
            body: { key: 'plugins.posthog.ui.codeVariables.confirmDescription', fallback: 'Captured local variables can contain credentials, tokens, personal data, and request bodies.' },
        },
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: PosthogCodeVariablesInputV1Schema.jsonSchema,
        resultSchema: PosthogCodeVariablesResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: readPosthogCodeVariablesForIssue,
    },
    [POSTHOG_ACTION_IDS.nativeOverview]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read a PostHog issue overview',
        description: 'Reads native overview facts and query-enrichment status through the canonical issue read.',
        surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
        placementBindings: [],
        inputSchema: PosthogNativeOverviewInputV1Schema.jsonSchema,
        resultSchema: PosthogNativeOverviewResultV1Schema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: readPosthogNativeOverview,
    },
    [POSTHOG_ACTION_IDS.get]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read a PostHog error issue',
        description: 'Reads one PostHog error issue authoritatively through its configured environment.',
        surfaces: sources.operations.get.declaration.surfaces,
        // Mounted-only placement. `plugin` stays because the Triage daemon
        // consumes it and `ui` because this source's own mounted surfaces
        // hold present-user authority; the explicit empty list only
        // withdraws the Action from global placement discovery — it
        // disables no invocation.
        placementBindings: [],
        dangerLevel: sources.operations.get.declaration.dangerLevel,
        inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
        resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
        hostAccess: READ_HOST_ACCESS,
        connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
        run: getPosthogSourceEntry,
    }
} as const;
