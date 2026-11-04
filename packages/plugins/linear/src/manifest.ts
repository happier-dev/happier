import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  TriageSourcesContributionProtocolV1, TriageSourceConnectedAccountInputsV1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import { withTriageSourceSettingsTranslationsV1 } from '@happier-dev/triage-sources/translations';
import { LINEAR_UI_TRANSLATIONS } from './ui/translations.js';
import { linearConnectedAccountRuntime } from './account.js';
import {
  LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LINEAR_SERVICE_ID, LINEAR_PURPOSE, LINEAR_ORIGIN, LINEAR_ACTIONS,
  LINEAR_DETAIL_SECTIONS, LINEAR_DETAIL_TITLES, LINEAR_PERSONAL_KEY,
  LinearDetailInputSchema, LinearDetailResultSchema, LinearCommentInputSchema, LINEAR_CREATE_FIELDS, LINEAR_EDIT_FIELDS,
} from './contracts.js';
import { listLinearInstances, listLinearScopeUnits, scanLinearSource, getLinearEntry, readLinearDetail } from './source.js';
import { createLinearIssue, editLinearIssue, transitionLinearIssue, commentLinearIssue } from './mutations.js';

const sources = TriageSourcesContributionProtocolV1;
const hostAccess = [LINEAR_PURPOSE, 'linear-graphql'];
const bindings = [{ path: 'instance.binding.account', purpose: LINEAR_PURPOSE }];

