import { LINEAR_ACCOUNT_ACTIONS } from './accountActions.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { TriageSourcesContributionProtocolV1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { linearConnectedAccountRuntime, linearPortableAccountRuntime } from './account.js';
import { LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LINEAR_SORT_COLUMNS, LINEAR_SERVICE_ID, LINEAR_PURPOSE, LINEAR_ORIGIN, LINEAR_ACTIONS, LINEAR_DETAIL_SECTIONS, LINEAR_DETAIL_TITLES, LINEAR_PERSONAL_KEY, LINEAR_CREATE_FIELDS, LINEAR_EDIT_FIELDS } from './contracts.js';

const sources = TriageSourcesContributionProtocolV1;

export const LINEAR_PLUGIN = definePlugin({
  id: LINEAR_PLUGIN_ID, version: '0.0.0', displayName: 'Linear',
  description: 'Live Linear team issues in PRs, Issues & Tasks.',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
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
  actions: {
        ...LINEAR_ACCOUNT_ACTIONS,
    },
  connectedAccountDescriptors: {
    [LINEAR_SERVICE_ID]: {
      declaration: {
        title: 'Linear account', description: 'Personal API key for the Linear teams you can access.',
        authentication: { account: { artifactId: 'linear-account-runtime', exportName: 'activate' }, defaultModeId: LINEAR_PERSONAL_KEY, modes: [{
          id: LINEAR_PERSONAL_KEY, kind: 'manual', title: 'Personal API key', apiKey: true,
          setup: {
            url: 'https://linear.app',
            checklist: ['In [Linear], open Settings > Account > Security & Access and create a personal API key.', 'Give it Read access, the teams you need, and the write permissions for the issue and comment actions you want to use.', 'Copy the key and paste it here.'],
            createKeyTitle: 'Open Linear',
          },
          credentialOrigin: 'authentication',
          directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }, outcomeReconciliation: 'none',
          fields: [{ id: LINEAR_PERSONAL_KEY, title: 'Linear personal API key',
            description: 'A key with Read access and the issue/comment write permissions you want to use.',
            schema: { type: 'string', minLength: 1 }, secret: true }],
        }] },
      }, runtime: linearConnectedAccountRuntime, accountRuntime: linearPortableAccountRuntime,
    },
  },
  contributesTo: { [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: { [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
    [LINEAR_SOURCE_ID]: sources.contribute({
      descriptor: { v: 1, purpose: LINEAR_PURPOSE, sortFields: Array.from(LINEAR_SORT_COLUMNS.keys()), displayName: 'Linear', settingsPageId: 'triage-sources',
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
export const PLUGIN_MANIFEST = LINEAR_PLUGIN.manifest;
