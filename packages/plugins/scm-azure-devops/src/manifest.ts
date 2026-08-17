/**
 * The sole Azure DevOps plugin manifest and registration spine.
 *
 * It is authored through `definePlugin` and, for the Triage source, through the protocol's own
 * `sources.contribute(...)`. That is not a style choice: a raw contribution literal can omit the
 * required `detail` surface and still typecheck, after which host admission rejects the whole
 * contribution with `required_surface_missing` and the plugin contributes nothing at all.
 * `contribute` types the required surface roles, so the same omission is a compile error here.
 *
 * Every Action's input and result schema is the exact published Triage schema read from the role
 * declaration rather than a local restatement, so drift between this manifest and the shared
 * contract fails conformance instead of admitting a source that speaks a private dialect.
 */

import { definePlugin } from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import {
  AZURE_DEVOPS_BASE_CONFIGURATION_FIELD,
  AZURE_DEVOPS_MANUAL_MODE_ID,
  azureDevopsConnectedAccountRuntime,
} from './auth/azureDevopsConnectedAccountRuntime.js';
import {
  AZURE_DEVOPS_PLUGIN_ID,
  AZURE_DEVOPS_SCM_HOSTING_PROVIDER_LOCAL_ID,
} from './azureDevopsContracts.js';
import { azureDevopsOperationsAdapter } from './operations/azureDevopsAdapter.js';
import {
  AZURE_DEVOPS_TRIAGE_ACTION_IDS,
  getAzureDevOpsSourceEntryAction,
  listAzureDevOpsInstancesAction,
  scanAzureDevOpsSourceAction,
} from './triage/actions.js';
import {
  AzureCommitsInputV1Schema,
  AzureCommitsResultV1Schema,
  AzureIterationChangesInputV1Schema,
  AzureIterationChangesResultV1Schema,
  AzureIterationsInputV1Schema,
  AzureIterationsResultV1Schema,
  AzurePoliciesInputV1Schema,
  AzurePoliciesResultV1Schema,
  AzureThreadsInputV1Schema,
  AzureThreadsResultV1Schema,
} from './triage/detail/contracts.js';
import {
  AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS,
  listAzureDevOpsCommits,
  listAzureDevOpsIterationChanges,
  readAzureDevOpsIterations,
  readAzureDevOpsPolicies,
  readAzureDevOpsThreads,
} from './triage/detailActions.js';
import {
  AZURE_DEVOPS_CONNECTED_ACCOUNT_ID,
  AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID,
  AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID,
  AZURE_DEVOPS_TRIAGE_DESCRIPTOR,
  AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID,
  AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID,
  AZURE_DEVOPS_TRIAGE_SETTINGS_ARTIFACT_ID,
  AZURE_DEVOPS_TRIAGE_SETTINGS_GROUP_ID,
  AZURE_DEVOPS_TRIAGE_SETTINGS_PAGE_ID,
  AZURE_DEVOPS_TRIAGE_SETTINGS_RENDERER_ID,
  AZURE_DEVOPS_TRIAGE_PURPOSE,
} from './triage/descriptor.js';

export const AZURE_CLI_SYSTEM_TOOL_ID = 'azure-cli';
const AZURE_CLI_PROCESS_HOST_ACCESS_ID = 'azure-cli-process';

export {
  AZURE_DEVOPS_TRIAGE_ACTION_IDS,
  AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID,
  AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID,
  AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID,
};

const sources = TriageSourcesContributionProtocolV1;

/**
 * The `azure-devops-account` deployment field.
 *
 * `sources/SCM.md` §6.1 makes the explicitly configured deployment the only routing authority:
 * nothing here maps, guesses, probes, or fans out, and Azure DevOps Services and Server differ
 * only in which URL the user configures. The value carries `semantic: 'connectedAccountBase'`, so
 * the host — not this source — normalizes it, admits it at HostAccess and republishes it as two
 * facts: the account's `connectedAccountBases`, which this source routes by, and the bare
 * `connectedAccountOrigins` beneath which those bases live, which HostAccess governs by.
 *
 * The base semantic is required rather than convenient: every Azure DevOps REST path lives beneath
 * an organization (Services) or collection (Server) **path** segment, and the origin semantic
 * rejects any path at all.
 */
const BASE_FIELD = {
  id: AZURE_DEVOPS_BASE_CONFIGURATION_FIELD,
  title: {
    key: 'plugins.azureDevops.auth.base.title',
    fallback: 'Azure DevOps URL',
  },
  description: {
    key: 'plugins.azureDevops.auth.base.description',
    fallback: 'https://dev.azure.com/your-organization for Azure DevOps Services,'
      + ' or your Azure DevOps Server collection URL.',
  },
  semantic: 'connectedAccountBase' as const,
  schema: { type: 'string' as const, minLength: 8, maxLength: 2048 },
  required: true as const,
};

