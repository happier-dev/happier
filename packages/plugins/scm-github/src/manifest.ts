import {
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import {
  definePlugin,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { ActionInputHints } from '@happier-dev/plugin-sdk/actions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  GITHUB_MOUNTED_DETAIL_DEADLINE_MS,
  GITHUB_MUTATION_DEADLINE_MS,
} from './triage/admission.js';
import {
  createPluginEventAutomationSetupResultV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { GITHUB_RENDER_UI_TRANSLATIONS } from './ui/renderTranslations.js';
import { GITHUB_ADDITIONAL_UI_TRANSLATIONS } from './ui/additionalTranslations.js';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID } from './adapter.js';
import { githubConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import {
  deliverGithubChannelMessage,
  pollGithubChannelObservations,
  resolveGithubChannelEndpoint,
  resolveGithubChannelPrincipal,
  setupGithubChannels,
  testGithubChannelConnection,
} from './githubChannelActions.js';
import {
  resetGithubRepositoryEventHistoryGap,
  setupGithubRepositoryEventSource,
} from './githubAutomationEventActions.js';
import { GITHUB_AUTOMATION_EVENT_CATALOG } from './githubAutomationEvents.js';
import {
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID,
} from './observations/githubAutomationEventCheckpoint.js';
import {
  createGithubAutomationEventCheckpointedPullObserver,
  type GithubAutomationEventCheckpointedPullObserver,
} from './observations/githubAutomationEventObserver.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
  GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_CONNECTED_ACCOUNT_ID,
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
  GITHUB_WEBHOOK_CONTRIBUTION_ID,
} from './observations/githubProviderContracts.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
  GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1,
  GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
  GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from './triage/contribution.js';
import {
  GithubChangedFilesInputV1Schema,
  GithubChangedFilesResultV1Schema,
  GithubChecksInputV1Schema,
  GithubChecksResultV1Schema,
  GithubFeedbackInputV1Schema,
  GithubFeedbackResultV1Schema,
  GithubReviewsInputV1Schema,
  GithubReviewsResultV1Schema,
  GithubTimelineInputV1Schema,
  GithubTimelineResultV1Schema,
} from './triage/detail/contracts.js';
import {
  listGithubChangedFiles,
  listGithubTimeline,
  readGithubFeedback,
  readGithubChecks,
  readGithubReviews,
} from './triage/detailOperations.js';
import { withGithubInvocationDeadline } from './triage/invocation.js';
import {
  GithubIssueAssigneeAddInputV1Schema,
  GithubIssueAssigneeRemoveInputV1Schema,
  GithubIssueCloseInputV1Schema,
  GithubIssueCommentInputV1Schema,
  GithubIssueCommentResultV1Schema,
  GithubIssueDeltaResultV1Schema,
  GithubIssueLabelAddInputV1Schema,
  GithubIssueLabelRemoveInputV1Schema,
  GithubIssueReopenInputV1Schema,
  GithubPullRequestAddReviewersInputV1Schema,
  GithubPullRequestCloseInputV1Schema,
  GithubPullRequestMarkReadyInputV1Schema,
  GithubPullRequestMarkReadyResultV1Schema,
  GithubPullRequestMergeInputV1Schema,
  GithubPullRequestMergeResultV1Schema,
  GithubPullRequestReviewPublicationInputV1Schema,
  GithubPullRequestReviewPublicationResultV1Schema,
  GithubPullRequestReviewCommentCreateInputV1Schema,
  GithubPullRequestReviewCommentCreateResultV1Schema,
  GithubPullRequestRemoveReviewersInputV1Schema,
  GithubPullRequestReopenInputV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestStateResultV1Schema,
  GithubPullRequestThreadResolutionInputV1Schema,
  GithubPullRequestThreadResolutionResultV1Schema,
  GithubPullRequestThreadReplyInputV1Schema,
  GithubPullRequestThreadReplyResultV1Schema,
  GithubPullRequestUpdateBranchInputV1Schema,
  GithubPullRequestUpdateBranchResultV1Schema,
} from './triage/mutations/contracts.js';
import {
  addGithubIssueAssigneesAction,
  addGithubIssueLabelsAction,
  addGithubPullRequestReviewersAction,
  closeGithubIssueAction,
  closeGithubPullRequestAction,
  createGithubIssueCommentAction,
  createGithubPullRequestReviewCommentAction,
  markGithubPullRequestReadyAction,
  mergeGithubPullRequestAction,
  publishGithubPullRequestReviewAction,
  removeGithubIssueAssigneesAction,
  removeGithubIssueLabelAction,
  removeGithubPullRequestReviewersAction,
  reopenGithubIssueAction,
  reopenGithubPullRequestAction,
  replyToGithubPullRequestThreadAction,
  setGithubPullRequestThreadResolutionAction,
  updateGithubPullRequestBranchAction,
} from './triage/mutationOperations.js';
import {
  getGithubTriageEntry,
  listGithubTriageInstancesOperation,
  prepareGithubTriageReviewWorkspace,
  scanGithubTriageSource,
  verifyGithubTriageReviewWorkspace,
} from './triage/operations.js';
import { githubHostingProviderAdapter } from './adapter.js';
import { githubPullRequestAdapter } from './pullRequests/authChain.js';
import { githubRepositoryProvisioningAdapter } from './repositoryProvisioning/createRepositoryWithAuthFallback.js';
import {
  createGithubWebhookActionHandlerV1,
  type GithubWebhookActionHandlerV1,
} from './webhookAction.js';

export const GITHUB_BRAND_RESOURCE_ID = 'brand-icon';

/**
 * The declared source-owned detail renderer, and the UI artifact it mounts.
 *
 * Both identities are re-exported from the Triage contribution module rather than
 * restated: `renderers[].id` is what the contribution's `surfaces.detail` binds and
 * `renderers[].artifact` is what the host looks up in the staged UI graph, and a manifest
 * that swapped them passes contribution conformance and then fails at mount.
 */
export {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
  GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
  GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
};

const sources = TriageSourcesContributionProtocolV1;

/**
 * Every Triage operation materializes the exact configured account through the
 * same purpose-scoped seam, so all five roles carry the same host access.
 */
const TRIAGE_READ_HOST_ACCESS = ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE];

