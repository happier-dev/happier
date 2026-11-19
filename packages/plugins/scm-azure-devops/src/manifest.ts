import { azureDevopsPortableAuthentication } from './auth/azureDevopsConnectedAccountRuntime.js';
import { AZURE_DEVOPS_ACCOUNT_ACTIONS, sources, READ_HOST_ACCESS, INSTANCE_ACCOUNT_BINDINGS } from './accountActions.js';
/**
 * The sole Azure DevOps plugin manifest and registration spine.
 *
 * It is authored through `definePlugin` and, for the Triage source, through the protocol's own
 * `sources.contribute(...)`. That is not a style choice: a raw contribution literal can omit the
 * required `detail` surface and still typecheck, after which host admission rejects the whole
 * contribution with `required_surface_missing` and the plugin contributes nothing at all.
 * `contribute` types the required surface roles, so the same omission is a compile error here.
 *
 * Triage Actions use the shared Triage protocol schemas, including its account-only input
 * specialization. The Event Actions use the SDK's setup, recovery and webhook contracts.
 */

import { definePlugin } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  createPluginEventAutomationSetupResultV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import { PluginWebhookActionInputSchema, PluginWebhookActionResultSchema } from '@happier-dev/plugin-sdk/webhooks';

import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageSourceConnectedAccountInputsV1, TRIAGE_REVIEW_WORKSPACE_OPERATION_V1 } from '@happier-dev/triage-protocol/v1';

import {
  AZURE_DEVOPS_BASE_CONFIGURATION_FIELD,
  AZURE_DEVOPS_MANUAL_MODE_ID,
  azureDevopsConnectedAccountRuntime,
} from './auth/azureDevopsConnectedAccountRuntime.js';
import {
  AZURE_DEVOPS_PLUGIN_ID,
  AZURE_DEVOPS_SCM_HOSTING_PROVIDER_LOCAL_ID,
} from './azureDevopsContracts.js';
import { AZURE_DEVOPS_EVENT_ACTION_IDS } from './eventActionIds.js';
import { receiveAzureDevOpsWebhook, resetAzureDevOpsEventHistoryGap, setupAzureDevOpsPullRequestEvent } from './eventActions.js';
import {
  AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION,
  AZURE_DEVOPS_PULL_REQUEST_EVENT_ID,
  AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID,
  AzureDevOpsEventSetupInputSchema,
  AzureDevOpsEventSourceConfigSchema,
  AzureDevOpsPullRequestEventPayloadSchema,
} from './events.js';
import { azureDevopsOperationsAdapter } from './operations/azureDevopsAdapter.js';

import { AZURE_DEVOPS_TRIAGE_ACTION_IDS, prepareAzureDevOpsReviewWorkspaceAction, verifyAzureDevOpsReviewWorkspaceAction } from './triage/actions.js';





import {
  AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID,
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
const EVENT_ACCOUNT_BINDINGS = [{ path: 'credentialRef', purpose: AZURE_DEVOPS_TRIAGE_PURPOSE }];

export {
  AZURE_DEVOPS_TRIAGE_ACTION_IDS,
  AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID,
  AZURE_DEVOPS_TRIAGE_DETAIL_ARTIFACT_ID,
  AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID,
};



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
  // Canonical base parsing/admission is host-owned. Do not add a second URL
  // length policy at the provider declaration.
  schema: { type: 'string' as const, minLength: 1 },
  required: true as const,
  secret: false as const,
};

const TOKEN_FIELD = {
  id: 'token',
  title: {
    key: 'plugins.azureDevops.auth.token.title',
    fallback: 'Personal access token',
  },
  description: {
    key: 'plugins.azureDevops.auth.token.description',
    fallback: 'Use Code (read) to browse. Actions that change Azure DevOps require Code (read & write).',
  },
  schema: { type: 'string' as const, minLength: 1 },
  secret: true as const,
};

/**
 * Triage reads and writes reach the deployment through the exact Connected Account origin. The
 * repository-scoped SCM origin belongs to the SCM adapter and is unavailable to these global Actions.
 *
 * Every role after discovery declares the exact account path its configured instance carries, so
 * the host cross-checks the credential-ref leaf at declaration time. `scan`'s published input is a
 * two-arm union — the deliberate shape that makes a mid-scan limit change unrepresentable — and the
 * canonical Action validator resolves the bound path in every representable arm, so the union costs
 * no declaration-time authority. `listInstances` carries no account at all, because producing
 * account references is what it performs.
 */