const TOKEN_FIELD = {
  id: 'token',
  title: {
    key: 'plugins.azureDevops.auth.token.title',
    fallback: 'Personal access token',
  },
  description: {
    key: 'plugins.azureDevops.auth.token.description',
    fallback: 'An Azure DevOps personal access token with Code (read) access.',
  },
  schema: { type: 'string' as const, minLength: 1 },
  secret: true as const,
};

/**
 * Every read Action reaches the provider and the exact account, so both grants are declared on all
 * three.
 *
 * `scan` and `get` additionally declare the exact account path their configured instance carries,
 * so the host cross-checks the credential-ref leaf at declaration time. `scan`'s published input is
 * a two-arm union — the deliberate shape that makes a mid-scan limit change unrepresentable — and
 * the canonical Action validator resolves the bound path in every representable arm, so the union
 * costs no declaration-time authority. `listInstances` carries no account at all, because producing
 * account references is what it performs.
 */
const READ_HOST_ACCESS = [AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID, AZURE_DEVOPS_TRIAGE_PURPOSE];
const INSTANCE_ACCOUNT_BINDINGS = [{
  path: 'instance.binding.account',
  purpose: AZURE_DEVOPS_TRIAGE_PURPOSE,
}];

export const AZURE_DEVOPS_PLUGIN = definePlugin({
  id: AZURE_DEVOPS_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Azure DevOps SCM hosting provider',
  description: 'Detects Azure DevOps remotes, provides Azure Repos operations,'
    + ' and brings its pull requests into PRs & Issues.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the configured Azure DevOps organization or collection for the selected account.',
      scope: {
        targets: [
          { kind: 'scmProviderOrigin', provider: 'azure-devops' },
          { kind: 'connectedAccountOrigin', service: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID },
        ],
        // The Triage vertical is read-only; the write verbs belong to the incumbent hosting-provider
        // operations this plugin already ships.
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      },
    }, {
      id: AZURE_DEVOPS_TRIAGE_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact selected Azure DevOps account for Azure DevOps API requests.',
      scope: {
        serviceRefs: [AZURE_DEVOPS_CONNECTED_ACCOUNT_ID],
        operations: ['use'],
        materializationKinds: ['httpHeaders'],
      },
    }, {
      id: AZURE_CLI_PROCESS_HOST_ACCESS_ID,
      capability: 'process',
      reason: 'Run the declared Azure CLI for authenticated Azure DevOps operations.',
      scope: {
        executables: [{ kind: 'systemTool', id: AZURE_CLI_SYSTEM_TOOL_ID }],
        envKeys: ['AZURE_CORE_NO_COLOR', 'AZURE_CORE_ONLY_SHOW_ERRORS'],
      },
    }],
    optional: [],
  },
  ui: {
    views: [],
    renderers: [{
      id: AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID,
      kind: 'reactNative',
      artifact: AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID,
      // The detail body reads through this plugin's own Actions, so a mount without them would
      // render an empty shell rather than a useful surface.
      requiredHostMethods: ['executeAction'],
    }, {
      id: AZURE_DEVOPS_TRIAGE_SETTINGS_RENDERER_ID,
      kind: 'reactNative',
      artifact: AZURE_DEVOPS_TRIAGE_SETTINGS_ARTIFACT_ID,
      // The page's whole purpose is two Action invocations — this source's own
      // discovery read and the target-owned administration write.
      requiredHostMethods: ['executeAction'],
    }],
    settingsGroups: [{
      id: AZURE_DEVOPS_TRIAGE_SETTINGS_GROUP_ID,
      title: { key: 'plugins.azureDevops.settings.group', fallback: 'Azure DevOps' },
      icon: 'settings',
      defaultRank: 40,
    }],
    settingsPages: [{
      id: AZURE_DEVOPS_TRIAGE_SETTINGS_PAGE_ID,
      group: { kind: 'plugin', localId: AZURE_DEVOPS_TRIAGE_SETTINGS_GROUP_ID },
      title: { key: 'plugins.azureDevops.settings.sources', fallback: 'PRs & Issues' },
      subtitle: {
        key: 'plugins.azureDevops.settings.sources.subtitle',
        fallback: 'Choose which Azure DevOps accounts and projects appear in PRs & Issues.',
      },
      keywords: ['azure devops', 'pull requests', 'triage'],
      icon: 'settings',
      defaultRank: 10,
      renderer: AZURE_DEVOPS_TRIAGE_SETTINGS_RENDERER_ID,
    }],
    translations: [{
      locale: 'en',
      messages: {
        'plugins.azureDevops.settings.group': 'Azure DevOps',
        'plugins.azureDevops.settings.sources': 'PRs & Issues',
        'plugins.azureDevops.settings.sources.subtitle':
          'Choose which Azure DevOps accounts and projects appear in PRs & Issues.',
      },
    }],
  },
  actions: {
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances]: {
      title: 'Discover Azure DevOps organizations',
      description: 'Lists the Azure DevOps deployments each connected account can reach.',
      scopes: ['global'],
      surfaces: sources.operations.listInstances.declaration.surfaces,
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      run: listAzureDevOpsInstancesAction,
    },
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.scan]: {
      title: 'Scan Azure DevOps pull requests',
      description: 'Reads one bounded page of the configured Azure DevOps pull-request walk.',
      scopes: ['global'],
      surfaces: sources.operations.scan.declaration.surfaces,
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: scanAzureDevOpsSourceAction,
    },
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.get]: {
      title: 'Read an Azure DevOps pull request',
      description: 'Reads one pull request authoritatively through its configured deployment.',
      scopes: ['global'],
      surfaces: sources.operations.get.declaration.surfaces,
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: getAzureDevOpsSourceEntryAction,
    },
    // The five source-native detail planes. Their published surface is
    // `plugin`, so the only caller that reaches them is this plugin's own
    // mounted detail artifact.
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readIterations]: {
      title: 'Read the Azure DevOps iterations of a pull request',
      description: 'Reads the pull request\u2019s iteration list once, and names the real'
        + ' current iteration the Files and Activity tabs both compare against.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: AzureIterationsInputV1Schema.jsonSchema,
      resultSchema: AzureIterationsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsIterations,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listCommits]: {
      title: 'Read an Azure DevOps commit page',
      description: 'Reads one bounded page of the commits of one pull request, positioned only'
        + ' by the continuation token Azure DevOps issued.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: AzureCommitsInputV1Schema.jsonSchema,
      resultSchema: AzureCommitsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listAzureDevOpsCommits,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listIterationChanges]: {
      title: 'Read an Azure DevOps iteration change page',
      description: 'Reads one bounded page of the files one pull-request iteration changes,'
        + ' advancing only through the skip and top Azure DevOps issued.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: AzureIterationChangesInputV1Schema.jsonSchema,
      resultSchema: AzureIterationChangesResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: listAzureDevOpsIterationChanges,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readPolicies]: {
      title: 'Read the Azure DevOps policies of a pull request',
      description: 'Reads the statuses and policy evaluations of one pull request, with'
        + ' enforcement taken only from a returned evaluation.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: AzurePoliciesInputV1Schema.jsonSchema,
      resultSchema: AzurePoliciesResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsPolicies,
    },
    [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads]: {
      title: 'Read the Azure DevOps threads of a pull request',
      description: 'Reads every review thread of one pull request in the one response the'
        + ' documented endpoint returns.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: AzureThreadsInputV1Schema.jsonSchema,
      resultSchema: AzureThreadsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsThreads,
    },
  },
  scmHostingProviders: {
    [AZURE_DEVOPS_SCM_HOSTING_PROVIDER_LOCAL_ID]: {
      declaration: {
        title: 'Azure DevOps',
        description: 'Azure Repos repositories hosted by Azure DevOps.',
        kind: 'azure-devops',
        capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
        authService: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID,
      },
      runtime: { adapter: azureDevopsOperationsAdapter },
    },
  },
  connectedAccountDescriptors: {
    [AZURE_DEVOPS_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: { key: 'plugins.azureDevops.account.title', fallback: 'Azure DevOps account' },
        description: {
          key: 'plugins.azureDevops.account.description',
          fallback: 'Azure DevOps deployment and personal access token used to read pull requests.',
        },
        authentication: {
          defaultModeId: AZURE_DEVOPS_MANUAL_MODE_ID,
          modes: [{
            id: AZURE_DEVOPS_MANUAL_MODE_ID,
            kind: 'manual',
            title: {
              key: 'plugins.azureDevops.auth.manual.title',
              fallback: 'Azure DevOps personal access token',
            },
            outcomeReconciliation: 'none',
            fields: [TOKEN_FIELD],
            configuration: {
              scope: 'account',
              // Changing the deployment is not an update of the same connection: it retires the
              // old configured instance and starts a full scan for the new one.
              changeBehavior: 'reconnect',
              fields: [BASE_FIELD],
            },
          }],
        },
        capabilities: ['scmHostingBasicAuth'],
      },
      runtime: azureDevopsConnectedAccountRuntime,
    },
  },
  systemTools: {
    [AZURE_CLI_SYSTEM_TOOL_ID]: {
      title: 'Azure CLI',
      description: 'Azure command line client used for authenticated Azure DevOps operations.',
      executableNames: ['az'],
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID]: sources.contribute({
          descriptor: AZURE_DEVOPS_TRIAGE_DESCRIPTOR,
          operations: {
            listInstances: sources.operations.listInstances
              .bind(AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances),
            scan: sources.operations.scan.bind(AZURE_DEVOPS_TRIAGE_ACTION_IDS.scan),
            get: sources.operations.get.bind(AZURE_DEVOPS_TRIAGE_ACTION_IDS.get),
          },
          // `prepareReviewWorkspace` is deliberately unbound: it is an optional role, and binding
          // it would claim a worktree materialization contract this source has not implemented.
          surfaces: { detail: { renderer: AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID } },
        }),
      },
    },
  },
});

/** The sole Azure DevOps plugin manifest. */
export const PLUGIN_MANIFEST = AZURE_DEVOPS_PLUGIN.manifest;