/**
 * Every operation with a configured instance declares its exact account path, so the
 * host binds and revalidates that leaf instead of trusting the field name. `scan` shares
 * the declaration: its published input is a two-arm union — the deliberate shape that
 * makes a mid-scan limit change unrepresentable — and every arm carries the same
 * configured instance, so the bound path is proven for every representable scan request.
 * `listInstances` carries no account at all, because producing account references is what
 * it performs.
 */
const TRIAGE_INSTANCE_ACCOUNT_BINDINGS = [{
  path: 'instance.binding.account',
  purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
}];

const CHANNELS_PLUGIN_ID = 'happier.channels';
const GITHUB_CHANNEL_PROVIDER_CONTRIBUTION_ID = 'github-repository';
const GITHUB_WEBHOOK_ACTION_ID = 'github/accept-webhook';
const GITHUB_CHANNEL_ACTION_IDS = Object.freeze({
  setup: 'github/prepare-repository',
  connectionTest: 'github/inspect-connection',
  endpointResolve: 'github/choose-thread',
  principalResolve: 'github/inspect-principal',
  observationsPoll: 'github/read-comments',
  messageDeliver: 'github/create-comment',
});

/**
 * The GitHub manifest owns the Action's portable structural declaration. The
 * Webhook operation retains its canonical semantic decode in the handler;
 * cross-field delivery checks are not expressible in the data-only authoring
 * algebra and are therefore not reimplemented here.
 */
const GITHUB_WEBHOOK_ACTION_INPUT_SCHEMA = defineProtocolObject({
  v: defineProtocolLiteral(1),
  endpoint: defineProtocolObject({
    webhookContribution: defineProtocolObject({
      pluginId: defineProtocolString(),
      localId: defineProtocolString(),
    }, { policy: 'closed' }),
    sourceInstanceId: defineProtocolString(),
  }, { policy: 'closed' }),
  delivery: defineProtocolObject({
    deliveryId: defineProtocolString(),
    attempt: defineProtocolNumber({ integer: true, minimum: 1 }),
    replay: defineProtocolNumber({ integer: true, minimum: 0 }),
    receivedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
    providerDeliveryId: defineProtocolString(),
  }, { policy: 'closed' }),
  request: defineProtocolObject({
    contentType: defineProtocolString().nullable(),
    headers: defineProtocolArray(defineProtocolObject({
      name: defineProtocolLiteral('x-github-event'),
      value: defineProtocolString(),
    }, { policy: 'closed' }), { maxItems: 1 }),
    rawBodyBytes: defineProtocolNumber({ integer: true, minimum: 0 }),
    rawBodyBase64: defineProtocolString(),
  }, { policy: 'closed' }),
  verified: defineProtocolObject({
    verifier: defineProtocolLiteral('github_hmac_sha256_v1'),
    eventType: defineProtocolString().optional(),
  }, { policy: 'closed' }),
}, { policy: 'closed' });

const GITHUB_WEBHOOK_ACTION_RESULT_SCHEMA = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('settled'),
    disposition: defineProtocolUnion([
      defineProtocolLiteral('accepted'),
      defineProtocolLiteral('ignored'),
    ]),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('retry'),
    code: defineProtocolString(),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('deadLetter'),
    code: defineProtocolString(),
  }, { policy: 'closed' }),
]);

const providers = ConversationProvidersContributionProtocolV1;

type GithubPluginActivationRuntime = Readonly<{
  automationEventObserver: GithubAutomationEventCheckpointedPullObserver;
  webhookActionHandler: GithubWebhookActionHandlerV1;
}>;

const GITHUB_REPOSITORY_INPUT_SCHEMA = {
  type: 'string',
  minLength: 3,
  maxLength: 512,
} as const;

const GITHUB_REPOSITORY_SETUP_INPUT_HINTS = {
  fields: [{
    path: 'credentialRef',
    title: 'GitHub account',
    description: 'Select the GitHub Connected Account used to resolve the repository.',
    widget: 'select',
    required: true,
    requireExplicitSelection: true,
    connectedAccountOptions: true,
  }, {
    path: 'repository',
    title: 'Repository',
    description: 'Enter the GitHub repository as owner/repository.',
    placeholder: 'owner/repository',
    widget: 'text',
    required: true,
  }],
} satisfies ActionInputHints;

const GITHUB_REPOSITORY_SOURCE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    repositoryId: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    owner: { type: 'string', minLength: 1, maxLength: 256 },
    name: { type: 'string', minLength: 1, maxLength: 256 },
    nameWithOwner: { type: 'string', minLength: 3, maxLength: 512 },
  },
  required: ['v', 'repositoryId', 'owner', 'name', 'nameWithOwner'],
} satisfies PluginJsonSchema;

/** Private source facts persisted only through the canonical Automation writer. */
const GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    credentialRef: QualifiedConnectedAccountRefJsonSchema,
    repository: GITHUB_REPOSITORY_SOURCE_CONFIG_SCHEMA,
  },
  required: ['v', 'credentialRef', 'repository'],
} satisfies PluginJsonSchema;

const GITHUB_AUTOMATION_REPOSITORY_SETUP_RESULT_SCHEMA =
  createPluginEventAutomationSetupResultV1JsonSchema(
    GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
    GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
  );

const GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    definition: { type: 'object', additionalProperties: true },
    credentialRef: QualifiedConnectedAccountRefJsonSchema,
  },
  required: ['definition', 'credentialRef'],
} satisfies PluginJsonSchema;

const GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceKey: { type: 'string', minLength: 1, maxLength: 4096 },
    nextEligibleAt: { type: 'integer', minimum: 0 },
  },
  required: ['sourceKey', 'nextEligibleAt'],
} satisfies PluginJsonSchema;

