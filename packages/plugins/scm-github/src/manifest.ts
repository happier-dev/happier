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
  GITHUB_AUTOMATION_REPOSITORY_EVENT_ID,
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
  GithubCommentsInputV1Schema,
  GithubCommentsResultV1Schema,
  GithubTimelineInputV1Schema,
  GithubTimelineResultV1Schema,
} from './triage/detail/contracts.js';
import {
  listGithubChangedFiles,
  listGithubComments,
  listGithubTimeline,
  readGithubChecks,
} from './triage/detailOperations.js';
import {
  getGithubTriageEntry,
  listGithubTriageInstancesOperation,
  scanGithubTriageSource,
} from './triage/operations.js';
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
  GITHUB_TRIAGE_SETTINGS_ARTIFACT_ID_V1,
  GITHUB_TRIAGE_SETTINGS_PAGE_ID_V1,
  GITHUB_TRIAGE_SETTINGS_RENDERER_ID_V1,
};

const sources = TriageSourcesContributionProtocolV1;

/**
 * Every Triage read materializes the exact configured account through the same
 * purpose-scoped seam, so all three roles carry the same host access.
 */
const TRIAGE_READ_HOST_ACCESS = ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE];

/**
 * Both reads declare the exact account path their configured instance carries, so the
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

const GITHUB_AUTOMATION_REPOSITORY_SETUP_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'integer', const: 1 },
    sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
    sourceContractVersion: {
      type: 'integer',
      const: GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
    },
    sourceConfig: GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
    displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
  },
  required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
} satisfies PluginJsonSchema;

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

const GITHUB_AUTOMATION_REPOSITORY_EVENT_REPOSITORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repositoryId: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
    nameWithOwner: { type: 'string', minLength: 3, maxLength: 512 },
  },
  required: ['repositoryId', 'nameWithOwner'],
} satisfies PluginJsonSchema;

const GITHUB_AUTOMATION_REPOSITORY_EVENT_PAYLOAD_SCHEMA = {
  oneOf: [{
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'push' },
      eventId: { type: 'string', minLength: 1, maxLength: 512 },
      occurredAtMs: { type: 'integer', minimum: 0 },
      repository: GITHUB_AUTOMATION_REPOSITORY_EVENT_REPOSITORY_SCHEMA,
      ref: { type: 'string', minLength: 1, maxLength: 512 },
      before: { type: 'string', minLength: 1, maxLength: 512 },
      after: { type: 'string', minLength: 1, maxLength: 512 },
    },
    required: ['kind', 'eventId', 'occurredAtMs', 'repository', 'ref', 'before', 'after'],
  }, {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'issueOpened' },
      eventId: { type: 'string', minLength: 1, maxLength: 512 },
      occurredAtMs: { type: 'integer', minimum: 0 },
      repository: GITHUB_AUTOMATION_REPOSITORY_EVENT_REPOSITORY_SCHEMA,
      issue: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
          number: { type: 'integer', minimum: 1 },
          title: { type: 'string', maxLength: 1024 },
        },
        required: ['id', 'number', 'title'],
      },
    },
    required: ['kind', 'eventId', 'occurredAtMs', 'repository', 'issue'],
  }, {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { const: 'pullRequestMerged' },
      eventId: { type: 'string', minLength: 1, maxLength: 512 },
      occurredAtMs: { type: 'integer', minimum: 0 },
      repository: GITHUB_AUTOMATION_REPOSITORY_EVENT_REPOSITORY_SCHEMA,
      pullRequest: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 512, pattern: '^[1-9][0-9]*$' },
          number: { type: 'integer', minimum: 1 },
          mergeCommitSha: { type: 'string', minLength: 1, maxLength: 512 },
        },
        required: ['id', 'number', 'mergeCommitSha'],
      },
    },
    required: ['kind', 'eventId', 'occurredAtMs', 'repository', 'pullRequest'],
  }],
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
        methods: ['GET', 'POST'],
      },
    }, {
      id: 'github-cli-process',
      capability: 'process',
      reason: 'Run the declared GitHub CLI when a repository operation uses the CLI fallback.',
      scope: { executables: [{ kind: 'systemTool', id: 'github-cli' }] },
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
      reason: 'Persist per-Automation GitHub Event source checkpoints.',
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
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      execution: { target: 'daemon' },
      inputSchema: sources.operations.get.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: getGithubTriageEntry,
    },
    // The four source-native detail planes. The published Triage roles declare
    // the `plugin` surface; these reads are invoked the same way, by this
    // source's own mounted detail body and by nothing else.
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline]: {
      title: 'Read a GitHub timeline page',
      description: 'Reads one bounded page of the event timeline of one pull request or issue.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubTimelineInputV1Schema.jsonSchema,
      resultSchema: GithubTimelineResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: listGithubTimeline,
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles]: {
      title: 'Read a GitHub changed-file page',
      description: 'Reads one bounded page of the files one pull request changes, with their'
        + ' counts and whether GitHub supplied a patch for each.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubChangedFilesInputV1Schema.jsonSchema,
      resultSchema: GithubChangedFilesResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: listGithubChangedFiles,
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listComments]: {
      title: 'Read a GitHub comment page',
      description: 'Reads one bounded page of the issue-level comment stream of one pull request'
        + ' or issue.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubCommentsInputV1Schema.jsonSchema,
      resultSchema: GithubCommentsResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: listGithubComments,
    },
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks]: {
      title: 'Read the GitHub checks of a pull request',
      description: 'Reads the check runs and commit statuses of one pull request at its current'
        + ' head revision.',
      scopes: ['global'],
      surfaces: ['plugin'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
      inputSchema: GithubChecksInputV1Schema.jsonSchema,
      resultSchema: GithubChecksResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: readGithubChecks,
    },
    [GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID]: {
      title: 'Run GitHub repository Event source attempt',
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
      verifier: { kind: 'github_hmac_sha256_v1', routing: 'providerInstallation' },
      handlerAction: { localId: GITHUB_WEBHOOK_ACTION_ID },
    },
  },
  events: {
    [GITHUB_AUTOMATION_REPOSITORY_EVENT_ID]: {
      declaration: {
        kind: 'event',
        title: 'GitHub repository Event',
        description: 'A GitHub repository occurrence observed through checkpointed polling or a best-effort webhook.',
        payloadSchema: GITHUB_AUTOMATION_REPOSITORY_EVENT_PAYLOAD_SCHEMA,
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
  },
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
          ...githubPullRequestAdapter,
          ...githubRepositoryProvisioningAdapter,
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
  systemTools: {
    'github-cli': {
      title: 'GitHub CLI',
      description: 'GitHub command line client used as an authenticated repository-operation fallback.',
      executableNames: ['gh'],
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
          },
          // `prepareReviewWorkspace` is deliberately unbound: it is an optional role,
          // and binding it would claim a worktree materialization contract this
          // provider has not implemented.
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
