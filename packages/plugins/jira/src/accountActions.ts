import { listJiraCreationPlaces } from './source/creationPlaces.js';
/** Finite Account HTTP operations; shared by declarations and portable activation. */
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginSubjectKindListInputV1Schema, PluginSubjectKindListResultV1Schema, type PluginSubjectProjectionV1 } from '@happier-dev/plugin-sdk/automations';
import { TriageSourceConnectedAccountInputsV1, TriageSourcesContributionProtocolV1, TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { listTriageIssueSubjectPageV1 } from '@happier-dev/triage-sources/runtime';
import { JIRA_ACCOUNT_PURPOSE, JIRA_ACTIONS, JIRA_PLUGIN_ID, JIRA_SOURCE_ID } from './contracts.js';
import { getJiraEntry, listJiraInstances, listJiraScopeUnits, scanJiraSource } from './source/operations.js';
import { JIRA_TASK_FIELDS } from './source/metadata.js';
import { JiraDetailResultSchema, readJiraDetail } from './source/detail.js';
import { JiraCommentInputSchema, createJiraIssue, editJiraIssue, transitionJiraIssue, commentJiraIssue } from './source/writes.js';
import { listJiraIssueTypes } from './source/configuration.js';
import { JiraIssueTypesInputSchema, JiraIssueTypesResultSchema } from './source/configurationContract.js';
const ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'jira-account-runtime', exportName: 'activate' } } as const;
const sources = TriageSourcesContributionProtocolV1;
const access = [JIRA_ACCOUNT_PURPOSE, 'jira-api'];
const bindings = [{ path: 'instance.binding.account', purpose: JIRA_ACCOUNT_PURPOSE }];
const issueSubject = { kind: 'plugin', subjectKindId: 'issue', identityField: 'localRef' } satisfies PluginSubjectProjectionV1;
const jiraCreateFieldTitles = {
    title: 'Title',
    body: 'Description',
    assigneeIds: 'Assignees',
    labelIds: 'Labels',
    priority: 'Priority',
    dueDate: 'Due date',
    parent: 'Parent',
} satisfies Record<(typeof JIRA_TASK_FIELDS)[number], string>;
export const JIRA_ACCOUNT_ACTIONS = {
    [JIRA_ACTIONS.listIssueSubjects]: {
        execution: ACCOUNT_EXECUTION, title: 'List Jira issue subjects', surfaces: ['plugin', 'ui'],
        readOnly: true, dangerLevel: 'safe', hostAccess: access,
        inputSchema: PluginSubjectKindListInputV1Schema.jsonSchema, resultSchema: PluginSubjectKindListResultV1Schema.jsonSchema,
        run: (raw: unknown, context: PluginAccountActionContext) => listTriageIssueSubjectPageV1(raw, context, {
            source: { pluginId: JIRA_PLUGIN_ID, localId: JIRA_SOURCE_ID }, scan: scanJiraSource,
        }),
    },
    [JIRA_ACTIONS.listCreationPlaces]: {
        execution: ACCOUNT_EXECUTION, title: 'List Jira task creation places', placementBindings: [],
        surfaces: sources.operations.listCreationPlaces.declaration.surfaces, dangerLevel: 'safe',
        inputSchema: TriageSourceConnectedAccountInputsV1.listCreationPlaces.jsonSchema,
        resultSchema: sources.operations.listCreationPlaces.declaration.resultSchema.jsonSchema,
        hostAccess: access, connectedAccountPurposeBindings: bindings, run: listJiraCreationPlaces,
    },
    [JIRA_ACTIONS.issueTypes]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read Jira issue types', surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
        placementBindings: [], dangerLevel: 'safe', hostAccess: access,
        connectedAccountPurposeBindings: [{ path: 'binding.account', purpose: JIRA_ACCOUNT_PURPOSE }],
        inputSchema: JiraIssueTypesInputSchema.jsonSchema, resultSchema: JiraIssueTypesResultSchema.jsonSchema,
        run: listJiraIssueTypes,
    },
    [JIRA_ACTIONS.create]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Create a Jira issue', surfaces: sources.operations.create.declaration.surfaces,
        confirmation: {
          title: 'Create Jira issue',
          body: 'Create this issue on the selected Jira Cloud site?',
          inputFields: [
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'kindId', title: 'Type' },
            ...JIRA_TASK_FIELDS.map(field => ({ path: `fields.${field}`, title: jiraCreateFieldTitles[field] })),
            { path: 'placeId', title: 'Place' },
          ],
        },
        dangerLevel: 'writesRemote', hostAccess: access, connectedAccountPurposeBindings: bindings,
        inputSchema: TriageSourceConnectedAccountInputsV1.create.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: createJiraIssue,
    },
    [JIRA_ACTIONS.edit]: {
        approvalScope: issueSubject,
        execution: ACCOUNT_EXECUTION,
        title: 'Edit a Jira issue', surfaces: sources.operations.edit.declaration.surfaces,
        confirmation: {
          title: 'Edit Jira issue',
          body: 'Apply these changes to the selected Jira issue?',
          inputFields: [
            { path: 'lastKnownLocator.displayPath', title: 'Issue' },
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'localRef.entryId', title: 'Item' },
            { path: 'fields.title', title: 'Title' },
            { path: 'fields.body', title: 'Description' },
            { path: 'fields.assigneeIds', title: 'Assignees' },
            { path: 'fields.labelIds', title: 'Labels' },
            { path: 'fields.priority', title: 'Priority' },
            { path: 'fields.dueDate', title: 'Due date' },
            { path: 'fields.parent', title: 'Parent' },
          ],
        },
        dangerLevel: 'writesRemote', hostAccess: access, connectedAccountPurposeBindings: bindings,
        inputSchema: TriageSourceConnectedAccountInputsV1.edit.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: editJiraIssue,
    },
    [JIRA_ACTIONS.transition]: {
        approvalScope: issueSubject,
        execution: ACCOUNT_EXECUTION,
        title: 'Transition a Jira issue', surfaces: sources.operations.transition.declaration.surfaces,
        confirmation: {
          title: 'Transition Jira issue',
          body: 'Apply this native workflow transition to the selected Jira issue?',
          inputFields: [
            { path: 'lastKnownLocator.displayPath', title: 'Issue' },
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'localRef.entryId', title: 'Item' },
            { path: 'transitionId', title: 'New status' },
            { path: 'fieldValues', title: 'Transition fields' },
          ],
        },
        dangerLevel: 'writesRemote', hostAccess: access, connectedAccountPurposeBindings: bindings,
        inputSchema: TriageSourceConnectedAccountInputsV1.transition.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: transitionJiraIssue,
    },
    [JIRA_ACTIONS.comment]: {
        approvalScope: { ...issueSubject, identityField: 'entry.localRef' },
        execution: ACCOUNT_EXECUTION,
        title: 'Comment on a Jira issue', surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
        confirmation: {
          title: 'Comment on Jira issue',
          body: 'Publish this comment on the selected Jira issue?',
          inputFields: [
            { path: 'entry.lastKnownLocator.displayPath', title: 'Issue' },
            { path: 'entry.instance.locator.displayLabel', title: 'Source' },
            { path: 'entry.localRef.entryId', title: 'Item' },
            { path: 'body', title: 'Comment' },
          ],
        },
        dangerLevel: 'writesRemote', hostAccess: access,
        connectedAccountPurposeBindings: [{ path: 'entry.instance.binding.account', purpose: JIRA_ACCOUNT_PURPOSE }],
        inputSchema: JiraCommentInputSchema.jsonSchema,
        resultSchema: TriageTaskWriteResultV1Schema.jsonSchema, run: commentJiraIssue,
    },
    [JIRA_ACTIONS.listInstances]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Discover Jira sites', surfaces: sources.operations.listInstances.declaration.surfaces,
        placementBindings: [], dangerLevel: 'safe', hostAccess: access,
        inputSchema: TriageSourceConnectedAccountInputsV1.listInstances.jsonSchema,
        resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema, run: listJiraInstances,
    },
    [JIRA_ACTIONS.scan]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Scan Jira issues', surfaces: sources.operations.scan.declaration.surfaces,
        dangerLevel: 'safe', hostAccess: access, connectedAccountPurposeBindings: bindings,
        inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
        resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema, run: scanJiraSource,
    },
    [JIRA_ACTIONS.listScopeUnits]: {
        execution: ACCOUNT_EXECUTION,
        title: 'List Jira projects', surfaces: sources.operations.listScopeUnits.declaration.surfaces,
        placementBindings: [], dangerLevel: 'safe', hostAccess: access,
        connectedAccountPurposeBindings: [{ path: 'draft.binding.account', purpose: JIRA_ACCOUNT_PURPOSE }],
        inputSchema: TriageSourceConnectedAccountInputsV1.listScopeUnits.jsonSchema,
        resultSchema: sources.operations.listScopeUnits.declaration.resultSchema.jsonSchema, run: listJiraScopeUnits,
    },
    [JIRA_ACTIONS.get]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read a Jira issue', surfaces: sources.operations.get.declaration.surfaces,
        placementBindings: [], dangerLevel: 'safe', hostAccess: access, connectedAccountPurposeBindings: bindings,
        inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
        resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema, run: getJiraEntry,
    },
    [JIRA_ACTIONS.detail]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read Jira issue details', surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
        placementBindings: [], dangerLevel: 'safe', hostAccess: access, connectedAccountPurposeBindings: bindings,
        inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
        resultSchema: JiraDetailResultSchema.jsonSchema, run: readJiraDetail,
    }
} as const;
