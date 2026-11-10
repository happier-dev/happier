import { bitbucketPortableAuthentication } from './auth/connectedAccountRuntime.js';
import { BITBUCKET_ACCOUNT_ACTIONS, BITBUCKET_NETWORK_HOST_ACCESS_ID, sources, READ_HOST_ACCESS, INSTANCE_ACCOUNT_BINDINGS } from './accountActions.js';
export { BITBUCKET_NETWORK_HOST_ACCESS_ID } from './accountActions.js';
/**
 * The sole Bitbucket plugin manifest and registration spine.
 *
 * It is authored through `definePlugin` and, for the Triage source, through the protocol's own
 * `sources.contribute(...)`. That is not a style choice. The raw contribution literal this file
 * used to build could omit the required `detail` surface and still typecheck: the manifest shipped,
 * host admission then rejected the whole contribution with `required_surface_missing`, and the
 * plugin contributed nothing at all. `contribute` types the required surface roles, so the same
 * omission is now a compile error in this file rather than a silent runtime non-contribution.
 *
 * Every Action's input and result schema is published by the Triage protocol, with the
 * shared account-only input specialization rather than a local restatement, so drift in the shared
 * contract fails conformance instead of admitting a source that speaks a private dialect.
 */

import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';



import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageSourceConnectedAccountInputsV1, TRIAGE_REVIEW_WORKSPACE_OPERATION_V1 } from '@happier-dev/triage-protocol/v1';

import { bitbucketConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  BITBUCKET_PLUGIN_ID,
  BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID,
  BITBUCKET_TRIAGE_CONTRIBUTION_ID,
} from './bitbucketContracts.js';
import { bitbucketApiAdapter } from './operations/bitbucketApiAdapter.js';
import {
  BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
  BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
  BITBUCKET_TRIAGE_DESCRIPTOR,
  BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
  BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
  BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID,
  BITBUCKET_TRIAGE_SETTINGS_GROUP_ID,
  BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
  BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
} from './triage/source/descriptor.js';
import { BITBUCKET_TRIAGE_ACTION_IDS, prepareBitbucketReviewWorkspaceAction, verifyBitbucketReviewWorkspaceAction } from './triage/source/actions.js';





/** The network host-access request that owns this plugin's Bitbucket origins. */


export {
  BITBUCKET_TRIAGE_CONTRIBUTION_ID,
  BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
  BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
};



/**
 * Every source Action that reaches the provider uses the exact account, so both grants are declared
 * on all four roles.
 *
 * `scan`, `get`, and selected-PR preparation additionally declare the exact account path their
 * configured instance carries, so the host cross-checks at declaration time that the credential
 * each one asks for is the one this purpose was granted. `scan`'s published input is a two-arm
 * union — the deliberate shape that makes a mid-scan limit change unrepresentable — and the
 * canonical Action validator resolves a bound path through every arm, requiring the same exact
 * qualified credential ref in each; a path either arm narrowed differently, or omitted, is refused.
 * `listInstances` carries no account at all, because producing account references is what it does,
 * so it has no path to bind.
 */