export const LINEAR_PLUGIN = definePlugin({
  id: LINEAR_PLUGIN_ID, version: '0.0.0', displayName: 'Linear',
  description: 'Live Linear team issues in PRs, Issues & Tasks.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: { required: [
    { id: 'linear-graphql', capability: 'network', reason: 'Read and edit Linear issues in the included teams.',
      scope: { targets: [{ kind: 'fixedOrigin', origin: LINEAR_ORIGIN }], methods: ['POST'] } },
    { id: LINEAR_PURPOSE, capability: 'connectedAccounts', reason: 'Use the exact selected Linear account.',
      scope: { serviceRefs: [LINEAR_SERVICE_ID], operations: ['use'], materializationKinds: ['httpHeaders'] } },
  ], optional: [] },
  ui: {
    views: [],
    renderers: [
      { id: 'linear-detail', kind: 'reactNative', artifact: 'linear-detail-native', requiredHostMethods: ['executeAction'] },
      { id: 'linear-detail-fallback', kind: 'declarative', root: { kind: 'text', text: { key: 'plugins.linear.detail.unavailable', fallback: 'Linear issue details are unavailable on this surface.' } } },
      { id: 'linear-sources', kind: 'reactNative', artifact: 'linear-sources-native', requiredHostMethods: ['executeAction', 'openConnectedAccounts'] },
    ],
    settingsGroups: [{ id: 'linear', title: 'Linear', icon: 'settings', defaultRank: 40 }],
    settingsPages: [{ id: 'triage-sources', group: { kind: 'plugin', localId: 'linear' }, title: 'PRs, Issues & Tasks',
      subtitle: 'Choose which Linear teams appear in PRs, Issues & Tasks.', icon: 'settings', renderer: 'linear-sources', defaultRank: 10 }],
    translations: withTriageSourceSettingsTranslationsV1(LINEAR_UI_TRANSLATIONS),
  },
  actions: {
    [LINEAR_ACTIONS.listInstances]: {
      title: 'Discover Linear workspaces', description: 'List the workspace for each connected Linear account.', placementBindings: [],
      surfaces: sources.operations.listInstances.declaration.surfaces, dangerLevel: 'safe',
      inputSchema: TriageSourceConnectedAccountInputsV1.listInstances.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess, run: listLinearInstances,
    },
    [LINEAR_ACTIONS.listScopeUnits]: {
      title: 'List Linear teams', description: 'Search teams in this Linear workspace.', placementBindings: [],
      surfaces: sources.operations.listScopeUnits.declaration.surfaces, dangerLevel: 'safe',
      inputSchema: TriageSourceConnectedAccountInputsV1.listScopeUnits.jsonSchema,
      resultSchema: sources.operations.listScopeUnits.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: [{ path: 'draft.binding.account', purpose: LINEAR_PURPOSE }], run: listLinearScopeUnits,
    },
    [LINEAR_ACTIONS.scan]: {
      title: 'Read Linear team issues', description: 'Read a page of live Linear issues.', placementBindings: [],
      surfaces: sources.operations.scan.declaration.surfaces, dangerLevel: 'safe',
      inputSchema: TriageSourceConnectedAccountInputsV1.scan.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: scanLinearSource,
    },
    [LINEAR_ACTIONS.get]: {
      title: 'Read a Linear issue', description: 'Read the current issue through its configured workspace and team selection.', placementBindings: [],
      surfaces: sources.operations.get.declaration.surfaces, dangerLevel: 'safe',
      inputSchema: TriageSourceConnectedAccountInputsV1.get.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: getLinearEntry,
    },
    [LINEAR_ACTIONS.detail]: {
      title: 'Read Linear issue details', description: 'Read the description, labels, relations, comments or workflow states.', placementBindings: [],
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe',
      inputSchema: LinearDetailInputSchema.jsonSchema, resultSchema: LinearDetailResultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: readLinearDetail,
    },
    [LINEAR_ACTIONS.create]: {
      title: 'Create a Linear issue', description: 'Create one issue in an included Linear team.', placementBindings: [],
      surfaces: sources.operations.create.declaration.surfaces, dangerLevel: 'writesRemote',
      confirmation: { title: 'Create this Linear issue?', confirmLabel: 'Create issue' },
      inputSchema: TriageSourceConnectedAccountInputsV1.create.jsonSchema,
      resultSchema: sources.operations.create.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: createLinearIssue,
    },
    [LINEAR_ACTIONS.edit]: {
      title: 'Edit a Linear issue', description: 'Change supported fields on the live Linear issue.', placementBindings: [],
      surfaces: sources.operations.edit.declaration.surfaces, dangerLevel: 'writesRemote',
      confirmation: { title: 'Edit this Linear issue?', confirmLabel: 'Save changes' },
      inputSchema: TriageSourceConnectedAccountInputsV1.edit.jsonSchema,
      resultSchema: sources.operations.edit.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: editLinearIssue,
    },
    [LINEAR_ACTIONS.transition]: {
      title: 'Change a Linear issue state', description: 'Move an issue to an available state in its native team workflow.', placementBindings: [],
      surfaces: sources.operations.transition.declaration.surfaces, dangerLevel: 'writesRemote',
      confirmation: { title: 'Change this Linear issue’s state?', confirmLabel: 'Change state' },
      inputSchema: TriageSourceConnectedAccountInputsV1.transition.jsonSchema,
      resultSchema: sources.operations.transition.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: transitionLinearIssue,
    },
    [LINEAR_ACTIONS.comment]: {
      title: 'Comment on a Linear issue', description: 'Publish one comment on this issue in Linear.', placementBindings: [],
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Publish this comment in Linear?', confirmLabel: 'Publish comment' },
      inputSchema: LinearCommentInputSchema.jsonSchema,
      resultSchema: sources.operations.edit.declaration.resultSchema.jsonSchema,
      hostAccess, connectedAccountPurposeBindings: bindings, run: commentLinearIssue,
    },
  },
  connectedAccountDescriptors: {
    [LINEAR_SERVICE_ID]: {
      declaration: {
        title: 'Linear account', description: 'Personal API key for the Linear teams you can access.',
        authentication: { defaultModeId: LINEAR_PERSONAL_KEY, modes: [{
          id: LINEAR_PERSONAL_KEY, kind: 'manual', title: 'Personal API key',
          directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, outcomeReconciliation: 'none',
          fields: [{ id: LINEAR_PERSONAL_KEY, title: 'Linear personal API key',
            description: 'A key with Read access and the issue/comment write permissions you want to use.',
            schema: { type: 'string', minLength: 1 }, secret: true }],
      setup: {
            url: 'https://linear.app',
            checklist: ['In Linear, open Settings > Account > Security & Access and create a personal API key.', 'Give it Read access, the teams you need, and the write permissions for the issue and comment actions you want to use.', 'Copy the key and paste it here.'],
            createKeyTitle: 'Open Linear',
          },
        }] },
      }, runtime: linearConnectedAccountRuntime,
    },
  },
  contributesTo: { [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: { [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
    [LINEAR_SOURCE_ID]: sources.contribute({
      descriptor: { v: 1, purpose: LINEAR_PURPOSE, displayName: 'Linear', settingsPageId: 'triage-sources',
        scopeUnit: { singularLabel: 'Team', pluralLabel: 'Teams' },
        kinds: [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue', pluralDisplayName: 'Issues', task: true,
          taskCapabilities: { completedScan: true, createFields: LINEAR_CREATE_FIELDS, editFields: LINEAR_EDIT_FIELDS },
          detailTabs: [
            { kind: 'shared', id: 'overview' }, { kind: 'shared', id: 'activity' },
            ...LINEAR_DETAIL_SECTIONS.filter((section) => section !== 'overview' && section !== 'comments').map((section) => ({
              kind: 'source' as const, id: section, title: LINEAR_DETAIL_TITLES[section], titleKey: `plugins.linear.detail.${section}`,
            })),
          ],
        }] },
      operations: {
        listInstances: sources.operations.listInstances.bind(LINEAR_ACTIONS.listInstances),
        listScopeUnits: sources.operations.listScopeUnits.bind(LINEAR_ACTIONS.listScopeUnits),
        scan: sources.operations.scan.bind(LINEAR_ACTIONS.scan), get: sources.operations.get.bind(LINEAR_ACTIONS.get),
        create: sources.operations.create.bind(LINEAR_ACTIONS.create), edit: sources.operations.edit.bind(LINEAR_ACTIONS.edit),
        transition: sources.operations.transition.bind(LINEAR_ACTIONS.transition),
      },
      surfaces: { detail: { renderer: 'linear-detail', fallbackRenderers: ['linear-detail-fallback'] } },
    }),
  } } },
});
export const PLUGIN_MANIFEST = LINEAR_PLUGIN.manifest;