function createGithubPlugin() {
  let activeGithubPluginRuntime: GithubPluginActivationRuntime | null = null;

  function requireActiveGithubPluginRuntime(): GithubPluginActivationRuntime {
    if (activeGithubPluginRuntime === null) {
      throw new Error('GitHub plugin runtime is unavailable outside an active plugin generation');
    }
    return activeGithubPluginRuntime;
  }

  async function runGithubAutomationEventObserver(context: BackgroundServiceContext): Promise<void> {
    await requireActiveGithubPluginRuntime().automationEventObserver.run(context);
  }

  async function runGithubAutomationEventSourceAttempt(
    input: unknown,
    context: PluginInvocationContext,
  ) {
    return await requireActiveGithubPluginRuntime()
      .automationEventObserver.runSourceAttempt(input, context);
  }

  async function receiveGithubWebhook(
    input: unknown,
    context: PluginInvocationContext,
  ) {
    return await requireActiveGithubPluginRuntime().webhookActionHandler(input, context);
  }

  function setupGithubPluginGeneration(): () => void {
    if (activeGithubPluginRuntime !== null) {
      throw new Error('GitHub plugin activation overlap would replace the active plugin generation');
    }
    const runtime = Object.freeze({
      automationEventObserver: createGithubAutomationEventCheckpointedPullObserver(),
      webhookActionHandler: createGithubWebhookActionHandlerV1(),
    });
    activeGithubPluginRuntime = runtime;
    return () => {
      if (activeGithubPluginRuntime === runtime) activeGithubPluginRuntime = null;
    };
  }

  return definePlugin({
  id: GITHUB_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'GitHub SCM hosting provider',
  description: 'Detects GitHub remotes and provides GitHub repository operations.',
  brand: { iconResourceId: GITHUB_BRAND_RESOURCE_ID },
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'github-api',
      capability: 'network',
      reason: 'Access the GitHub origin selected from the SCM provider and connected account.',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://api.github.com' },
          { kind: 'scmProviderOrigin', provider: 'github' },
          { kind: 'connectedAccountOrigin', service: 'github-account' },
        ],
        // The host revalidates the exact origin AND method at dispatch, so a verb a
        // declared Action consumes but this grant omits is rejected as
        // `plugin_final_resource_not_selected` before it reaches GitHub — where no
        // unit test with a mocked client can see it. `PUT` is merge and
        // update-branch, `PATCH` is close/reopen, `POST` is the reviewer request
        // and the one GraphQL transition, and `DELETE` is the reviewer
        // withdrawal — the only declared Action that consumes it. No verb is
        // granted "for symmetry".
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      },
    }, {
      id: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize only the exact selected GitHub Connected Account for GitHub API requests.',
      scope: {
        serviceRefs: ['github-account'],
        operations: ['select', 'use'],
        materializationKinds: ['httpHeaders'],
      },
    }, {
      id: 'automation-event-checkpoint-storage',
      capability: 'storage.account',
      reason: 'Persist one GitHub Event checkpoint per authenticated Automation trigger source.',
      scope: { enabled: true },
    }],
    optional: [],
  },
  accountCollections: {
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID]: GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  },
  resources: {
    [GITHUB_BRAND_RESOURCE_ID]: {
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
  },
  ui: {
    views: [],
    renderers: [{
      id: GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
      kind: 'reactNative',
      artifact: GITHUB_TRIAGE_DETAIL_ARTIFACT_ID_V1,
      // The detail body reads through this plugin's own Actions, so a mount without
      // them would render an empty shell rather than a useful surface.
      requiredHostMethods: ['executeAction'],
    }, {
      id: GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
      kind: 'reactNative',
      artifact: GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1,
      // The page's entire purpose is two Action invocations — this source's own
      // discovery read and the target-owned administration write. A mount that
      // cannot execute Actions could only render an inert list.
      requiredHostMethods: ['executeAction'],
    }],
    settingsGroups: [{
      id: GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1,
      title: { key: 'plugins.github.settings.group', fallback: 'GitHub' },
      icon: 'settings',
      defaultRank: 40,
    }],
    settingsPages: [{
      id: GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
      group: { kind: 'plugin', localId: GITHUB_TRIAGE_SETTINGS_GROUP_ID_V1 },
      title: { key: 'plugins.github.settings.sources', fallback: 'PRs & Issues' },
      subtitle: {
        key: 'plugins.github.settings.sources.subtitle',
        fallback: 'Choose which GitHub accounts and repositories appear in PRs & Issues.',
      },
      keywords: ['github', 'pull requests', 'issues', 'triage'],
      icon: 'settings',
      defaultRank: 10,
      renderer: GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
    }],
    translations: [
      { locale: 'en', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["en"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["en"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PRs & Issues', 'plugins.github.settings.sources.subtitle': 'Choose which GitHub accounts and repositories appear in PRs & Issues.', 'github.automation.historyGapReset.confirmation.title': 'Start a new baseline', 'github.automation.historyGapReset.confirmation.body': 'Events in the history gap are not replayed.' } },
      { locale: 'ru', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["ru"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["ru"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR и задачи', 'plugins.github.settings.sources.subtitle': 'Выберите учетные записи и репозитории GitHub, которые будут отображаться в разделе PR и задач.', 'github.automation.historyGapReset.confirmation.title': 'Начать с новой базовой точки', 'github.automation.historyGapReset.confirmation.body': 'События из пропуска в истории не воспроизводятся.' } },
      { locale: 'pl', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["pl"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["pl"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR-y i zgłoszenia', 'plugins.github.settings.sources.subtitle': 'Wybierz konta i repozytoria GitHub wyświetlane w sekcji PR-ów i zgłoszeń.', 'github.automation.historyGapReset.confirmation.title': 'Rozpocznij od nowej linii bazowej', 'github.automation.historyGapReset.confirmation.body': 'Zdarzenia z luki w historii nie zostaną odtworzone.' } },
      { locale: 'es', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["es"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["es"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR e incidencias', 'plugins.github.settings.sources.subtitle': 'Elige qué cuentas y repositorios de GitHub aparecen en PR e incidencias.', 'github.automation.historyGapReset.confirmation.title': 'Iniciar una nueva referencia', 'github.automation.historyGapReset.confirmation.body': 'Los eventos del intervalo perdido del historial no se reproducirán.' } },
      { locale: 'fr', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["fr"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["fr"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR et tickets', 'plugins.github.settings.sources.subtitle': 'Choisissez les comptes et dépôts GitHub affichés dans PR et tickets.', 'github.automation.historyGapReset.confirmation.title': 'Démarrer une nouvelle référence', 'github.automation.historyGapReset.confirmation.body': 'Les événements manquants dans l’historique ne sont pas rejoués.' } },
      { locale: 'it', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["it"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["it"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR e segnalazioni', 'plugins.github.settings.sources.subtitle': 'Scegli gli account e i repository GitHub da mostrare in PR e segnalazioni.', 'github.automation.historyGapReset.confirmation.title': 'Avvia un nuovo riferimento', 'github.automation.historyGapReset.confirmation.body': 'Gli eventi mancanti nella cronologia non vengono riprodotti.' } },
      { locale: 'pt', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["pt"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["pt"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PRs e problemas', 'plugins.github.settings.sources.subtitle': 'Escolha as contas e os repositórios GitHub apresentados em PRs e problemas.', 'github.automation.historyGapReset.confirmation.title': 'Iniciar uma nova referência', 'github.automation.historyGapReset.confirmation.body': 'Os eventos em falta no histórico não são reproduzidos.' } },
      { locale: 'ca', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["ca"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["ca"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR i incidències', 'plugins.github.settings.sources.subtitle': 'Tria els comptes i repositoris de GitHub que es mostren a PR i incidències.', 'github.automation.historyGapReset.confirmation.title': 'Inicia una referència nova', 'github.automation.historyGapReset.confirmation.body': 'Els esdeveniments del buit de l’historial no es tornen a reproduir.' } },
      { locale: 'zh-Hans', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["zh-Hans"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["zh-Hans"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR 和问题', 'plugins.github.settings.sources.subtitle': '选择要在 PR 和问题中显示的 GitHub 帐户和仓库。', 'github.automation.historyGapReset.confirmation.title': '开始新的基准', 'github.automation.historyGapReset.confirmation.body': '不会重放历史缺口中的事件。' } },
      { locale: 'zh-Hant', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["zh-Hant"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["zh-Hant"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR 與問題', 'plugins.github.settings.sources.subtitle': '選擇要在 PR 與問題中顯示的 GitHub 帳戶和儲存庫。', 'github.automation.historyGapReset.confirmation.title': '開始新的基準', 'github.automation.historyGapReset.confirmation.body': '不會重播歷史缺口中的事件。' } },
      { locale: 'ja', messages: { ...GITHUB_RENDER_UI_TRANSLATIONS["ja"], ...GITHUB_ADDITIONAL_UI_TRANSLATIONS["ja"], 'plugins.github.settings.group': 'GitHub', 'plugins.github.settings.sources': 'PR と課題', 'plugins.github.settings.sources.subtitle': 'PR と課題に表示する GitHub アカウントとリポジトリを選択します。', 'github.automation.historyGapReset.confirmation.title': '新しい基準点を開始', 'github.automation.historyGapReset.confirmation.body': '履歴の欠落区間にあるイベントは再実行されません。' } },
    ],
  },
  actions: {
    [GITHUB_TRIAGE_ACTION_IDS_V1.listInstances]: {
      title: 'Discover GitHub accounts',
      description: 'Lists the GitHub accounts each authorized connection can reach.',
      scopes: ['global'],
      surfaces: sources.operations.listInstances.declaration.surfaces,
      // Mounted-only placement. `plugin` stays because the Triage daemon
      // consumes it and `ui` because this source's own mounted surfaces hold
      // present-user authority; the explicit empty list only withdraws the
      // Action from global placement discovery — it disables no invocation.
      placementBindings: [],
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      execution: { target: 'daemon' },
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      run: listGithubTriageInstancesOperation,
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.scan]: {
      title: 'Scan GitHub pull requests and issues',
      description: 'Reads one bounded page of GitHub pull requests and issues for a configured account.',
      scopes: ['global'],
      surfaces: sources.operations.scan.declaration.surfaces,
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      execution: { target: 'daemon' },
      inputSchema: sources.operations.scan.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: scanGithubTriageSource,
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.get]: {
      title: 'Read one GitHub pull request or issue',
      description: 'Authoritatively reads one GitHub pull request or issue for a configured account.',
      scopes: ['global'],
      surfaces: sources.operations.get.declaration.surfaces,
      // Mounted-only placement. `plugin` stays because the Triage daemon
      // consumes it and `ui` because this source's own mounted surfaces hold
      // present-user authority; the explicit empty list only withdraws the
      // Action from global placement discovery — it disables no invocation.
      placementBindings: [],
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      execution: { target: 'daemon' },
      inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: getGithubTriageEntry,
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.prepareReviewWorkspace]: {
      title: 'Prepare a GitHub pull-request review workspace',
      description: 'Rereads one GitHub pull request and prepares its source branch in the selected workspace.',
      scopes: ['global'],
      surfaces: sources.operations.prepareReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.prepareReviewWorkspace.declaration.dangerLevel,
      execution: { target: 'daemon' },
      inputSchema: sources.operations.prepareReviewWorkspace.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.prepareReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: prepareGithubTriageReviewWorkspace,
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.verifyReviewWorkspace]: {
      title: 'Verify a GitHub pull-request review workspace',
      description: 'Rereads one GitHub pull request and verifies the prepared workspace still has its exact head.',
      scopes: ['global'],
      surfaces: sources.operations.verifyReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.verifyReviewWorkspace.declaration.dangerLevel,
      execution: { target: 'daemon' },
      inputSchema: sources.operations.verifyReviewWorkspace.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.verifyReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: verifyGithubTriageReviewWorkspace,
    },
    // The five source-native detail planes. Only this source's own mounted
    // detail body invokes them, through the mounted Plugin UI host — present
    // user authority — so they declare `ui` and nothing else, and the explicit
    // empty placement list keeps global discovery from offering them a
    // destination while the mounted invocation stays untouched.
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline]: {
      title: 'Read a GitHub timeline page',
      description: 'Reads one bounded page of the event timeline of one pull request or issue.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubTimelineInputV1Schema.jsonSchema,
      resultSchema: GithubTimelineResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MOUNTED_DETAIL_DEADLINE_MS, listGithubTimeline),
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles]: {
      title: 'Read a GitHub changed-file page',
      description: 'Reads one bounded page of the files one pull request changes, with their'
        + ' counts and whether GitHub supplied a patch for each.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubChangedFilesInputV1Schema.jsonSchema,
      resultSchema: GithubChangedFilesResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MOUNTED_DETAIL_DEADLINE_MS, listGithubChangedFiles),
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback]: {
      title: 'Read one GitHub feedback connection',
      description: 'Reads one independently paged pull-request feedback connection: issue comments,'
        + ' review threads, review bodies, outstanding requests, or one thread\'s earlier replies.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubFeedbackInputV1Schema.jsonSchema,
      resultSchema: GithubFeedbackResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MOUNTED_DETAIL_DEADLINE_MS, readGithubFeedback),
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks]: {
      title: 'Read the GitHub checks of a pull request',
      description: 'Reads the check runs and commit statuses of one pull request at its current'
        + ' head revision.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubChecksInputV1Schema.jsonSchema,
      resultSchema: GithubChecksResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MOUNTED_DETAIL_DEADLINE_MS, readGithubChecks),
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readReviews]: {
      title: 'Read the GitHub reviews of a pull request',
      description: 'Reads who has reviewed one pull request and whose review is still awaited,'
        + ' from the two review resources GitHub publishes them on.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: [],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubReviewsInputV1Schema.jsonSchema,
      resultSchema: GithubReviewsResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MOUNTED_DETAIL_DEADLINE_MS, readGithubReviews),
    },
    // The bound pull-request and issue mutations. Omitting `agent` and `mcp` is
    // the human gate: it makes them unreachable from an agent at all, which is a
    // stronger guarantee than flooring a danger level to a prompt.
    //
    // `ui` is the only other surface and it is the product's whole reach for
    // these writes: the daemon ingress derives the invoking surface from the
    // authenticated mounted-UI provenance, so a mounted Plugin UI press is
    // admitted as UI authority while direct plugin code — ActionsService —
    // checks only the `plugin` surface and is refused here. Each declares the
    // same `github-api` grant and the same connected-account purpose as every
    // read, and rebinds the exact configured account.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge]: {
      title: 'Merge this pull request',
      description: 'Merges one GitHub pull request at the exact head revision you are looking at,'
        + ' using a merge method this repository allows.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'destructive',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.merge.confirmation.title',
          fallback: 'Merge this pull request?',
        },
        body: {
          key: 'plugins.github.mutations.merge.confirmation.body',
          fallback: 'This merges the commits you are looking at into the base branch on GitHub.'
            + ' If new commits were pushed since, the merge is refused instead.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.merge.confirmation.confirmLabel',
          fallback: 'Merge',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestMergeInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestMergeResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, mergeGithubPullRequestAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose]: {
      title: 'Close this pull request',
      description: 'Closes one open GitHub pull request without merging it. Its branch and commits'
        + ' are left untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.close.confirmation.title',
          fallback: 'Close this pull request?',
        },
        body: {
          key: 'plugins.github.mutations.close.confirmation.body',
          fallback: 'It is closed on GitHub without merging. You can reopen it afterwards.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.close.confirmation.confirmLabel',
          fallback: 'Close',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestCloseInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, closeGithubPullRequestAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen]: {
      title: 'Reopen this pull request',
      description: 'Reopens one closed, unmerged GitHub pull request.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.reopen.confirmation.title',
          fallback: 'Reopen this pull request?',
        },
        body: {
          key: 'plugins.github.mutations.reopen.confirmation.body',
          fallback: 'It becomes open again on GitHub, and its checks and reviewers are notified.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.reopen.confirmation.confirmLabel',
          fallback: 'Reopen',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestReopenInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, reopenGithubPullRequestAction),
    },
    // Draft → ready and a reviewer request are `externalSideEffect` rather than
    // `writesRemote` because the effect a person feels is the NOTIFICATION
    // fan-out, not the field that changed. Update-branch and a withdrawal move
    // remote state and summon nobody, so they are `writesRemote`.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady]: {
      title: 'Mark this pull request ready for review',
      description: 'Takes one GitHub pull request out of draft at the exact head revision you are'
        + ' looking at, which notifies every requested reviewer and starts its checks.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.markReady.confirmation.title',
          fallback: 'Mark this pull request ready for review?',
        },
        body: {
          key: 'plugins.github.mutations.markReady.confirmation.body',
          fallback: 'Every requested reviewer is notified and its checks run against the commits'
            + ' you are looking at. If new commits were pushed since, this is refused instead.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.markReady.confirmation.confirmLabel',
          fallback: 'Mark ready',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestMarkReadyInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestMarkReadyResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, markGithubPullRequestReadyAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview]: {
      title: 'Submit this pull request review',
      description: 'Publishes one canonical Happier review proposal and its verdict against the exact base and head revisions you are looking at.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.review.confirmation.title',
          fallback: 'Submit this review?',
        },
        body: {
          key: 'plugins.github.mutations.review.confirmation.body',
          fallback: 'This publishes the selected review proposal and verdict on GitHub. If the pull request comparison moved, nothing is written.',
        },
        confirmLabel: {
          key: 'plugins.github.ui.mutations.review.submit',
          fallback: 'Submit review',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestReviewPublicationInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, publishGithubPullRequestReviewAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReviewCommentCreate]: {
      title: 'Publish this pull request review comment',
      description: 'Publishes one canonical Happier review proposal at its exact pinned GitHub diff anchor.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      confirmation: {
        title: { key: 'plugins.github.mutations.reviewCommentCreate.confirmation.title', fallback: 'Publish this review comment?' },
        body: { key: 'plugins.github.mutations.reviewCommentCreate.confirmation.body', fallback: 'This posts the selected comment on GitHub at the exact pull request comparison you reviewed.' },
        confirmLabel: { key: 'plugins.github.mutations.reviewCommentCreate.confirmation.confirmLabel', fallback: 'Publish comment' },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestReviewCommentCreateInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewCommentCreateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, createGithubPullRequestReviewCommentAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadReply]: {
      title: 'Reply to this pull request review thread',
      description: 'Publishes one canonical Happier proposal as a reply to the exact GitHub review thread.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.github.mutations.threadReply.confirmation.title', fallback: 'Post this thread reply?' },
        body: { key: 'plugins.github.mutations.threadReply.confirmation.body', fallback: 'This reply becomes visible in the selected GitHub review conversation.' },
        confirmLabel: { key: 'plugins.github.mutations.threadReply.confirmation.confirmLabel', fallback: 'Post reply' },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestThreadReplyInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestThreadReplyResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, replyToGithubPullRequestThreadAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueComment]: {
      title: 'Comment on this GitHub issue',
      description: 'Publishes one canonical Happier proposal into the exact GitHub issue conversation.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.github.mutations.issueComment.confirmation.title', fallback: 'Post this issue comment?' },
        body: { key: 'plugins.github.mutations.issueComment.confirmation.body', fallback: 'This comment becomes visible in the selected GitHub issue conversation.' },
        confirmLabel: { key: 'plugins.github.mutations.issueComment.confirmation.confirmLabel', fallback: 'Post comment' },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueCommentInputV1Schema.jsonSchema,
      resultSchema: GithubIssueCommentResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, createGithubIssueCommentAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestUpdateBranch]: {
      title: 'Update this branch',
      description: 'Merges the base branch into one GitHub pull request’s branch, guarded by the'
        + ' exact head revision you are looking at.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.updateBranch.confirmation.title',
          fallback: 'Update this branch?',
        },
        body: {
          key: 'plugins.github.mutations.updateBranch.confirmation.body',
          fallback: 'GitHub merges the base branch into this pull request and adds a commit on top'
            + ' of the ones you are looking at. If new commits were pushed since, this is refused'
            + ' instead.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.updateBranch.confirmation.confirmLabel',
          fallback: 'Update branch',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestUpdateBranchInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestUpdateBranchResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, updateGithubPullRequestBranchAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAddReviewers]: {
      title: 'Request review from people',
      description: 'Asks exactly the named GitHub users and teams to review this pull request,'
        + ' leaving reviewers somebody else requested untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.addReviewers.confirmation.title',
          fallback: 'Request review from these people?',
        },
        body: {
          key: 'plugins.github.mutations.addReviewers.confirmation.body',
          fallback: 'Everyone you named is asked to review this pull request on GitHub and is'
            + ' notified. Reviewers somebody else requested are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.addReviewers.confirmation.confirmLabel',
          fallback: 'Request review',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestAddReviewersInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewersResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, addGithubPullRequestReviewersAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRemoveReviewers]: {
      title: 'Withdraw review requests',
      description: 'Stops asking exactly the named GitHub users and teams to review this pull'
        + ' request, leaving every reviewer you did not name untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.removeReviewers.confirmation.title',
          fallback: 'Withdraw these review requests?',
        },
        body: {
          key: 'plugins.github.mutations.removeReviewers.confirmation.body',
          fallback: 'Everyone you named stops being asked to review this pull request on GitHub.'
            + ' Reviewers you did not name are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.removeReviewers.confirmation.confirmLabel',
          fallback: 'Withdraw',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestRemoveReviewersInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewersResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, removeGithubPullRequestReviewersAction),
    },
    // Review-thread resolution is `writesRemote`, not `externalSideEffect`: it
    // moves state everyone watching the pull request can see and summons nobody.
    // It is ONE Action for both directions because `resolved` is the state the
    // caller wants rather than a verb — a second call converges on the same state
    // instead of creating a second object — and because the reopen half must
    // exist at all: a thread resolved by mistake has to be reopenable from here.
    // Its copy therefore names both directions instead of asserting one, which is
    // the honest reading of a static confirmation over a two-direction Action.
    //
    // It carries no head pin. A thread is anchored to a comment, not to a commit,
    // so a push between the read and the write changes nothing about which
    // conversation this is.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadResolution]: {
      title: 'Resolve or reopen a review conversation',
      description: 'Marks one line-anchored review thread on this GitHub pull request resolved,'
        + ' or reopens one that was resolved.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.threadResolution.confirmation.title',
          fallback: 'Change this review conversation?',
        },
        body: {
          key: 'plugins.github.mutations.threadResolution.confirmation.body',
          fallback: 'Resolving a thread collapses it for everyone who can see this pull request,'
            + ' and reopening one brings the conversation back. Whichever you chose is applied on'
            + ' GitHub, and you can change it back afterwards.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.threadResolution.confirmation.confirmLabel',
          fallback: 'Continue',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubPullRequestThreadResolutionInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestThreadResolutionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, setGithubPullRequestThreadResolutionAction),
    },
    // The issue writes. Each is `writesRemote`: it moves remote state, summons
    // nobody, and is reversible through the Action that undoes it. Every one of
    // them is an exact transition or an exact delta — none can express a desired
    // full set, so a concurrent unrelated assignee or label always survives.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueClose]: {
      title: 'Close this issue',
      description: 'Closes one open GitHub issue with the reason you choose, which everyone watching it sees.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueClose.confirmation.title',
          fallback: 'Close this issue?',
        },
        body: {
          key: 'plugins.github.mutations.issueClose.confirmation.body',
          fallback: 'It is closed on GitHub with the reason you chose, and everyone watching it is notified. You can reopen it afterwards.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueClose.confirmation.confirmLabel',
          fallback: 'Close',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueCloseInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, closeGithubIssueAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueReopen]: {
      title: 'Reopen this issue',
      description: 'Reopens one closed GitHub issue.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueReopen.confirmation.title',
          fallback: 'Reopen this issue?',
        },
        body: {
          key: 'plugins.github.mutations.issueReopen.confirmation.body',
          fallback: 'It becomes open again on GitHub, and everyone watching it is notified.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueReopen.confirmation.confirmLabel',
          fallback: 'Reopen',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueReopenInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, reopenGithubIssueAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeAdd]: {
      title: 'Assign people to this issue',
      description: 'Assigns exactly the named GitHub users to this issue, leaving everyone somebody else assigned untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueAssigneeAdd.confirmation.title',
          fallback: 'Assign these people?',
        },
        body: {
          key: 'plugins.github.mutations.issueAssigneeAdd.confirmation.body',
          fallback: 'Everyone you named is assigned to this issue on GitHub and is notified. People somebody else assigned are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueAssigneeAdd.confirmation.confirmLabel',
          fallback: 'Assign',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueAssigneeAddInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, addGithubIssueAssigneesAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeRemove]: {
      title: 'Unassign people from this issue',
      description: 'Unassigns exactly the named GitHub users from this issue, leaving everyone you did not name untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueAssigneeRemove.confirmation.title',
          fallback: 'Unassign these people?',
        },
        body: {
          key: 'plugins.github.mutations.issueAssigneeRemove.confirmation.body',
          fallback: 'Everyone you named stops being assigned to this issue on GitHub. People you did not name are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueAssigneeRemove.confirmation.confirmLabel',
          fallback: 'Unassign',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueAssigneeRemoveInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, removeGithubIssueAssigneesAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelAdd]: {
      title: 'Add labels to this issue',
      description: 'Adds exactly the named labels to this issue, leaving every label somebody else added untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueLabelAdd.confirmation.title',
          fallback: 'Add these labels?',
        },
        body: {
          key: 'plugins.github.mutations.issueLabelAdd.confirmation.body',
          fallback: 'Exactly the labels you named are added to this issue on GitHub. Labels somebody else added are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueLabelAdd.confirmation.confirmLabel',
          fallback: 'Add labels',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueLabelAddInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, addGithubIssueLabelsAction),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelRemove]: {
      title: 'Remove a label from this issue',
      description: 'Removes exactly one named label from this issue, leaving every other label untouched.',
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueLabelRemove.confirmation.title',
          fallback: 'Remove this label?',
        },
        body: {
          key: 'plugins.github.mutations.issueLabelRemove.confirmation.body',
          fallback: 'Exactly the label you named is removed from this issue on GitHub. Every other label is left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueLabelRemove.confirmation.confirmLabel',
          fallback: 'Remove label',
        },
      },
      execution: { target: 'daemon' },
      inputSchema: GithubIssueLabelRemoveInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: withGithubInvocationDeadline(GITHUB_MUTATION_DEADLINE_MS, removeGithubIssueLabelAction),
    },
    [GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID]: {
      title: 'Run GitHub repository Event source attempt',
      description: 'Runs one GitHub repository Event source attempt.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_INPUT_SCHEMA,
      resultSchema: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_RESULT_SCHEMA,
      hostAccess: [
        'github-api',
        GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        'automation-event-checkpoint-storage',
      ],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      run: runGithubAutomationEventSourceAttempt,
    },
    [GITHUB_WEBHOOK_ACTION_ID]: {
      title: 'Receive GitHub webhook',
      description: 'Receives one GitHub webhook delivery for processing.',
      scopes: ['global'],
      inputSchema: GITHUB_WEBHOOK_ACTION_INPUT_SCHEMA,
      resultSchema: GITHUB_WEBHOOK_ACTION_RESULT_SCHEMA,
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      run: receiveGithubWebhook,
    },
    [GITHUB_CHANNEL_ACTION_IDS.setup]: {
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          credentialRef: QualifiedConnectedAccountRefJsonSchema,
          repository: GITHUB_REPOSITORY_INPUT_SCHEMA,
        },
        required: ['credentialRef', 'repository'],
      },
      title: 'Set up GitHub Channels',
      description: 'Verifies the selected GitHub repository for Channels setup.',
      scopes: ['global'],
      resultSchema: providers.operations.setup.declaration.resultSchema.jsonSchema,
      surfaces: providers.operations.setup.declaration.surfaces,
      inputHints: GITHUB_REPOSITORY_SETUP_INPUT_HINTS,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.setup.declaration.dangerLevel,
      execution: { target: 'daemon' },
      run: setupGithubChannels,
    },
    [GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID]: {
      title: 'Set up GitHub repository Event source',
      description: 'Resolves a GitHub repository to immutable source facts for an Automation Event.',
      scopes: ['global'],
      surfaces: ['plugin'],
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          credentialRef: QualifiedConnectedAccountRefJsonSchema,
          repository: GITHUB_REPOSITORY_INPUT_SCHEMA,
        },
        required: ['credentialRef', 'repository'],
      },
      inputHints: GITHUB_REPOSITORY_SETUP_INPUT_HINTS,
      resultSchema: GITHUB_AUTOMATION_REPOSITORY_SETUP_RESULT_SCHEMA,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      run: setupGithubRepositoryEventSource,
    },
    [GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID]: {
      title: 'Start a new GitHub repository Event baseline',
      description: 'Explicitly replaces a GitHub Event history gap with an authenticated current-head baseline. Events in the gap are not replayed.',
      scopes: ['global'],
      surfaces: ['plugin'],
      confirmation: {
        title: {
          key: 'github.automation.historyGapReset.confirmation.title',
          fallback: 'Start a new baseline',
        },
        body: {
          key: 'github.automation.historyGapReset.confirmation.body',
          fallback: 'Events in the history gap are not replayed.',
        },
      },
      inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
      resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE, 'automation-event-checkpoint-storage'],
      dangerLevel: 'writesLocal',
      execution: { target: 'daemon' },
      run: resetGithubRepositoryEventHistoryGap,
    },
    [GITHUB_CHANNEL_ACTION_IDS.connectionTest]: {
      inputSchema: providers.operations.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.connectionTest.declaration.resultSchema.jsonSchema,
      title: 'Test GitHub Channel connection',
      description: 'Tests the selected GitHub Channel connection.',
      scopes: ['global'],
      surfaces: providers.operations.connectionTest.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.connectionTest.declaration.dangerLevel,
      execution: { target: 'daemon' },
      run: testGithubChannelConnection,
    },
    [GITHUB_CHANNEL_ACTION_IDS.endpointResolve]: {
      inputSchema: providers.operations.endpointResolve.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.endpointResolve.declaration.resultSchema.jsonSchema,
      title: 'Resolve GitHub issue or pull request',
      description: 'Resolves a GitHub issue or pull request destination.',
      scopes: ['global'],
      surfaces: providers.operations.endpointResolve.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.endpointResolve.declaration.dangerLevel,
      execution: { target: 'daemon' },
      run: resolveGithubChannelEndpoint,
    },
    [GITHUB_CHANNEL_ACTION_IDS.principalResolve]: {
      inputSchema: providers.operations.principalResolve.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.principalResolve.declaration.resultSchema.jsonSchema,
      title: 'Resolve GitHub principal',
      description: 'Resolves a GitHub principal for the selected repository.',
      scopes: ['global'],
      surfaces: providers.operations.principalResolve.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.principalResolve.declaration.dangerLevel,
      execution: { target: 'daemon' },
      run: resolveGithubChannelPrincipal,
    },
    [GITHUB_CHANNEL_ACTION_IDS.observationsPoll]: {
      inputSchema: providers.operations.observationsPoll.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.observationsPoll.declaration.resultSchema.jsonSchema,
      title: 'Poll GitHub issue comments',
      description: 'Polls the selected GitHub issue or pull request for new comments.',
      scopes: ['global'],
      surfaces: providers.operations.observationsPoll.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.observationsPoll.declaration.dangerLevel,
      execution: { target: 'daemon' },
      run: pollGithubChannelObservations,
    },
    [GITHUB_CHANNEL_ACTION_IDS.messageDeliver]: {
      inputSchema: providers.operations.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.messageDeliver.declaration.resultSchema.jsonSchema,
      title: 'Deliver GitHub issue or pull-request comment',
      description: 'Delivers a comment to the selected GitHub issue or pull request.',
      scopes: ['global'],
      surfaces: providers.operations.messageDeliver.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.messageDeliver.declaration.dangerLevel,
      execution: { target: 'daemon' },
      run: deliverGithubChannelMessage,
    },
  },
  webhooks: {
    [GITHUB_WEBHOOK_CONTRIBUTION_ID]: {
      title: 'GitHub webhook delivery',
      description: 'Receives verified GitHub webhook deliveries.',
      verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' },
      handlerAction: { localId: GITHUB_WEBHOOK_ACTION_ID },
    },
  },
  events: Object.fromEntries(GITHUB_AUTOMATION_EVENT_CATALOG.map((event) => [
    event.localId,
    {
      declaration: {
        kind: 'event',
        title: event.title,
        description: event.description,
        payloadSchema: event.payloadSchema,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
            supportedObservationTransports: ['checkpointedPull', 'durablePush'],
            webhookContributionRef: {
              pluginId: GITHUB_PLUGIN_ID,
              localId: GITHUB_WEBHOOK_CONTRIBUTION_ID,
            },
            sourceConfigSchema: GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
            setupActionRef: {
              pluginId: GITHUB_PLUGIN_ID,
              localId: GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID,
            },
            historyGapResetActionRef: {
              pluginId: GITHUB_PLUGIN_ID,
              localId: GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID,
            },
            connectedAccountPurposeBindings: [{
              path: 'credentialRef',
              purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
            }],
          },
        },
      },
    },
  ])),
  backgroundServices: [{
    declaration: {
      id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
      title: 'GitHub repository Event observer',
    },
    runner: runGithubAutomationEventObserver,
  }],
  scmHostingProviders: {
    [GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID]: {
      declaration: {
        title: 'GitHub',
        description: 'GitHub Cloud and configured GitHub Enterprise repositories.',
        kind: 'github',
        capabilities: ['detect', 'clone', 'fetch', 'push', 'pullRequest'],
        authService: GITHUB_CONNECTED_ACCOUNT_ID,
      },
      runtime: {
        adapter: Object.freeze({
          routing: githubHostingProviderAdapter,
          pullRequests: githubPullRequestAdapter,
          pullRequestCheckout: githubPullRequestAdapter,
          repositoryPublishing: githubRepositoryProvisioningAdapter,
          repositoryClone: githubRepositoryProvisioningAdapter,
        }),
      },
    },
  },
  connectedAccountDescriptors: {
    [GITHUB_CONNECTED_ACCOUNT_ID]: {
      declaration: {
        title: 'GitHub account',
        description: 'GitHub account used for repository and pull-request operations.',
        authentication: {
          defaultModeId: 'fine-grained-pat',
          modes: [{
            id: 'fine-grained-pat',
            kind: 'manual',
            title: 'Fine-grained personal access token',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Fine-grained personal access token',
              description: 'A GitHub fine-grained personal access token with access to the repositories you use in Happier.',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }],
        },
        capabilities: ['scmHostingToken'],
      },
      runtime: githubConnectedAccountRuntime,
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1]: sources.contribute({
          descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
          operations: {
            listInstances: sources.operations.listInstances
              .bind(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances),
            scan: sources.operations.scan.bind(GITHUB_TRIAGE_ACTION_IDS_V1.scan),
            get: sources.operations.get.bind(GITHUB_TRIAGE_ACTION_IDS_V1.get),
            prepareReviewWorkspace: sources.operations.prepareReviewWorkspace
              .bind(GITHUB_TRIAGE_ACTION_IDS_V1.prepareReviewWorkspace),
            verifyReviewWorkspace: sources.operations.verifyReviewWorkspace
              .bind(GITHUB_TRIAGE_ACTION_IDS_V1.verifyReviewWorkspace),
          },
          surfaces: { detail: { renderer: GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1 } },
        }),
      },
    },
    [CHANNELS_PLUGIN_ID]: {
      [CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1]: {
        [GITHUB_CHANNEL_PROVIDER_CONTRIBUTION_ID]: providers.contribute({
          operations: {
            setup: providers.operations.setup.bind(GITHUB_CHANNEL_ACTION_IDS.setup),
            connectionTest: providers.operations.connectionTest.bind(GITHUB_CHANNEL_ACTION_IDS.connectionTest),
            endpointResolve: providers.operations.endpointResolve.bind(GITHUB_CHANNEL_ACTION_IDS.endpointResolve),
            principalResolve: providers.operations.principalResolve.bind(GITHUB_CHANNEL_ACTION_IDS.principalResolve),
            observationsPoll: providers.operations.observationsPoll.bind(GITHUB_CHANNEL_ACTION_IDS.observationsPoll),
            messageDeliver: providers.operations.messageDeliver.bind(GITHUB_CHANNEL_ACTION_IDS.messageDeliver),
          },
        }),
      },
    },
  },
  setup: setupGithubPluginGeneration,
  });
}

export const GITHUB_PLUGIN = createGithubPlugin();

export const PLUGIN_MANIFEST = GITHUB_PLUGIN.manifest;

/**
 * The executable half of the declared Account Collections. The host projects
 * this against the parsed manifest declarations before a candidate may load,
 * so it must travel with the manifest rather than be derived by consumers.
 */
export const collectionMigrations = GITHUB_PLUGIN.collectionMigrations;
