import { JIRA_ACCOUNT_ACTIONS } from './accountActions.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageSourceEntryLocalRefV1Schema, TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';

import { JIRA_ACCOUNT_PURPOSE, JIRA_ACTIONS, JIRA_PLUGIN_ID, JIRA_SOURCE_ID, JIRA_SORT_COLUMNS } from './contracts.js';
import { jiraAccountRuntime, jiraPortableAccountRuntime } from './connect.js';

import { JIRA_TASK_FIELDS } from './source/metadata.js';

const sources = TriageSourcesContributionProtocolV1;

export const JIRA_PLUGIN = definePlugin({
    id: JIRA_PLUGIN_ID, version: '0.0.0', displayName: 'Jira',
    description: 'Jira Cloud issues, native workflows and linked work in PRs, Issues & Tasks.',
    entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
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
        translations: [
          { locale: "en", resourceId: "i18n-en" },
          { locale: "de", resourceId: "i18n-de" },
          { locale: "ru", resourceId: "i18n-ru" },
          { locale: "pl", resourceId: "i18n-pl" },
          { locale: "es", resourceId: "i18n-es" },
          { locale: "fr", resourceId: "i18n-fr" },
          { locale: "it", resourceId: "i18n-it" },
          { locale: "pt", resourceId: "i18n-pt" },
          { locale: "ca", resourceId: "i18n-ca" },
          { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
          { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
          { locale: "ja", resourceId: "i18n-ja" },
        ],
    },
    connectedAccountDescriptors: {
        [JIRA_ACCOUNT_PURPOSE]: {
            declaration: {
                title: 'Jira Cloud account', description: 'A Jira Cloud site and a personal Atlassian API token.',
                authentication: { account: { artifactId: 'jira-account-runtime', exportName: 'activate' }, defaultModeId: 'api-token', modes: [{
                    id: 'api-token', kind: 'manual', title: 'Personal API token (without scopes)', outcomeReconciliation: 'none',
                    setup: {
                        url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
                        checklist: ['Create an API token without scopes in your [Atlassian account]; this connection uses your Jira site URL.', 'Copy the token and enter the email address of the Atlassian account that created it.', 'Enter the Jira Cloud site that account can access.'],
                        createKeyTitle: 'Open Atlassian API tokens',
                    },
                    credentialOrigin: 'authentication',
                    directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
                    fields: [
                        { id: 'email', title: 'Atlassian account email', secret: false, schema: { type: 'string', minLength: 1 } },
                        { id: 'token', title: 'API token', secret: true, schema: { type: 'string', minLength: 1 } },
                    ],
                    configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{
                        id: 'site', title: 'Jira Cloud site', required: true, secret: false,
                        semantic: 'connectedAccountOrigin', schema: { type: 'string', minLength: 1 },
                    }] },
                }] },
            }, runtime: jiraAccountRuntime, accountRuntime: jiraPortableAccountRuntime,
        },
    },
    actions: {
        ...JIRA_ACCOUNT_ACTIONS,
    },
    subjectKinds: {
        issue: { label: 'Jira issue', identitySchema: TriageSourceEntryLocalRefV1Schema.jsonSchema, listAction: JIRA_ACTIONS.listIssueSubjects },
    },
    contributesTo: { [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: { [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [JIRA_SOURCE_ID]: sources.contribute({
            descriptor: { v: 1, purpose: JIRA_ACCOUNT_PURPOSE, sortFields: Array.from(JIRA_SORT_COLUMNS.keys()), displayName: 'Jira', settingsPageId: 'jira-sources',
                scopeUnit: { singularLabel: 'Project', pluralLabel: 'Projects' },
                kinds: [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue', pluralDisplayName: 'Issues',
                    task: true, taskCapabilities: { completedScan: true, createFields: JIRA_TASK_FIELDS, editFields: JIRA_TASK_FIELDS },
                    detailTabs: [{ kind: 'shared', id: 'overview' }] }] },
            operations: {
                listCreationPlaces: sources.operations.listCreationPlaces.bind(JIRA_ACTIONS.listCreationPlaces),
                listInstances: sources.operations.listInstances.bind(JIRA_ACTIONS.listInstances),
                listScopeUnits: sources.operations.listScopeUnits.bind(JIRA_ACTIONS.listScopeUnits),
                scan: sources.operations.scan.bind(JIRA_ACTIONS.scan), get: sources.operations.get.bind(JIRA_ACTIONS.get),
                create: sources.operations.create.bind(JIRA_ACTIONS.create), edit: sources.operations.edit.bind(JIRA_ACTIONS.edit),
                transition: sources.operations.transition.bind(JIRA_ACTIONS.transition) },
            surfaces: { detail: { renderer: 'jira-detail', fallbackRenderers: ['jira-detail-fallback'] } },
        }),
    } } },
    resources: {
      "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
      "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
      "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
      "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
      "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
      "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
      "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
      "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
      "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
      "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
      "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
      "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
    },

});
export const PLUGIN_MANIFEST = JIRA_PLUGIN.manifest;
