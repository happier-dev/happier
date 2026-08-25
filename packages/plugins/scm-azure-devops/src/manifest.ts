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
import { AZURE_DEVOPS_UI_TRANSLATIONS } from './ui/translations.js';
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
  AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS,
  abandonAzureDevOpsPullRequest,
  completeAzureDevOpsPullRequest,
  reactivateAzureDevOpsPullRequest,
  requestAzureDevOpsPullRequestReview,
  setAzureDevOpsPullRequestThreadStatus,
} from './triage/mutationActions.js';
import {
  AzureAbandonInputV1Schema,
  AzureCompleteInputV1Schema,
  AzureMutationResultV1Schema,
  AzureReactivateInputV1Schema,
  AzureRequestReviewInputV1Schema,
  AzureThreadStatusInputV1Schema,
  AzureThreadStatusResultV1Schema,
} from './triage/mutations/contracts.js';
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
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
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
        // `GET` serves every read and every confirming re-read. `PATCH` covers the four writes
        // Azure expresses as an update of an existing resource — complete, abandon and reactivate
        // on the pull request itself, plus one review thread's status — and `POST` covers exactly
        // one: the documented bulk additive reviewer route behind `request-review`. The host
        // revalidates origin AND method at dispatch, so an Action whose verb is missing here is
        // rejected before it ever reaches Azure. `DELETE` stays absent: no declared Action removes
        // anything — `request-review` adds identities and never removes one — and a verb granted
        // for symmetry is authority the user approved for nothing.
        methods: ['GET', 'PATCH', 'POST'],
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
    translations: [
      { locale: 'en', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.en, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PRs & Issues', 'plugins.azureDevops.settings.sources.subtitle': 'Choose which Azure DevOps accounts and projects appear in PRs & Issues.' } },
      { locale: 'ru', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.ru, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR и задачи', 'plugins.azureDevops.settings.sources.subtitle': 'Выберите учетные записи и проекты Azure DevOps, которые будут отображаться в разделе PR и задач.' } },
      { locale: 'pl', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.pl, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR-y i zgłoszenia', 'plugins.azureDevops.settings.sources.subtitle': 'Wybierz konta i projekty Azure DevOps wyświetlane w sekcji PR-ów i zgłoszeń.' } },
      { locale: 'es', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.es, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR e incidencias', 'plugins.azureDevops.settings.sources.subtitle': 'Elige qué cuentas y proyectos de Azure DevOps aparecen en PR e incidencias.' } },
      { locale: 'fr', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.fr, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR et tickets', 'plugins.azureDevops.settings.sources.subtitle': 'Choisissez les comptes et projets Azure DevOps affichés dans PR et tickets.' } },
      { locale: 'it', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.it, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR e segnalazioni', 'plugins.azureDevops.settings.sources.subtitle': 'Scegli gli account e i progetti Azure DevOps da mostrare in PR e segnalazioni.' } },
      { locale: 'pt', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.pt, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PRs e problemas', 'plugins.azureDevops.settings.sources.subtitle': 'Escolha as contas e os projetos Azure DevOps apresentados em PRs e problemas.' } },
      { locale: 'ca', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.ca, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR i incidències', 'plugins.azureDevops.settings.sources.subtitle': 'Tria els comptes i projectes d’Azure DevOps que es mostren a PR i incidències.' } },
      { locale: 'zh-Hans', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS['zh-Hans'], 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR 和问题', 'plugins.azureDevops.settings.sources.subtitle': '选择要在 PR 和问题中显示的 Azure DevOps 帐户和项目。' } },
      { locale: 'zh-Hant', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS['zh-Hant'], 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR 與問題', 'plugins.azureDevops.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 Azure DevOps 帳戶和專案。' } },
      { locale: 'ja', messages: { ...AZURE_DEVOPS_UI_TRANSLATIONS.ja, 'plugins.azureDevops.settings.group': 'Azure DevOps', 'plugins.azureDevops.settings.sources': 'PR と課題', 'plugins.azureDevops.settings.sources.subtitle': 'PR と課題に表示する Azure DevOps アカウントとプロジェクトを選択します。' } },
    ],
  },
  actions: {
    [AZURE_DEVOPS_TRIAGE_ACTION_IDS.listInstances]: {
      title: 'Discover Azure DevOps organizations',
      description: 'Lists the Azure DevOps deployments each connected account can reach.',
      scopes: ['global'],
      surfaces: sources.operations.listInstances.declaration.surfaces,
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
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
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: AzureThreadsInputV1Schema.jsonSchema,
      resultSchema: AzureThreadsResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: readAzureDevOpsThreads,
    },
    // The five enabled Azure DevOps pull-request writes.
    //
    // `surfaces: ['ui', 'plugin']` is the human gate, and the gate is reachability rather than a
    // prompt: with no `agent` and no `mcp` surface not one of them is agent-reachable at all. A
    // `danger` level plus `agent: true` would only floor an agent invocation to an approval
    // prompt, which is a weaker guarantee — so there is no list of exempt callers here, and none
    // may be added. `plugin` is the other half of that same reachability fact, and it is required
    // rather than optional: this plugin's own mounted detail artifact dispatches as a plugin
    // caller, so a write missing it is refused before it runs and no user can reach it either.
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.complete]: {
      title: 'Complete an Azure DevOps pull request',
      description: 'Completes one active pull request with the branch decision the user chose,'
        + ' only while its merge source is still the commit they saw, and reports the polled'
        + ' terminal state rather than the accepted request.',
      scopes: ['global'],
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      // Irreversible on the forge, and it may delete the source branch.
      dangerLevel: 'destructive',
      // The body names the two things Azure will NOT do, because both are decisions a user could
      // reasonably assume completion makes for them: it never moves Work Items and never bypasses
      // branch policy, and both are sent as an explicit `false` rather than left to a default.
      confirmation: {
        title: 'Complete this pull request?',
        body: 'Completing is permanent in Azure DevOps. Work items are not transitioned and branch'
          + ' policy is not bypassed. The source branch is deleted only if you chose that, and'
          + ' completion runs against the merge source shown here — if new commits arrive first,'
          + ' nothing is completed and you are asked again.',
        confirmLabel: 'Complete',
      },
      inputSchema: AzureCompleteInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: completeAzureDevOpsPullRequest,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.abandon]: {
      title: 'Abandon an Azure DevOps pull request',
      description: 'Abandons one active pull request. Azure can reactivate an abandoned pull'
        + ' request later.',
      scopes: ['global'],
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      confirmation: {
        title: 'Abandon this pull request?',
        body: 'The pull request stops being active and its reviewers stop being asked. Azure can'
          + ' reactivate it later, so this is not permanent.',
        confirmLabel: 'Abandon',
      },
      inputSchema: AzureAbandonInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: abandonAzureDevOpsPullRequest,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.reactivate]: {
      title: 'Reactivate an Azure DevOps pull request',
      description: 'Reactivates one abandoned pull request, which is Azure’s reopen. A'
        + ' completed pull request is refused rather than reactivated.',
      scopes: ['global'],
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      // The body says what comes back with it, because reactivating is not a private bookkeeping
      // change: the pull request becomes active again and its reviewers are asked again.
      confirmation: {
        title: 'Reactivate this pull request?',
        body: 'The pull request becomes active again and its reviewers are asked to look at it'
          + ' again. You can abandon it once more afterwards.',
        confirmLabel: 'Reactivate',
      },
      inputSchema: AzureReactivateInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: reactivateAzureDevOpsPullRequest,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.requestReview]: {
      title: 'Request review on an Azure DevOps pull request',
      description: 'Adds the selected identities as reviewers of one active pull request through'
        + ' one additive request, leaving every existing reviewer and vote untouched.',
      scopes: ['global'],
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      // The body states the one thing this write does NOT do, because the reviewer routes Azure
      // publishes can do it: nobody is removed and no existing vote is reset.
      confirmation: {
        title: 'Request review from these people?',
        body: 'They are added as reviewers and notified. Nobody currently reviewing is removed and'
          + ' no existing vote is changed.',
        confirmLabel: 'Request review',
      },
      inputSchema: AzureRequestReviewInputV1Schema.jsonSchema,
      resultSchema: AzureMutationResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: requestAzureDevOpsPullRequestReview,
    },
    [AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadStatus]: {
      title: 'Set the status of an Azure DevOps review thread',
      description: 'Sets one review thread’s status and confirms it from the thread itself.'
        + ' The conversation in the thread is never rewritten.',
      scopes: ['global'],
      surfaces: ['ui', 'plugin'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      confirmation: {
        title: 'Change this thread’s status?',
        body: 'Everyone on the pull request sees the new status. Nothing in the conversation is'
          + ' changed, and you can set the status again afterwards.',
        confirmLabel: 'Set status',
      },
      inputSchema: AzureThreadStatusInputV1Schema.jsonSchema,
      // A thread write settles into the thread's own vocabulary, not the pull request's: the
      // entity it changed is the thread, and returning an entry observation would answer a
      // question the caller did not ask.
      resultSchema: AzureThreadStatusResultV1Schema.jsonSchema,
      hostAccess: READ_HOST_ACCESS,
      connectedAccountPurposeBindings: INSTANCE_ACCOUNT_BINDINGS,
      run: setAzureDevOpsPullRequestThreadStatus,
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
