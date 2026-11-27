import { listLinearCreationPlaces } from './creationPlaces.js';
/** Finite Account HTTP operations; shared by declarations and portable activation. */
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { PluginSubjectKindListInputV1Schema, PluginSubjectKindListResultV1Schema, type PluginSubjectProjectionV1 } from '@happier-dev/plugin-sdk/automations';
import { TriageSourcesContributionProtocolV1, TriageSourceConnectedAccountInputsV1 } from '@happier-dev/triage-protocol/v1';
import { listTriageIssueSubjectPageV1 } from '@happier-dev/triage-sources/runtime';
import { LINEAR_PURPOSE, LINEAR_ACTIONS, LINEAR_CREATE_FIELDS, LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LinearDetailInputSchema, LinearDetailResultSchema, LinearCommentInputSchema } from './contracts.js';
import { listLinearInstances, listLinearScopeUnits, scanLinearSource, getLinearEntry, readLinearDetail } from './source.js';
import { createLinearIssue, editLinearIssue, transitionLinearIssue, commentLinearIssue } from './mutations.js';
const ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'linear-account-runtime', exportName: 'activate' } } as const;
const sources = TriageSourcesContributionProtocolV1;
const hostAccess = [LINEAR_PURPOSE, 'linear-graphql'];
const bindings = [{ path: 'instance.binding.account', purpose: LINEAR_PURPOSE }];
const issueSubject = { kind: 'plugin', subjectKindId: 'issue', identityField: 'localRef' } satisfies PluginSubjectProjectionV1;
const linearCreateFieldTitles = {
    title: 'Title',
    body: 'Description',
    assigneeIds: 'Assignees',
    labelIds: 'Labels',
    scopeId: 'Team',
    projectId: 'Project',
    priority: 'Priority',
    dueDate: 'Due date',
    estimate: 'Estimate',
    parent: 'Parent',
} satisfies Record<(typeof LINEAR_CREATE_FIELDS)[number], string>;
export const LINEAR_ACCOUNT_ACTIONS = {
    [LINEAR_ACTIONS.listIssueSubjects]: {
        execution: ACCOUNT_EXECUTION, title: 'List Linear issue subjects', surfaces: ['plugin', 'ui'],
        readOnly: true, dangerLevel: 'safe', hostAccess,
        inputSchema: PluginSubjectKindListInputV1Schema.jsonSchema, resultSchema: PluginSubjectKindListResultV1Schema.jsonSchema,
        run: (raw: unknown, context: PluginAccountActionContext) => listTriageIssueSubjectPageV1(raw, context, {
            source: { pluginId: LINEAR_PLUGIN_ID, localId: LINEAR_SOURCE_ID }, scan: scanLinearSource,
        }),
    },
    [LINEAR_ACTIONS.listCreationPlaces]: {
        execution: ACCOUNT_EXECUTION, title: 'List Linear task creation places', placementBindings: [],
        surfaces: sources.operations.listCreationPlaces.declaration.surfaces, dangerLevel: 'safe',
        inputSchema: TriageSourceConnectedAccountInputsV1.listCreationPlaces.jsonSchema,
        resultSchema: sources.operations.listCreationPlaces.declaration.resultSchema.jsonSchema,
        hostAccess: hostAccess, connectedAccountPurposeBindings: bindings, run: listLinearCreationPlaces,
    },
    [LINEAR_ACTIONS.listInstances]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Discover Linear workspaces', description: 'List the workspace for each connected Linear account.', placementBindings: [],
        surfaces: sources.operations.listInstances.declaration.surfaces, dangerLevel: 'safe',
        inputSchema: TriageSourceConnectedAccountInputsV1.listInstances.jsonSchema,
        resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
        hostAccess, run: listLinearInstances,
    },
    [LINEAR_ACTIONS.listScopeUnits]: {
        execution: ACCOUNT_EXECUTION,
        title: 'List Linear teams', description: 'Search teams in this Linear workspace.', placementBindings: [],
        surfaces: sources.operations.listScopeUnits.declaration.surfaces, dangerLevel: 'safe',
        inputSchema: TriageSourceConnectedAccountInputsV1.listScopeUnits.jsonSchema,
        resultSchema: sources.operations.listScopeUnits.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: [{ path: 'draft.binding.account', purpose: LINEAR_PURPOSE }], run: listLinearScopeUnits,
    },
    [LINEAR_ACTIONS.scan]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read Linear team issues', description: 'Read a page of live Linear issues.', placementBindings: [],
        surfaces: sources.operations.scan.declaration.surfaces, dangerLevel: 'safe',
        inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
        resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: scanLinearSource,
    },
    [LINEAR_ACTIONS.get]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read a Linear issue', description: 'Read the current issue through its configured workspace and team selection.', placementBindings: [],
        surfaces: sources.operations.get.declaration.surfaces, dangerLevel: 'safe',
        inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
        resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: getLinearEntry,
    },
    [LINEAR_ACTIONS.detail]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Read Linear issue details', description: 'Read the description, labels, relations, comments or workflow states.', placementBindings: [],
        surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe',
        inputSchema: LinearDetailInputSchema.jsonSchema, resultSchema: LinearDetailResultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: readLinearDetail,
    },
    [LINEAR_ACTIONS.create]: {
        execution: ACCOUNT_EXECUTION,
        title: 'Create a Linear issue', description: 'Create one issue in an included Linear team.', placementBindings: [],
        surfaces: sources.operations.create.declaration.surfaces, dangerLevel: 'writesRemote',
        confirmation: {
          title: 'Create this Linear issue?',
          confirmLabel: 'Create issue',
          inputFields: [
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'kindId', title: 'Type' },
            ...LINEAR_CREATE_FIELDS.map(field => ({ path: `fields.${field}`, title: linearCreateFieldTitles[field] })),
          ],
        },
        inputSchema: TriageSourceConnectedAccountInputsV1.create.jsonSchema,
        resultSchema: sources.operations.create.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: createLinearIssue,
    },
    [LINEAR_ACTIONS.edit]: {
        approvalScope: issueSubject,
        execution: ACCOUNT_EXECUTION,
        title: 'Edit a Linear issue', description: 'Change supported fields on the live Linear issue.', placementBindings: [],
        surfaces: sources.operations.edit.declaration.surfaces, dangerLevel: 'writesRemote',
        confirmation: {
          title: 'Edit this Linear issue?',
          confirmLabel: 'Save changes',
          inputFields: [
            { path: 'lastKnownLocator.displayPath', title: 'Issue' },
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'localRef.entryId', title: 'Item' },
            { path: 'fields.title', title: 'Title' },
            { path: 'fields.body', title: 'Description' },
            { path: 'fields.assigneeIds', title: 'Assignees' },
            { path: 'fields.labelIds', title: 'Labels' },
            { path: 'fields.projectId', title: 'Project' },
            { path: 'fields.priority', title: 'Priority' },
            { path: 'fields.dueDate', title: 'Due date' },
            { path: 'fields.estimate', title: 'Estimate' },
            { path: 'fields.parent', title: 'Parent' },
          ],
        },
        inputSchema: TriageSourceConnectedAccountInputsV1.edit.jsonSchema,
        resultSchema: sources.operations.edit.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: editLinearIssue,
    },
    [LINEAR_ACTIONS.transition]: {
        approvalScope: issueSubject,
        execution: ACCOUNT_EXECUTION,
        title: 'Change a Linear issue state', description: 'Move an issue to an available state in its native team workflow.', placementBindings: [],
        surfaces: sources.operations.transition.declaration.surfaces, dangerLevel: 'writesRemote',
        confirmation: {
          title: 'Change this Linear issue’s state?',
          confirmLabel: 'Change state',
          inputFields: [
            { path: 'lastKnownLocator.displayPath', title: 'Issue' },
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'localRef.entryId', title: 'Item' },
            { path: 'transitionId', title: 'New status' },
            { path: 'fieldValues', title: 'Transition fields' },
          ],
        },
        inputSchema: TriageSourceConnectedAccountInputsV1.transition.jsonSchema,
        resultSchema: sources.operations.transition.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: transitionLinearIssue,
    },
    [LINEAR_ACTIONS.comment]: {
        approvalScope: issueSubject,
        execution: ACCOUNT_EXECUTION,
        title: 'Comment on a Linear issue', description: 'Publish one comment on this issue in Linear.', placementBindings: [],
        surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote',
        confirmation: {
          title: 'Publish this comment in Linear?',
          confirmLabel: 'Publish comment',
          inputFields: [
            { path: 'lastKnownLocator.displayPath', title: 'Issue' },
            { path: 'instance.locator.displayLabel', title: 'Source' },
            { path: 'localRef.entryId', title: 'Item' },
            { path: 'body', title: 'Comment' },
          ],
        },
        inputSchema: LinearCommentInputSchema.jsonSchema,
        resultSchema: sources.operations.edit.declaration.resultSchema.jsonSchema,
        hostAccess, connectedAccountPurposeBindings: bindings, run: commentLinearIssue,
    }
} as const;