export const BITBUCKET_PLUGIN = definePlugin({
  id: BITBUCKET_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Bitbucket SCM hosting provider',
  description: 'Detects Bitbucket Cloud remotes, provides repository operations, and brings its pull requests into PRs & Issues.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: BITBUCKET_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the Bitbucket origin selected from the SCM provider and connected account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://api.bitbucket.org' },
          { kind: 'scmProviderOrigin', provider: 'bitbucket' },
          { kind: 'connectedAccountOrigin', service: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID },
        ],
        // `GET` serves every read and every confirming re-read. `POST` serves merge, decline and
        // resolving a comment thread. `DELETE` serves exactly one Action: Bitbucket documents
        // reopening a comment thread as `DELETE` on the resolve path, so the verb IS the write.
        // The host revalidates origin AND method at dispatch, so an Action whose verb is missing
        // here is rejected before it ever reaches Bitbucket. `PUT` stays absent: no declared
        // Action uses it, and a verb granted for symmetry is authority the user approved for
        // nothing.
        methods: ['GET', 'POST', 'DELETE'],
      },
    }, {
      id: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact selected Bitbucket Cloud account for Bitbucket API requests.',
      scope: {
        serviceRefs: [BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID],
        operations: ['select', 'use'],
        materializationKinds: ['httpHeaders'],
      },
    }],
    optional: [],
  },
  ui: {
    views: [],
    renderers: [{
      id: BITBUCKET_TRIAGE_DETAIL_RENDERER_ID,
      kind: 'reactNative',
      artifact: BITBUCKET_TRIAGE_DETAIL_ARTIFACT_ID,
      // The detail body reads through this plugin's own Actions, so a mount without them would
      // render an empty shell rather than a useful surface.
      requiredHostMethods: ['executeAction'],
    }, {
      id: BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
      kind: 'reactNative',
      artifact: BITBUCKET_TRIAGE_SETTINGS_ARTIFACT_ID,
      // The page's whole purpose is two Action invocations — this source's own
      // discovery read and the target-owned administration write.
      requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
    }],
    settingsGroups: [{
      id: BITBUCKET_TRIAGE_SETTINGS_GROUP_ID,
      title: { key: 'plugins.bitbucket.settings.group', fallback: 'Bitbucket Cloud' },
      icon: 'settings',
      defaultRank: 40,
    }],
    settingsPages: [{
      id: BITBUCKET_TRIAGE_SETTINGS_PAGE_ID,
      group: { kind: 'plugin', localId: BITBUCKET_TRIAGE_SETTINGS_GROUP_ID },
      title: { key: 'plugins.bitbucket.settings.sources', fallback: 'PRs & Issues' },
      subtitle: {
        key: 'plugins.bitbucket.settings.sources.subtitle',
        fallback: 'Choose which Bitbucket Cloud accounts and workspaces appear in PRs & Issues.',
      },
      keywords: ['bitbucket', 'pull requests', 'triage'],
      icon: 'settings',
      defaultRank: 10,
      renderer: BITBUCKET_TRIAGE_SETTINGS_RENDERER_ID,
    }],
    translations: [
      { locale: "en", resourceId: "i18n-en" },
      { locale: "ru", resourceId: "i18n-ru" },
      { locale: "pl", resourceId: "i18n-pl" },
      { locale: "es", resourceId: "i18n-es" },
      { locale: "fr", resourceId: "i18n-fr" },
      { locale: "it", resourceId: "i18n-it" },
      { locale: "pt", resourceId: "i18n-pt" },
      { locale: "de", resourceId: "i18n-de" },
      { locale: "ca", resourceId: "i18n-ca" },
      { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
      { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
      { locale: "ja", resourceId: "i18n-ja" },
    ],
  },
  actions: {
    ...BITBUCKET_ACCOUNT_ACTIONS,
    [BITBUCKET_TRIAGE_ACTION_IDS.prepareReviewWorkspace]: {
      title: 'Prepare a Bitbucket Cloud pull-request review workspace',
      description: 'Reauthorizes and rereads one Bitbucket Cloud pull request before preparing its selected local workspace.',
      surfaces: sources.operations.prepareReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.prepareReviewWorkspace.declaration.dangerLevel,
      operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
      confirmation: { title: 'Prepare Bitbucket review workspace', confirmLabel: 'Prepare workspace' },
      // The person's own press is the consent for the checkout they asked for;
      // agents, MCP and a saved Ask keep the writes-local default.
      confirmationWhen: { presentUserUi: false },
      inputSchema: TriageSourceConnectedAccountInputsV1.prepareReviewWorkspace.jsonSchema,
      // The person's own bound account is the one field; a draft that already names it settles without a form,
      // and placement and the observed PR facts come from their host owners.
      inputHints: { fields: [{ path: 'instance.binding.account', title: 'Bitbucket account', widget: 'select',
        required: true, connectedAccountOptions: true }] },
      resultSchema: sources.operations.prepareReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: prepareBitbucketReviewWorkspaceAction,
    },
    [BITBUCKET_TRIAGE_ACTION_IDS.verifyReviewWorkspace]: {
      title: 'Verify a Bitbucket Cloud pull-request review workspace',
      description: 'Rereads one Bitbucket Cloud pull request and verifies the already prepared local workspace before review starts.',
      surfaces: sources.operations.verifyReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.verifyReviewWorkspace.declaration.dangerLevel,
      operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
      inputSchema: TriageSourceConnectedAccountInputsV1.verifyReviewWorkspace.jsonSchema,
      resultSchema: sources.operations.verifyReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: verifyBitbucketReviewWorkspaceAction,
    }
  },
  scmHostingProviders: {
    [BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID]: {
      declaration: {
        title: 'Bitbucket',
        description: 'Bitbucket Cloud repositories.',
        kind: 'bitbucket',
        capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
        authService: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
      },
      runtime: {
        adapter: {
          routing: bitbucketApiAdapter,
          pullRequests: bitbucketApiAdapter,
          pullRequestCheckout: bitbucketApiAdapter,
          repositoryPublishing: bitbucketApiAdapter,
        },
      },
    },
  },
  connectedAccountDescriptors: {
    [BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID]: {
      declaration: {
        title: 'Bitbucket account',
        description: 'Bitbucket account used for repository and pull-request operations.',
        authentication: {
          account: { artifactId: 'bitbucket-account-runtime', exportName: 'activate' },
          defaultModeId: 'manual',
          modes: [{
            id: 'manual',
            kind: 'manual',
            setup: {
              url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
              checklist: ['Create an API token with scopes in your Atlassian account and select Bitbucket as the app.', 'Grant the repository, pull request, and issue permissions needed for the actions you want to use.', 'Copy the token and enter the email address of the Atlassian account that created it.'],
              createKeyTitle: 'Open Atlassian API tokens',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            outcomeReconciliation: 'none',
            fields: [
              {
                // Bitbucket Cloud API tokens authenticate with the Atlassian account EMAIL and the
                // token as the password. A username, workspace slug or nickname is not a Basic-auth
                // identity substitute, and inviting one here is how a reader ends up with a 401 on
                // every call (sources/SCM.md §5.1).
                id: 'identity',
                title: 'Atlassian account email',
                description: 'The email address of the Atlassian account this API token belongs to.',
                schema: { type: 'string', minLength: 1 },
                secret: false,
              },
              {
                id: 'token',
                title: 'API token',
                // App passwords were disabled on 2026-06-09 and no longer work, so there is
                // nothing to fall back to and nothing to name but an API token.
                description: 'A Bitbucket API token with read:user:bitbucket, read:workspace:bitbucket, '
                  + 'read:repository:bitbucket, read:pullrequest:bitbucket, and write:pullrequest:bitbucket '
                  + 'scopes. Add write:repository:bitbucket when Sessions will push changes.',
                schema: { type: 'string', minLength: 1 },
                secret: true,
              },
            ],
          }],
        },
        capabilities: ['scmHostingBasicAuth'],
      },
      runtime: bitbucketConnectedAccountRuntime,
      accountRuntime: bitbucketPortableAuthentication,
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [BITBUCKET_TRIAGE_CONTRIBUTION_ID]: sources.contribute({
          descriptor: BITBUCKET_TRIAGE_DESCRIPTOR,
          operations: {
            listInstances: sources.operations.listInstances
              .bind(BITBUCKET_TRIAGE_ACTION_IDS.listInstances),
            scan: sources.operations.scan.bind(BITBUCKET_TRIAGE_ACTION_IDS.scan),
            get: sources.operations.get.bind(BITBUCKET_TRIAGE_ACTION_IDS.get),
            prepareReviewWorkspace: sources.operations.prepareReviewWorkspace
              .bind(BITBUCKET_TRIAGE_ACTION_IDS.prepareReviewWorkspace),
            verifyReviewWorkspace: sources.operations.verifyReviewWorkspace
              .bind(BITBUCKET_TRIAGE_ACTION_IDS.verifyReviewWorkspace),
          },
          surfaces: { detail: { renderer: BITBUCKET_TRIAGE_DETAIL_RENDERER_ID } },
        }),
      },
    },
  },
});

/** The sole Bitbucket plugin manifest. */
export const PLUGIN_MANIFEST = BITBUCKET_PLUGIN.manifest;
