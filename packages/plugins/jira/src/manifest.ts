import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageSourceConnectedAccountInputsV1, TriageSourcesContributionProtocolV1,
    TriageTaskWriteResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { withTriageSourceSettingsTranslationsV1 } from '@happier-dev/triage-sources/translations';
import { JIRA_UI_TRANSLATIONS } from './ui/translations.js';
import { JIRA_ACCOUNT_PURPOSE, JIRA_ACTIONS, JIRA_PLUGIN_ID, JIRA_SOURCE_ID } from './contracts.js';
import { jiraAccountRuntime } from './connect.js';
import { getJiraEntry, listJiraInstances, listJiraScopeUnits, scanJiraSource } from './source/operations.js';
import { JiraDetailResultSchema, readJiraDetail } from './source/detail.js';
import { JiraCommentInputSchema, createJiraIssue, editJiraIssue, transitionJiraIssue, commentJiraIssue } from './source/writes.js';
import { JIRA_TASK_FIELDS } from './source/metadata.js';
import { listJiraIssueTypes } from './source/configuration.js';
import { JiraIssueTypesInputSchema, JiraIssueTypesResultSchema } from './source/configurationContract.js';

const sources = TriageSourcesContributionProtocolV1;
const access = [JIRA_ACCOUNT_PURPOSE, 'jira-api'];
const bindings = [{ path: 'instance.binding.account', purpose: JIRA_ACCOUNT_PURPOSE }];
export const JIRA_PLUGIN = definePlugin({
    id: JIRA_PLUGIN_ID, version: '0.0.0', displayName: 'Jira',
    description: 'Jira Cloud issues, native workflows and linked work in PRs, Issues & Tasks.',
    engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: { required: [
        { id: JIRA_ACCOUNT_PURPOSE, capability: 'connectedAccounts', reason: 'Use the exact selected Jira Cloud account.',
            scope: { serviceRefs: [JIRA_ACCOUNT_PURPOSE], operations: ['select', 'use'], materializationKinds: ['httpHeaders'] } },
        { id: 'jira-api', capability: 'network', reason: 'Read and update Jira Cloud issues on the selected account’s site.',
            scope: { targets: [{ kind: 'connectedAccountOrigin', service: JIRA_ACCOUNT_PURPOSE }], methods: ['GET', 'POST', 'PUT'] } },
    ], optional: [] },
    ui: {
        views: [],
        renderers: [
            { id: 'jira-detail', kind: 'reactNative', artifact: 'jira-detail-native', requiredHostMethods: ['executeAction'] },
            { id: 'jira-detail-fallback', kind: 'declarative', root: { kind: 'text', text: 'Jira issue details are unavailable on this surface.' } },
            { id: 'jira-source-settings', kind: 'reactNative', artifact: 'jira-settings-native', requiredHostMethods: ['executeAction', 'openConnectedAccounts'] },
        ],
        settingsGroups: [{ id: 'jira', title: 'Jira', icon: 'settings' }],
        settingsPages: [{ id: 'jira-sources', group: { kind: 'plugin', localId: 'jira' }, title: 'PRs, Issues & Tasks',
            subtitle: 'Choose which Jira Cloud projects appear in PRs, Issues & Tasks.', keywords: ['jira', 'issues', 'tasks'], icon: 'settings', renderer: 'jira-source-settings' }],
        translations: withTriageSourceSettingsTranslationsV1(JIRA_UI_TRANSLATIONS),
    },
    connectedAccountDescriptors: {
        [JIRA_ACCOUNT_PURPOSE]: {
            declaration: {
                title: 'Jira Cloud account', description: 'A Jira Cloud site and a personal Atlassian API token.',
                authentication: { defaultModeId: 'api-token', modes: [{
                    id: 'api-token', kind: 'manual', title: 'Personal API token (without scopes)', outcomeReconciliation: 'none',
                    directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
                    fields: [
                        { id: 'email', title: 'Atlassian account email', secret: false, schema: { type: 'string', minLength: 1 } },
                        { id: 'token', title: 'API token', secret: true, schema: { type: 'string', minLength: 1 } },
                    ],
                    configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{
                        id: 'site', title: 'Jira Cloud site', required: true, secret: false,
                        semantic: 'connectedAccountOrigin', schema: { type: 'string', minLength: 1 },
                    }] },
      setup: {
                        url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
                        checklist: ['Create an API token without scopes in your Atlassian account; this connection uses your Jira site URL.', 'Copy the token and enter the email address of the Atlassian account that created it.', 'Enter the Jira Cloud site that account can access.'],
                        createKeyTitle: 'Open Atlassian API tokens',
                    },
                }] },
            }, runtime: jiraAccountRuntime,
        },
    },
    actions: {
        [JIRA_ACTIONS.issueTypes]: {
            title: 'Read Jira issue types', surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
            placementBindings: [], dangerLevel: 'safe', hostAccess: access,
            connectedAccountPurposeBindings: [{ path: 'binding.account', purpose: JIRA_ACCOUNT_PURPOSE }],
            inputSchema: JiraIssueTypesInputSchema.jsonSchema, resultSchema: JiraIssueTypesResultSchema.jsonSchema,
            run: listJiraIssueTypes,
        },
        [JIRA_ACTIONS.create]: {
            title: 'Create a Jira issue', surfaces: sources.operations.create.declaration.surfaces,
            confirmation: { title: 'Create Jira issue', body: 'Create this issue on the selected Jira Cloud site?' },
            dangerLevel: 'writesRemote', hostAccess: access, connectedAccountPurposeBindings: bindings,
            inputSchema: TriageSourceConnectedAccountInputsV1.create.jsonSchema,
            resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: createJiraIssue,
        },
        [JIRA_ACTIONS.edit]: {
            title: 'Edit a Jira issue', surfaces: sources.operations.edit.declaration.surfaces,
            confirmation: { title: 'Edit Jira issue', body: 'Apply these changes to the selected Jira issue?' },
            dangerLevel: 'writesRemote', hostAccess: access, connectedAccountPurposeBindings: bindings,
            inputSchema: TriageSourceConnectedAccountInputsV1.edit.jsonSchema,
            resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: editJiraIssue,
        },
        [JIRA_ACTIONS.transition]: {
            title: 'Transition a Jira issue', surfaces: sources.operations.transition.declaration.surfaces,
            confirmation: { title: 'Transition Jira issue', body: 'Apply this native workflow transition to the selected Jira issue?' },
            dangerLevel: 'writesRemote', hostAccess: access, connectedAccountPurposeBindings: bindings,
            inputSchema: TriageSourceConnectedAccountInputsV1.transition.jsonSchema,
            resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: transitionJiraIssue,
        },
        [JIRA_ACTIONS.comment]: {
            title: 'Comment on a Jira issue', surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
            confirmation: { title: 'Comment on Jira issue', body: 'Publish this comment on the selected Jira issue?' },
            dangerLevel: 'writesRemote', hostAccess: access,
            connectedAccountPurposeBindings: [{ path: 'entry.instance.binding.account', purpose: JIRA_ACCOUNT_PURPOSE }],
            inputSchema: JiraCommentInputSchema.jsonSchema,
            resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: commentJiraIssue,
        },
        [JIRA_ACTIONS.listInstances]: {
            title: 'Discover Jira sites', surfaces: sources.operations.listInstances.declaration.surfaces,
            placementBindings: [], dangerLevel: 'safe', hostAccess: access,
            inputSchema: TriageSourceConnectedAccountInputsV1.listInstances.jsonSchema,
            resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema, run: listJiraInstances,
        },
        [JIRA_ACTIONS.scan]: {
            title: 'Scan Jira issues', surfaces: sources.operations.scan.declaration.surfaces,
            dangerLevel: 'safe', hostAccess: access, connectedAccountPurposeBindings: bindings,
            inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
            resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema, run: scanJiraSource,
        },
        [JIRA_ACTIONS.listScopeUnits]: {
            title: 'List Jira projects', surfaces: sources.operations.listScopeUnits.declaration.surfaces,
            placementBindings: [], dangerLevel: 'safe', hostAccess: access,
            connectedAccountPurposeBindings: [{ path: 'draft.binding.account', purpose: JIRA_ACCOUNT_PURPOSE }],
            inputSchema: TriageSourceConnectedAccountInputsV1.listScopeUnits.jsonSchema,
            resultSchema: sources.operations.listScopeUnits.declaration.resultSchema.jsonSchema, run: listJiraScopeUnits,
        },
        [JIRA_ACTIONS.get]: {
            title: 'Read a Jira issue', surfaces: sources.operations.get.declaration.surfaces,
            placementBindings: [], dangerLevel: 'safe', hostAccess: access, connectedAccountPurposeBindings: bindings,
            inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
            resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema, run: getJiraEntry,
        },
        [JIRA_ACTIONS.detail]: {
            title: 'Read Jira issue details', surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
            placementBindings: [], dangerLevel: 'safe', hostAccess: access, connectedAccountPurposeBindings: bindings,
            inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
            resultSchema: JiraDetailResultSchema.jsonSchema, run: readJiraDetail,
        },
    },
    contributesTo: { [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: { [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [JIRA_SOURCE_ID]: sources.contribute({
            descriptor: { v: 1, purpose: JIRA_ACCOUNT_PURPOSE, displayName: 'Jira', settingsPageId: 'jira-sources',
                scopeUnit: { singularLabel: 'Project', pluralLabel: 'Projects' },
                kinds: [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue', pluralDisplayName: 'Issues',
                    task: true, taskCapabilities: { completedScan: true, createFields: JIRA_TASK_FIELDS, editFields: JIRA_TASK_FIELDS },
                    detailTabs: [{ kind: 'shared', id: 'overview' }] }] },
            operations: { listInstances: sources.operations.listInstances.bind(JIRA_ACTIONS.listInstances),
                listScopeUnits: sources.operations.listScopeUnits.bind(JIRA_ACTIONS.listScopeUnits),
                scan: sources.operations.scan.bind(JIRA_ACTIONS.scan), get: sources.operations.get.bind(JIRA_ACTIONS.get),
                create: sources.operations.create.bind(JIRA_ACTIONS.create), edit: sources.operations.edit.bind(JIRA_ACTIONS.edit),
                transition: sources.operations.transition.bind(JIRA_ACTIONS.transition) },
            surfaces: { detail: { renderer: 'jira-detail', fallbackRenderers: ['jira-detail-fallback'] } },
        }),
    } } },
});
export const PLUGIN_MANIFEST = JIRA_PLUGIN.manifest;
