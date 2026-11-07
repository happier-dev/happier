import { gitlabPortableAuthentication } from './auth/connectedAccountRuntime.js';
import { GITLAB_ACCOUNT_ACTIONS, readGitlabActionDeclaration } from './accountActions.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

import { GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID, gitlabHostingProviderAdapter } from './adapter.js';
import { gitlabRestPullRequestAdapter } from './pullRequests/index.js';



import {
  GITLAB_ORIGIN_CONFIGURATION_FIELD,
  GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
  GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID,
  GITLAB_TOKEN_CREDENTIAL_KEY,
  gitlabConnectedAccountRuntime,
} from './auth/connectedAccountRuntime.js';
import { GITLAB_CONNECTED_ACCOUNT_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_ACCOUNT_NETWORK_HOST_ACCESS_ID, GITLAB_CLOUD_NETWORK_HOST_ACCESS_ID, GITLAB_TRIAGE_ACTION_IDS, GITLAB_REVIEW_WORKSPACE_EXECUTION, GITLAB_TRIAGE_CONTRIBUTION_DECLARATION, GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID, GITLAB_TRIAGE_DETAIL_ARTIFACT_ID, GITLAB_TRIAGE_DETAIL_RENDERER_ID, GITLAB_PLUGIN_ID, GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID, GITLAB_TRIAGE_SETTINGS_GROUP_ID, GITLAB_TRIAGE_SETTINGS_PAGE_ID, GITLAB_TRIAGE_SETTINGS_RENDERER_ID } from './triage/contribution.js';
import { GITLAB_PUBLIC_ORIGIN } from './triage/origin.js';


import { prepareGitlabReviewWorkspaceAction, verifyGitlabReviewWorkspaceAction } from './triage/operations.js';