export const AZURE_DEVOPS_PLUGIN = definePlugin({
  id: AZURE_DEVOPS_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Azure DevOps SCM hosting provider',
  description: 'Detects Azure DevOps remotes, provides Azure Repos operations,'
    + ' and brings its pull requests into PRs & Issues.',
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
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: {
    required: [{
      id: AZURE_DEVOPS_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the public Azure DevOps SCM provider origin.',
      scope: {
        targets: [{ kind: 'scmProviderOrigin', provider: 'azure-devops' }],
        // `GET` serves every read and every confirming re-read. `PATCH` covers the four writes
        // Azure expresses as an update of an existing resource — complete, abandon and reactivate
        // on the pull request itself, plus one review thread's status. `POST` covers the documented
        // bulk additive reviewer route and review-thread publication; `PUT` carries the viewer's
        // verdict through Azure's per-reviewer vote route. The host
        // revalidates origin AND method at dispatch, so an Action whose verb is missing here is
        // rejected before it ever reaches Azure. `DELETE` stays absent: no declared Action removes
        // anything — `request-review` adds identities and never removes one — and a verb granted
        // for symmetry is authority the user approved for nothing.
        methods: ['GET', 'PATCH', 'POST', 'PUT'],
      },
    }, {
      id: AZURE_DEVOPS_ACCOUNT_NETWORK_HOST_ACCESS_ID,
      capability: 'network',
      reason: 'Access the configured Azure DevOps organization or collection for the selected account, including private Azure DevOps Server deployments.',
      scope: {
        targets: [{ kind: 'connectedAccountOrigin', service: AZURE_DEVOPS_CONNECTED_ACCOUNT_ID }],
        // Azure DevOps Server may be hosted on a private network. This flag stays on the
        // connected-account scope only; the fixed public SCM provider grant above remains
        // public-only even when a private Server account is selected.
        methods: ['GET', 'PATCH', 'POST', 'PUT'],
        privateNetwork: true,
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
      requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
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
    ...AZURE_DEVOPS_ACCOUNT_ACTIONS,
    [AZURE_DEVOPS_EVENT_ACTION_IDS.setup]: {
      title: 'Set up Azure DevOps pull request events',
      description: 'Checks one repository using the selected Azure DevOps account.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
      dangerLevel: 'safe',
      inputSchema: AzureDevOpsEventSetupInputSchema.jsonSchema,
      inputHints: { fields: [{
        path: 'credentialRef', title: 'Azure DevOps account', widget: 'select', required: true,
        connectedAccountOptions: true, requireExplicitSelection: true,
      }, {
        path: 'baseUrl', title: 'Organization or collection URL', widget: 'text', required: true,
        description: 'Enter the URL in the selected Azure DevOps account.',
      }, {
        path: 'project', title: 'Project ID', widget: 'text', required: true,
      }, {
        path: 'repository', title: 'Repository ID', widget: 'text', required: true,
      }, {
        path: 'changes', title: 'Pull request changes', widget: 'select', required: true,
        description: 'Use the returned URL for the matching Azure DevOps Service Hooks and send all resource details.',
        options: [{
          value: 'sourceBranch', label: 'Opened or source branch updated',
          description: 'Set up Pull request created and Pull request updated hooks. Filter updates to source branch pushes.',
        }, {
          value: 'status', label: 'Reopened',
          description: 'Set up a Pull request updated hook filtered to status changes.',
        }],
      }] },
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(
        AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION, AzureDevOpsEventSourceConfigSchema.jsonSchema,
      ),
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: EVENT_ACCOUNT_BINDINGS,
      run: setupAzureDevOpsPullRequestEvent,
    },
    [AZURE_DEVOPS_EVENT_ACTION_IDS.resetHistoryGap]: {
      title: 'Check Azure DevOps Event history',
      description: 'Checks whether the webhook source has a history gap.',
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
      resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
      run: resetAzureDevOpsEventHistoryGap,
    },
    [AZURE_DEVOPS_EVENT_ACTION_IDS.webhook]: {
      title: 'Receive Azure DevOps pull request webhook',
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      inputSchema: PluginWebhookActionInputSchema.jsonSchema,
      resultSchema: PluginWebhookActionResultSchema.jsonSchema,
      run: receiveAzureDevOpsWebhook,
    },
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.prepareReviewWorkspace]: {
      title: 'Prepare Azure DevOps review workspace',
      description: 'Revalidates one selected pull request and materializes its source tip locally.',
      surfaces: sources.operations.prepareReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.prepareReviewWorkspace.declaration.dangerLevel,
      operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
      secretInputPaths: ['instance.configuration.token'],
      confirmation: {
        title: 'Prepare Azure DevOps review workspace',
        confirmLabel: 'Prepare workspace',
        inputFields: [
          { path: 'lastKnownLocator.routingToken', title: 'Repository' },
          { path: 'instance.locator.displayLabel', title: 'Source' },
          { path: 'entryRef.entryId', title: 'Item' },
          { path: 'observed.headSha', title: 'Reviewed head' },
          { path: 'workspace.rootPath', title: 'Workspace path' },
        ],
      },
      // The person's own press is the consent for the checkout they asked for;
      // agents, MCP and a saved Ask keep the writes-local default.
      confirmationWhen: { presentUserUi: false },
      inputSchema: TriageSourceConnectedAccountInputsV1.prepareReviewWorkspace.jsonSchema,
      // The person's own bound account is the one field; a draft that already names it settles without a form,
      // and placement and the observed PR facts come from their host owners.
      inputHints: { fields: [{ path: 'instance.binding.account', title: 'Azure DevOps account', widget: 'select',
        required: true, connectedAccountOptions: true }] },
      resultSchema: sources.operations.prepareReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: prepareAzureDevOpsReviewWorkspaceAction,
    },
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.verifyReviewWorkspace]: {
      title: 'Verify Azure DevOps review workspace',
      description: 'Rereads one pull request and verifies the prepared local HEAD before review.',
      surfaces: sources.operations.verifyReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.verifyReviewWorkspace.declaration.dangerLevel,
      operation: TRIAGE_REVIEW_WORKSPACE_OPERATION_V1,
      inputSchema: TriageSourceConnectedAccountInputsV1.verifyReviewWorkspace.jsonSchema,
      resultSchema: sources.operations.verifyReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: verifyAzureDevOpsReviewWorkspaceAction,
    }
  },
  events: {
    [AZURE_DEVOPS_PULL_REQUEST_EVENT_ID]: {
      declaration: {
        kind: 'event',
        title: 'Azure DevOps pull request lifecycle changed',
        description: 'A pull request was opened, reopened, or received a source branch push.',
        payloadSchema: AzureDevOpsPullRequestEventPayloadSchema.jsonSchema,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: AZURE_DEVOPS_EVENT_SOURCE_CONTRACT_VERSION,
            supportedObservationTransports: ['durablePush'],
            sourceConfigSchema: AzureDevOpsEventSourceConfigSchema.jsonSchema,
            setupActionRef: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_EVENT_ACTION_IDS.setup },
            historyGapResetActionRef: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_EVENT_ACTION_IDS.resetHistoryGap },
            webhookContributionRef: { pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID },
            connectedAccountPurposeBindings: EVENT_ACCOUNT_BINDINGS,
          },
        },
      },
    },
  },
  webhooks: {
    [AZURE_DEVOPS_WEBHOOK_CONTRIBUTION_ID]: {
      title: 'Azure DevOps pull request webhook',
      description: 'Receives Azure DevOps pull request Service Hooks.',
      verifier: { kind: 'capabilityUrl_v1', routing: 'accountEndpoint' },
      handlerAction: { localId: AZURE_DEVOPS_EVENT_ACTION_IDS.webhook },
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
      runtime: {
        adapter: {
          routing: azureDevopsOperationsAdapter,
          pullRequests: azureDevopsOperationsAdapter,
          repositoryPublishing: azureDevopsOperationsAdapter,
        },
      },
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
          account: { artifactId: 'azure-devops-account-runtime', exportName: 'activate' },
          defaultModeId: AZURE_DEVOPS_MANUAL_MODE_ID,
          modes: [{
            id: AZURE_DEVOPS_MANUAL_MODE_ID,
            kind: 'manual',
            setup: {
              url: 'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops',
              checklist: ['In the Azure DevOps deployment you will connect, open User settings > Personal access tokens and create a token.', 'Select the organization, expiration, and Code and Work Items permissions needed for the actions you want to use.', 'Copy the token and enter the matching organization or collection URL here.'],
              createKeyTitle: 'Read Azure DevOps token instructions',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
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
      accountRuntime: azureDevopsPortableAuthentication,
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
            prepareReviewWorkspace: sources.operations.prepareReviewWorkspace
              .bind(AZURE_DEVOPS_TRIAGE_ACTION_IDS.prepareReviewWorkspace),
            verifyReviewWorkspace: sources.operations.verifyReviewWorkspace
              .bind(AZURE_DEVOPS_TRIAGE_ACTION_IDS.verifyReviewWorkspace),
          },
          surfaces: { detail: { renderer: AZURE_DEVOPS_TRIAGE_DETAIL_RENDERER_ID } },
        }),
      },
    },
  },
});

/** The sole Azure DevOps plugin manifest. */
export const PLUGIN_MANIFEST = AZURE_DEVOPS_PLUGIN.manifest;
