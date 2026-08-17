import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import {
  GITLAB_ORIGIN_CONFIGURATION_FIELD,
  GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
  GITLAB_TOKEN_CREDENTIAL_KEY,
} from './auth/connectedAccountRuntime.js';
import {
  GITLAB_CONNECTED_ACCOUNT_ID,
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_NETWORK_HOST_ACCESS_ID,
  GITLAB_TRIAGE_ACTION_DECLARATIONS,
  GITLAB_TRIAGE_CONTRIBUTION_DECLARATION,
  GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS,
  GITLAB_TRIAGE_DETAIL_ARTIFACT_ID,
  GITLAB_TRIAGE_DETAIL_RENDERER_ID,
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_SETTINGS_ARTIFACT_ID,
  GITLAB_TRIAGE_SETTINGS_GROUP_ID,
  GITLAB_TRIAGE_SETTINGS_PAGE_ID,
  GITLAB_TRIAGE_SETTINGS_RENDERER_ID,
} from './triage/contribution.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: GITLAB_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'GitLab SCM hosting provider',
  description: 'Detects GitLab remotes and provides GitLab repository operations.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: GITLAB_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the configured GitLab SCM provider origin.',
      scope: {
        targets: [
          { kind: 'scmProviderOrigin', provider: 'gitlab' },
          { kind: 'connectedAccountOrigin', service: GITLAB_CONNECTED_ACCOUNT_ID },
        ],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
      },
    }, {
      id: 'gitlab-cli-process',
      capability: 'process',
      reason: 'Run the declared GitLab CLI for pull-request operations.',
      scope: { executables: [{ kind: 'systemTool', id: 'gitlab-cli' }] },
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
  contributes: {
    scmHostingProviders: [{
      id: 'gitlab',
      title: 'GitLab',
      description: 'GitLab.com and configured self-managed GitLab repositories.',
      kind: 'gitlab',
      capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
    }],
    systemTools: [{
      id: 'gitlab-cli',
      title: 'GitLab CLI',
      description: 'GitLab command line client used for authenticated merge-request operations.',
      executableNames: ['glab'],
    }],
    connectedAccountDescriptors: [{
      id: GITLAB_CONNECTED_ACCOUNT_ID,
      title: 'GitLab account',
      description: 'GitLab deployment and personal access token used to read merge requests and issues.',
      authentication: {
        defaultModeId: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
        modes: [{
          id: GITLAB_PERSONAL_ACCESS_TOKEN_MODE_ID,
          kind: 'manual',
          title: 'Personal access token',
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
              title: 'GitLab URL',
              description: 'The base URL of your GitLab, for example https://gitlab.com.',
              semantic: 'connectedAccountOrigin',
              schema: { type: 'string', minLength: 8, maxLength: 2048 },
              secret: false,
              required: true,
            }],
          },
        }],
      },
    }],
    actions: [
      ...GITLAB_TRIAGE_ACTION_DECLARATIONS,
      ...GITLAB_TRIAGE_DETAIL_ACTION_DECLARATIONS,
    ],
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
        requiredHostMethods: ['executeAction'],
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
      translations: [{
        locale: 'en',
        messages: {
          'plugins.gitlab.settings.group': 'GitLab',
          'plugins.gitlab.settings.sources': 'PRs & Issues',
          'plugins.gitlab.settings.sources.subtitle':
            'Choose which GitLab accounts and projects appear in PRs & Issues.',
        },
      }],
    },
    targetedPluginContributions: [GITLAB_TRIAGE_CONTRIBUTION_DECLARATION],
  },
} satisfies PluginManifest;