export const GITLAB_PLUGIN = definePlugin({
  id: GITLAB_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'GitLab SCM hosting provider',
  description: 'Detects GitLab remotes and provides GitLab repository operations.',
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
      id: GITLAB_CLOUD_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the public GitLab.com API.',
      scope: {
        targets: [{ kind: 'fixedOrigin', origin: GITLAB_PUBLIC_ORIGIN }],
        // Exactly the verbs the declared Actions consume, and no others. The
        // host revalidates the origin AND the method at dispatch and refuses an
        // ungranted verb before it reaches GitLab, so a write missing from this
        // list fails at the host authority boundary where no unit test can see
        // it. `PUT` is the merge and the state transition; `POST` is the
        // GraphQL draft transition. A verb with no declaring Action is not
        // granted for symmetry.
        methods: ['GET', 'POST', 'PUT'],
      },
    }, {
      id: GITLAB_ACCOUNT_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the exact self-managed GitLab deployment configured on the selected'
        + ' Connected Account, including deployments on a private network.',
      scope: {
        targets: [{ kind: 'connectedAccountOrigin', service: GITLAB_CONNECTED_ACCOUNT_ID }],
        methods: ['GET', 'POST', 'PUT'],
        privateNetwork: true,
      },
    }, {
      id: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact configured GitLab Connected Account for GitLab API requests.',
      scope: {
        serviceRefs: [GITLAB_CONNECTED_ACCOUNT_ID],
        // This source never asks the user to select a binding: it enumerates
        // the accounts already authorized for its purpose and materializes the
        // exact one a configured instance names.
        operations: ['use'],
        materializationKinds: ['httpHeaders'],
      },
    }],
    optional: [],
  },
  scmHostingProviders: {
    [GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID]: {
      declaration: {
        title: 'GitLab',
        description: 'GitLab.com and self-managed GitLab repositories.',
        kind: 'gitlab',
        authService: GITLAB_CONNECTED_ACCOUNT_ID,
        capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
      },
      runtime: {
        adapter: {
          routing: gitlabHostingProviderAdapter,
          pullRequests: gitlabRestPullRequestAdapter,
        },
      },
    },
  },
  connectedAccountDescriptors: {
    [GITLAB_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: 'GitLab account',
        description: 'GitLab deployment and personal access token used to read merge requests and issues.',
        authentication: {
          account: { artifactId: 'gitlab-account-runtime', exportName: 'activate' },
          defaultModeId: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
          modes: [{
            id: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
            kind: 'manual',
            setup: {
              url: 'https://gitlab.com/-/user_settings/personal_access_tokens',
              checklist: ['Create a legacy personal access token in your GitLab.com profile settings.', 'Select read_api for reads or api for mutations, and choose an expiration.', 'Copy the generated token and paste it here.'],
              createKeyTitle: 'Open GitLab.com access tokens',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: 'GitLab.com personal access token',
            outcomeReconciliation: 'none',
            fields: [{
              id: GITLAB_TOKEN_CREDENTIAL_KEY,
              title: 'Personal access token',
              description: 'A GitLab personal access token. Reading needs read_api; mutations need api.',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
            configuration: {
              scope: 'account',
              // Changing the deployment is not an update of the same connection:
              // it retires the old configured instance and starts a fresh scan.
              changeBehavior: 'reconnect',
              fields: [{
                id: GITLAB_ORIGIN_CONFIGURATION_FIELD,
                title: 'GitLab deployment',
                description: 'Connect to GitLab.com.',
                semantic: 'connectedAccountFixedOrigin',
                schema: { type: 'string', enum: [GITLAB_PUBLIC_ORIGIN] },
                originByValue: { [GITLAB_PUBLIC_ORIGIN]: GITLAB_PUBLIC_ORIGIN },
                secret: false,
                required: true,
              }],
            },
          }, {
            id: GITLAB_SELF_HOSTED_PERSONAL_ACCESS_TOKEN_MODE_ID,
            kind: 'manual',
            setup: {
              url: 'https://docs.gitlab.com/user/profile/personal_access_tokens/',
              checklist: ['On your own GitLab deployment, open your profile settings and create a personal access token.', 'Select read_api for reads or api for mutations, and choose an expiration.', 'Paste the token here and enter the URL of that same deployment, including any path prefix.'],
              createKeyTitle: 'Read GitLab access token instructions',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: 'Self-managed GitLab personal access token',
            outcomeReconciliation: 'none',
            fields: [{
              id: GITLAB_TOKEN_CREDENTIAL_KEY,
              title: 'Personal access token',
              description: 'A GitLab personal access token. Reading needs read_api; mutations need api.',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
            configuration: {
              scope: 'account',
              changeBehavior: 'reconnect',
              fields: [{
                id: GITLAB_ORIGIN_CONFIGURATION_FIELD,
                title: 'Self-managed GitLab URL',
                description: 'The exact HTTPS base URL of your GitLab deployment, including any path prefix.',
                semantic: 'connectedAccountBase',
                schema: { type: 'string', minLength: 1 },
                secret: false,
                required: true,
              }],
            },
          }],
        },
      },
      runtime: gitlabConnectedAccountRuntime,
      accountRuntime: gitlabPortableAuthentication,
    },
  },
  actions: {
    ...GITLAB_ACCOUNT_ACTIONS,
    [GITLAB_TRIAGE_ACTION_IDS.prepareReviewWorkspace]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.prepareReviewWorkspace),
      execution: GITLAB_REVIEW_WORKSPACE_EXECUTION,
      run: prepareGitlabReviewWorkspaceAction,
    },
    [GITLAB_TRIAGE_ACTION_IDS.verifyReviewWorkspace]: {
      ...readGitlabActionDeclaration(GITLAB_TRIAGE_ACTION_IDS.verifyReviewWorkspace),
      execution: GITLAB_REVIEW_WORKSPACE_EXECUTION,
      run: verifyGitlabReviewWorkspaceAction,
    }
  },
  ui: {
      renderers: [{
        id: GITLAB_TRIAGE_DETAIL_RENDERER_ID,
        kind: 'reactNative',
        artifact: GITLAB_TRIAGE_DETAIL_ARTIFACT_ID,
        // The detail body reads through this plugin's own Actions, so a mount
        // without them would render an empty shell rather than a useful surface.
        requiredHostMethods: ['executeAction'],
      }, {
        id: GITLAB_TRIAGE_SETTINGS_RENDERER_ID,
        kind: 'reactNative',
        artifact: GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID,
        // The page's whole purpose is two Action invocations — this source's own
        // discovery read and the target-owned administration write.
        requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
      }],
      settingsGroups: [{
        id: GITLAB_TRIAGE_SETTINGS_GROUP_ID,
        title: { key: 'plugins.gitlab.settings.group', fallback: 'GitLab' },
        icon: 'settings',
        defaultRank: 40,
      }],
      settingsPages: [{
        id: GITLAB_TRIAGE_SETTINGS_PAGE_ID,
        group: { kind: 'plugin', localId: GITLAB_TRIAGE_SETTINGS_GROUP_ID },
        title: { key: 'plugins.gitlab.settings.sources', fallback: 'PRs & Issues' },
        subtitle: {
          key: 'plugins.gitlab.settings.sources.subtitle',
          fallback: 'Choose which GitLab accounts and projects appear in PRs & Issues.',
        },
        keywords: ['gitlab', 'merge requests', 'issues', 'triage'],
        icon: 'settings',
        defaultRank: 10,
        renderer: GITLAB_TRIAGE_SETTINGS_RENDERER_ID,
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
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [GITLAB_TRIAGE_CONTRIBUTION_LOCAL_ID]: GITLAB_TRIAGE_CONTRIBUTION_DECLARATION,
      },
    },
  },
});

export const PLUGIN_MANIFEST = GITLAB_PLUGIN.manifest;
