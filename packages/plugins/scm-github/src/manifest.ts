import { githubAccountCredentialRuntime } from './auth/credentialMaterialization.js';
import { activate as activateGithubAccountRuntime } from './accountRuntime.js';
import { GITHUB_ACCOUNT_READ_ACTIONS, GITHUB_NATIVE_READ_ACTIONS, TRIAGE_READ_HOST_ACCESS, TRIAGE_INSTANCE_ACCOUNT_BINDINGS } from './triage/readActions.js';
import {
  CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1,
  ConversationProvidersContributionProtocolV1,
} from '@happier-dev/channels-protocol/v1';
import { GITHUB_CHANNEL_PULL_REQUESTS } from './githubChannelContribution.js';
import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TriageSourcesContributionProtocolV1,
  TriageSourceCredentialInputsV1,
  TriageTaskWriteResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import {
  definePlugin,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { ActionInputHints } from '@happier-dev/plugin-sdk/actions';
import { GITHUB_FILE_VIEWED_ACTION_IDS_V1, GithubFileViewedSetInputV1Schema, ScmFileViewedSetResultV1Schema } from './triage/fileViewedContracts.js';
import { GITHUB_PREVIEW_STATUS_WORKFLOW_ID_V1, GITHUB_PREVIEW_STATUS_WORKFLOW_V1 } from './triage/previewStatusWorkflow.js';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  createPluginEventAutomationSetupResultV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';



import { GITHUB_RELEASE_ACTIONS_V1 } from './releases/contribution.js';
import { GITHUB_LOCAL_ACT_ACTIONS_V1 } from './actions/local/contribution.js';
import { beginGithubAccountRequestOccurrenceV1 } from './observations/githubApiClient.js';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID } from './adapter.js';
import { GITHUB_CI_ACTION_BINDINGS_V1 } from './actions/contribution.js';
import { githubCiBranchCountsResourceV1 } from './actions/branchCounts.js';
import { GITHUB_OVERVIEW_TARGET_ACTIONS_V1 } from './actions/overview.js';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID } from './actions/overviewContracts.js';
import { ForgeCiMountedIntentInputV1Schema, ForgeCiMountedIntentResultV1Schema } from '@happier-dev/triage-protocol/ci/v1';
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
  setupGithubPullRequestChecksSource,
  setupGithubDeploymentReviewEventSource,
} from './githubAutomationEventActions.js';
import { GITHUB_AUTOMATION_EVENT_CATALOG } from './githubAutomationEvents.js';
import { GITHUB_DEPLOYMENT_ACTIONS_V1 } from './actions/deploymentReviews.js';
import { GITHUB_DEPLOYMENT_MONITORING_ACTIONS_V1 } from './actions/deploymentMonitoring.js';
import { GITHUB_DEPLOYMENT_REVIEW_CATEGORY_ID } from './actions/deploymentReviewProtocol.js';
import { GITHUB_CHECKS_SETUP_ACTION_ID, GITHUB_CHECKS_WAIT_ACTION_ID, GITHUB_CHECKS_SOURCE_SCHEMA, isGithubChecksEvent } from './observations/githubChecksSource.js';
import { waitGithubChecksSource, GITHUB_CHECKS_WAIT_INPUT_SCHEMA, GITHUB_CHECKS_WAIT_RESULT_SCHEMA } from './observations/githubChecksWait.js';
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
  GITHUB_DEPLOYMENT_REVIEW_SETUP_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
  GITHUB_CONNECTED_ACCOUNT_ID,
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
  GITHUB_PRIVATE_MEDIA_HOST_SUFFIXES_V1,
  GITHUB_WEBHOOK_CONTRIBUTION_ID,
  GithubDeploymentMonitoringSelectionV1Schema,
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

import { GITHUB_SECURITY_ALERT_ACTION_IDS_V1, GithubDependabotDismissInputV1Schema, GithubDependabotReopenInputV1Schema, GithubCodeScanningDismissInputV1Schema, GithubCodeScanningReopenInputV1Schema, GithubSecurityAlertMutationResultV1Schema } from './triage/securityAlerts/actionContracts.js';
export { GITHUB_SECURITY_ALERT_ACTION_IDS_V1 } from './triage/securityAlerts/actionContracts.js';
import {
  GithubIssueAssigneeAddInputV1Schema,
  GithubIssueAssigneeRemoveInputV1Schema,
  GithubIssueCloseInputV1Schema,
  GithubIssueCommentInputV1Schema,
  GithubIssueCommentResultV1Schema,
  GithubCommentEditInputV1Schema,
  GithubCommentEditResultV1Schema,
  GithubCommentCreateInputV1Schema,
  GithubCommentCreateResultV1Schema,
  GithubIssueDeltaResultV1Schema,
  GithubIssueLabelAddInputV1Schema,
  GithubIssueLabelRemoveInputV1Schema,
  GithubIssueReopenInputV1Schema,
  GithubPullRequestAddReviewersInputV1Schema,
  GithubPullRequestEditInputV1Schema,
  GithubPullRequestChangeBaseInputV1Schema,
  GithubPullRequestConvertToDraftInputV1Schema,
  GithubEntryMilestoneSetInputV1Schema,
  GithubIssueTypeSetInputV1Schema,
  GithubEntryLockInputV1Schema,
  GithubEntryUnlockInputV1Schema,
  GithubPullRequestPendingReviewCreateInputV1Schema,
  GithubPullRequestPendingReviewSubmitInputV1Schema,
  GithubPullRequestPendingReviewDeleteInputV1Schema,
  GithubPullRequestReviewDismissInputV1Schema,
  GithubPullRequestReviewMutationResultV1Schema,
  GithubEntryAdministrationInputV1Schema,
  GithubIssueTransferInputV1Schema,
  GithubEntryAdministrationResultV1Schema,
  GithubPullRequestRevertInputV1Schema,
  GithubPullRequestHeadBranchRestoreInputV1Schema,
  GithubPullRequestHeadBranchRestoreResultV1Schema,
  GithubPullRequestHeadBranchDeleteInputV1Schema,
  GithubPullRequestHeadBranchDeleteResultV1Schema,
  GithubPullRequestCloseInputV1Schema,
  GithubPullRequestPreviewStatusInputV1Schema,
  GithubPullRequestPreviewStatusResultV1Schema,
  GithubPullRequestMarkReadyInputV1Schema,
  GithubPullRequestMarkReadyActionResultV1Schema,
  GithubPullRequestMergeInputV1Schema,
  GithubPullRequestEnqueueInputV1Schema,
  GithubPullRequestDequeueInputV1Schema,
  GithubPullRequestAutoMergeSetInputV1Schema,
  GithubPullRequestNativeMergeActionResultV1Schema,
  GithubPullRequestMergeActionResultV1Schema,
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
import { githubHostingProviderAdapter } from './adapter.js';
import {
  GithubRelatedEntryInputV1Schema, GithubSubIssueAddInputV1Schema, GithubSubIssueReprioritizeInputV1Schema,
  GithubProjectItemAddInputV1Schema, GithubProjectItemRemoveInputV1Schema,
  GithubProjectFieldSetInputV1Schema, GithubProjectFieldClearInputV1Schema, GithubRelationshipMutationResultV1Schema,
} from './triage/mutations/relationshipContracts.js';
import { githubPullRequestAdapter } from './pullRequests/authChain.js';
import { githubRepositoryProvisioningAdapter } from './repositoryProvisioning/createRepositoryWithAuthFallback.js';
import {
  GITHUB_ACTIONS_PAGE_ID_V1,
  GITHUB_DEPLOYMENT_REVIEW_VIEW_ID_V1,
  GITHUB_SESSION_CI_VIEW_ID_V1,
  GITHUB_RESOURCE_RUN_PAGE_ID_V1,
  GITHUB_RESOURCE_RUN_SESSION_VIEW_ID_V1,
  GITHUB_PROJECT_STATUS_WIDGET_ID_V1,
  GITHUB_FORGE_ARTIFACT_ID_V1,
  GITHUB_FORGE_RENDERER_ID_V1,
  GITHUB_RELEASES_PAGE_ID_V1,
  GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1,
  GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1,
} from './ui/forge/surfaceIds.js';
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
 * same purpose-scoped seam, so all read roles carry the same host access.
 */


/**
 * Every operation with a configured instance declares its exact account path, so the
 * host binds and revalidates that leaf instead of trusting the field name. `scan` shares
 * the declaration: its published input is a two-arm union — the deliberate shape that
 * makes a mid-scan limit change unrepresentable — and every arm carries the same
 * configured instance, so the bound path is proven for every representable scan request.
 * `listInstances` carries no account at all, because producing account references is what
 * it performs.
 */


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

const GITHUB_DEPLOYMENT_SOURCE_CONFIG_SCHEMA = {
  ...GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
  properties: { ...GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA.properties,
    credentialRef: { anyOf: [QualifiedConnectedAccountRefJsonSchema, { type: 'null' }] },
    deploymentReview: GithubDeploymentMonitoringSelectionV1Schema.jsonSchema },
  required: [...GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA.required, 'deploymentReview'],
} satisfies PluginJsonSchema;

const GITHUB_AUTOMATION_REPOSITORY_SETUP_RESULT_SCHEMA =
  createPluginEventAutomationSetupResultV1JsonSchema(
    GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION,
    GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
  );

const GITHUB_CHECKS_SOURCE_CONFIG_SCHEMA = {
  ...GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
  properties: { ...GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA.properties, checks: GITHUB_CHECKS_SOURCE_SCHEMA },
  required: [...GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA.required, 'checks'],
} satisfies PluginJsonSchema;

const GITHUB_NATIVE_SERVICE_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { pluginId: { type: 'string', const: GITHUB_PLUGIN_ID }, localId: { type: 'string', const: GITHUB_CONNECTED_ACCOUNT_ID } },
  required: ['pluginId', 'localId'],
} satisfies PluginJsonSchema;

/** Each declared arm selects one authority, never an account/native pair. */
function githubCredentialInputSchema(properties: NonNullable<PluginJsonSchema['properties']>, required: readonly string[]): PluginJsonSchema {
  return { anyOf: [{
    type: 'object', additionalProperties: false,
    properties: { ...properties, credentialRef: QualifiedConnectedAccountRefJsonSchema },
    required: [...required, 'credentialRef'],
  }, {
    type: 'object', additionalProperties: false,
    properties: { ...properties, nativeService: GITHUB_NATIVE_SERVICE_INPUT_SCHEMA },
    required: [...required, 'nativeService'],
  }] };
}

const GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_INPUT_SCHEMA = githubCredentialInputSchema({
    definitions: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true } },
    deliveredRunId: { type: 'string', pattern: '^[1-9][0-9]*$' },
}, ['definitions']);

const GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceKey: { type: 'string', minLength: 1, maxLength: 4096 },
    nextEligibleAt: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
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
    const retireRequests = beginGithubAccountRequestOccurrenceV1();
    const automationEventObserver = createGithubAutomationEventCheckpointedPullObserver({ manifest: PLUGIN_MANIFEST });
    const runtime = Object.freeze({ automationEventObserver,
      webhookActionHandler: createGithubWebhookActionHandlerV1({ observeDeploymentRun: automationEventObserver.receiveDeploymentWebhook }),
    });
    activeGithubPluginRuntime = runtime;
    return () => {
      retireRequests();
      if (activeGithubPluginRuntime === runtime) activeGithubPluginRuntime = null;
    };
  }

  const branchCounts = {
    resourceId: 'ci-branch-counts',
    items: [
      { field: 'running', label: { key: 'plugins.github.ci.counts.running', fallback: 'Running' } },
      { field: 'failed', label: { key: 'plugins.github.ci.counts.failed', fallback: 'Failed' } },
    ],
  };
  return definePlugin({
  id: GITHUB_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'GitHub SCM hosting provider',
  description: 'Detects GitHub remotes and provides GitHub repository operations.',
  brand: { iconResourceId: GITHUB_BRAND_RESOURCE_ID, monochrome: true },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  activation: { events: [], configuration: { automationEventSources: true } },
  workflows: { [GITHUB_PREVIEW_STATUS_WORKFLOW_ID_V1]: GITHUB_PREVIEW_STATUS_WORKFLOW_V1 },
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
      id: 'github-downloads',
      capability: 'network',
      reason: 'Read private GitHub job logs and downloads from GitHub-provided storage locations without API credentials.',
      scope: {
        targets: GITHUB_PRIVATE_MEDIA_HOST_SUFFIXES_V1.map(hostSuffix => ({ kind: 'httpsHostSuffix' as const, hostSuffix })),
        methods: ['GET'],
      },
    }, {
      id: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      capability: 'connectedAccounts',
      reason: 'Materialize the declared GitHub credential: an exact selected Connected Account or this machine’s GitHub CLI login.',
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
    }, {
      id: 'github-local-act-probes', capability: 'process',
      reason: 'Inspect the user-installed act executable on this Machine without starting a workflow.',
      scope: { executables: [{ kind: 'systemTool', id: 'act' }] },
    }],
    optional: [],
  },
  systemTools: { act: { title: 'act', description: 'User-installed local workflow runner. Install it on the accepted checkout’s primary Machine.',
    executableNames: ['act'], allowedArguments: ['--version', '--help'] } },
  accountCollections: {
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID]: GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  },
  resources: {
    'ci-branch-counts': {
      source: 'dynamic',
      scope: 'surface',
      kind: 'config',
      contentType: 'application/json',
      runtime: githubCiBranchCountsResourceV1,
    },
    [GITHUB_BRAND_RESOURCE_ID]: {
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
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
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
  },
  ui: {
    views: [{
      id: GITHUB_RESOURCE_RUN_PAGE_ID_V1,
      container: 'appPage',
      target: { kind: 'app' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.ci.run.title', fallback: 'Workflow run' },
      icon: 'workflow',
      instancePolicy: 'singleton',
      resourceLinks: [{ kind: 'ciRun',
        urlPattern: '^https://github\\.com/[^/?#]+/[^/?#]+/actions/runs/[1-9][0-9]*(?:/[^?#]*)?(?:\\?[^#]*)?(?:#.*)?$',
        destination: GITHUB_RESOURCE_RUN_PAGE_ID_V1 }],
    }, {
      id: GITHUB_RESOURCE_RUN_SESSION_VIEW_ID_V1,
      container: 'detailsTab',
      target: { kind: 'session' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.ci.run.title', fallback: 'Workflow run' },
      icon: 'workflow',
      instancePolicy: 'multiple',
      resourceLinks: [{ kind: 'ciRun',
        urlPattern: '^https://github\\.com/[^/?#]+/[^/?#]+/actions/runs/[1-9][0-9]*(?:/[^?#]*)?(?:\\?[^#]*)?(?:#.*)?$',
        destination: GITHUB_RESOURCE_RUN_SESSION_VIEW_ID_V1 }],
    }, {
      id: GITHUB_ACTIONS_PAGE_ID_V1,
      container: 'appPage',
      counts: branchCounts,
      target: { kind: 'project' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.actions.page.title', fallback: 'Actions' },
      description: { key: 'plugins.github.actions.page.description', fallback: 'Workflow runs for this repository, and the workflows you can run.' },
      icon: 'workflow',
      availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } },
      instancePolicy: 'singleton',
    }, {
      id: GITHUB_RELEASES_PAGE_ID_V1,
      container: 'appPage',
      target: { kind: 'project' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.releases.page.title', fallback: 'Releases' },
      description: { key: 'plugins.github.releases.page.description', fallback: 'What shipped from this repository, and the next release.' },
      icon: 'tag',
      availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } },
      instancePolicy: 'singleton',
    }, {
      // Opened from deployment notices, Inbox and the Actions banner; the locator grants nothing by itself.
      id: GITHUB_DEPLOYMENT_REVIEW_VIEW_ID_V1,
      container: 'appPage',
      target: { kind: 'app' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.deploymentReview.page.title', fallback: 'Deployment review' },
      description: { key: 'plugins.github.deploymentReview.page.description', fallback: 'Approve or reject a deployment that is waiting for you.' },
      icon: 'review',
      instancePolicy: 'singleton',
    }, {
      // The Session rail's CI tab (lab a6): runs for the Session's exact HEAD, read through this plugin's CI Actions.
      id: GITHUB_SESSION_CI_VIEW_ID_V1,
      container: 'rightSidebarTab',
      counts: branchCounts,
      target: { kind: 'session' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.ci.rail.title', fallback: 'CI' },
      icon: 'workflow',
      instancePolicy: 'singleton',
    }, {
      // The Project Overview's GitHub widget (lab a7): default-branch CI, with the latest release beside it.
      id: GITHUB_PROJECT_STATUS_WIDGET_ID_V1,
      container: 'widget',
      target: { kind: 'project' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.overview.title', fallback: 'CI and releases' },
      icon: 'workflow',
      sizeDeclaration: { sizes: ['medium', 'wide', 'tall', 'large'], defaultSize: 'medium' },
      availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } },
    }, {
      id: GITHUB_LOCAL_ACT_SESSION_VIEW_ID_V1,
      container: 'detailsPane',
      target: { kind: 'session' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.actions.local.title', fallback: 'Local run' },
      instancePolicy: 'singleton',
    }, {
      id: GITHUB_LOCAL_ACT_PROJECT_VIEW_ID_V1,
      container: 'detailsPane',
      target: { kind: 'project' },
      renderer: GITHUB_FORGE_RENDERER_ID_V1,
      title: { key: 'plugins.github.actions.local.title', fallback: 'Local run' },
      instancePolicy: 'singleton',
    }],
    renderers: [{
      id: GITHUB_FORGE_RENDERER_ID_V1,
      kind: 'reactNative',
      artifact: GITHUB_FORGE_ARTIFACT_ID_V1,
      // Every page reads and acts through this plugin's own CI Actions.
      requiredHostMethods: ['executeAction'],
    }, {
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
      requiredHostMethods: ['executeAction', 'openConnectedAccounts'],
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
      { locale: "en", resourceId: "i18n-en" },
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
      { locale: "de", resourceId: "i18n-de" },
    ],
  },
  // The Event observer activates this plugin independently of Triage use. Keep
  // Action contracts available here, but initialize Triage execution on invocation.
  actions: {
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus]: {
      title: 'Publish preview status',
      description: 'Publishes one admitted own-server preview receipt to its exact GitHub pull-request head.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      approvalScope: 'environment',
      dangerLevel: 'writesRemote',
      confirmation: { title: 'Publish preview status?' },
      confirmationWhen: { presentUserUi: false },
      inputSchema: GithubPullRequestPreviewStatusInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestPreviewStatusResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutations/previewStatusAdmission.js')).publishGithubPullRequestPreviewStatusAction(input, context),
    },
    ...GITHUB_LOCAL_ACT_ACTIONS_V1,
    ...GITHUB_ACCOUNT_READ_ACTIONS,
    ...GITHUB_NATIVE_READ_ACTIONS,
    ...GITHUB_CI_ACTION_BINDINGS_V1,
    ...GITHUB_OVERVIEW_TARGET_ACTIONS_V1,
    'ui/ci-view-v1': {
      title: 'Control the mounted Actions view',
      description: 'Applies typed selection, filters, trigger draft and log controls to one current mount. It never mounts a page or performs a provider write.',
      surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'], placementBindings: [], dangerLevel: 'safe',
      execution: { target: 'client', client: { artifactId: 'github-forge-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
      inputSchema: ForgeCiMountedIntentInputV1Schema, resultSchema: ForgeCiMountedIntentResultV1Schema,
    },
    ...GITHUB_RELEASE_ACTIONS_V1,
    ...GITHUB_DEPLOYMENT_ACTIONS_V1,
    ...GITHUB_DEPLOYMENT_MONITORING_ACTIONS_V1,
    
    
    
    
    
    
    [GITHUB_TRIAGE_ACTION_IDS_V1.linkSession]: {
      title: 'Link or unlink a GitHub pull request Session',
      description: 'Changes one exact Session relationship through the canonical Channels binding owner.',
      surfaces: sources.operations.linkSession.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.linkSession.declaration.dangerLevel,
      sessionTarget: { field: 'sessionId', cardinality: 'one' },
      inputSchema: TriageSourceCredentialInputsV1.linkSession.jsonSchema,
      resultSchema: sources.operations.linkSession.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/sessionRelations.js')).linkGithubTriageSession(input, context),
    },
    
    
    [GITHUB_TRIAGE_ACTION_IDS_V1.prepareReviewWorkspace]: {
      title: 'Prepare a GitHub pull-request review workspace',
      description: 'Rereads one GitHub pull request and prepares its source branch in the selected workspace.',
      surfaces: sources.operations.prepareReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.prepareReviewWorkspace.declaration.dangerLevel,
      // The person's own press is the consent for the checkout they asked for;
      // agents, MCP and a saved Ask keep the writes-local default.
      confirmationWhen: { presentUserUi: false },
      inputSchema: TriageSourceCredentialInputsV1.prepareReviewWorkspace.jsonSchema,
      // Placement and the observed PR facts are supplied by their host owners.
      // Keep the complete Action schema for agents and final validation, but
      // never offer those technical objects as a person-authored JSON form.
      inputHints: { fields: [] },
      resultSchema: sources.operations.prepareReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/operations.js')).prepareGithubTriageReviewWorkspace(input, context),
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.verifyReviewWorkspace]: {
      title: 'Verify a GitHub pull-request review workspace',
      description: 'Rereads one GitHub pull request and verifies the prepared workspace still has its exact head.',
      surfaces: sources.operations.verifyReviewWorkspace.declaration.surfaces,
      dangerLevel: sources.operations.verifyReviewWorkspace.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.verifyReviewWorkspace.jsonSchema,
      resultSchema: sources.operations.verifyReviewWorkspace.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/operations.js')).verifyGithubTriageReviewWorkspace(input, context),
    },
    // Native provider reads are available to the mounted UI and agent-facing
    // Actions without adding a generic host PR-management owner.
    
    
    
    
    [GITHUB_SECURITY_ALERT_ACTION_IDS_V1.dismissDependabot]: {
      title: 'Dismiss this Dependabot alert', description: 'Dismisses the selected finding with the native reason and optional comment.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Dismiss this Dependabot alert?', body: 'The finding is hidden on GitHub. Dismissal does not fix the vulnerability.', confirmLabel: 'Dismiss' }, confirmationWhen: { presentUserUi: false },
      inputSchema: GithubDependabotDismissInputV1Schema.jsonSchema, resultSchema: GithubSecurityAlertMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/securityAlerts/mutations.js')).dismissGithubDependabotAlert(input, context),
    },
    [GITHUB_SECURITY_ALERT_ACTION_IDS_V1.reopenDependabot]: {
      title: 'Reopen this Dependabot alert', description: 'Reopens a dismissed Dependabot finding when its native state permits it.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Reopen this Dependabot alert?', body: 'The finding becomes open again on GitHub.', confirmLabel: 'Reopen' }, confirmationWhen: { presentUserUi: false },
      inputSchema: GithubDependabotReopenInputV1Schema.jsonSchema, resultSchema: GithubSecurityAlertMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/securityAlerts/mutations.js')).reopenGithubDependabotAlert(input, context),
    },
    [GITHUB_SECURITY_ALERT_ACTION_IDS_V1.dismissCodeScanning]: {
      title: 'Dismiss this code scanning alert', description: 'Dismisses the selected code scanning finding with its native reason and optional comment.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Dismiss this code scanning alert?', body: 'The finding is hidden on GitHub. Dismissal does not fix the code.', confirmLabel: 'Dismiss' }, confirmationWhen: { presentUserUi: false },
      inputSchema: GithubCodeScanningDismissInputV1Schema.jsonSchema, resultSchema: GithubSecurityAlertMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/securityAlerts/mutations.js')).dismissGithubCodeScanningAlert(input, context),
    },
    [GITHUB_SECURITY_ALERT_ACTION_IDS_V1.reopenCodeScanning]: {
      title: 'Reopen this code scanning alert', description: 'Reopens a dismissed code scanning finding when its native state permits it.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Reopen this code scanning alert?', body: 'The finding becomes open again on GitHub.', confirmLabel: 'Reopen' }, confirmationWhen: { presentUserUi: false },
      inputSchema: GithubCodeScanningReopenInputV1Schema.jsonSchema, resultSchema: GithubSecurityAlertMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/securityAlerts/mutations.js')).reopenGithubCodeScanningAlert(input, context),
    },
    
    
    [GITHUB_FILE_VIEWED_ACTION_IDS_V1.set]: {
      title: 'Set GitHub file viewed', description: 'Changes your private, reversible viewed state for one pull request file.',
      surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'writesRemote',
      // Strict boolean input makes the default predicate always false; the
      // Action policy still honors a user's explicit Ask override.
      confirmationWhen: { default: { op: 'eq', path: 'viewed', value: null }, presentUserUi: false },
      confirmation: { title: 'Change your Viewed state?', body: 'This changes your private viewed state for this file on GitHub.', confirmLabel: 'Change Viewed' },
      inputSchema: GithubFileViewedSetInputV1Schema, resultSchema: ScmFileViewedSetResultV1Schema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/fileViewed.js')).setGithubFileViewed(input, context),
    },
    
    
    
    
    
    // PR and issue writes retain provider-native danger levels and confirmations.
    // The shared Action policy requires approval by default on agent/MCP/CLI.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.closingReferenceAdd]: {
      title: 'Link closing pull request', description: 'Links one exact pull request as a manual closing reference on one issue; accepts either detail as the primary entry.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Link closing reference?', body: 'The selected pull request will be linked to close this issue when merged.', confirmLabel: 'Link' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubClosingReferenceAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.closingReferenceRemove]: {
      title: 'Unlink closing pull request', description: 'Removes one manual closing reference. Body-keyword references require editing the pull request description.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Unlink closing reference?', body: 'This removes the selected manual link. References from description keywords remain.', confirmLabel: 'Unlink' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubClosingReferenceAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.subIssueAdd]: {
      title: 'Add sub-issue', description: 'Adds one exact issue under this parent. Moving it from an existing parent requires an explicit replaceParent choice.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Add sub-issue?', body: 'This links the selected issue under this parent. If replaceParent is selected, it moves from its current parent.', confirmLabel: 'Add sub-issue' },
      inputSchema: GithubSubIssueAddInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubSubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.subIssueRemove]: {
      title: 'Remove sub-issue', description: 'Removes this exact parent/sub-issue relationship without deleting either issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Remove sub-issue?', body: 'This removes the selected issue from this parent.', confirmLabel: 'Remove' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubSubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.subIssueReprioritize]: {
      title: 'Move sub-issue', description: 'Moves one sub-issue before or after one exact sibling without replacing the parent list.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Move sub-issue?', body: 'This changes the selected sub-issue’s position in its parent list.', confirmLabel: 'Move' },
      inputSchema: GithubSubIssueReprioritizeInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).reprioritizeGithubSubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.blockedByAdd]: {
      title: 'Add blocker', description: 'Marks this issue as blocked by one exact related issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Add blocker?', body: 'This issue will be marked as blocked by the selected issue.', confirmLabel: 'Add blocker' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubBlockedByAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.blockedByRemove]: {
      title: 'Remove blocker', description: 'Removes one exact blocked-by relationship.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Remove blocker?', body: 'This issue will no longer be marked as blocked by the selected issue.', confirmLabel: 'Remove blocker' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubBlockedByAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.blockingAdd]: {
      title: 'Add blocked issue', description: 'Marks one exact related issue as blocked by this issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Add blocked issue?', body: 'The selected issue will be marked as blocked by this issue.', confirmLabel: 'Add blocked issue' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubBlockingAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.blockingRemove]: {
      title: 'Remove blocked issue', description: 'Removes the exact relationship where this issue blocks the related issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Remove blocked issue?', body: 'The selected issue will no longer be marked as blocked by this issue.', confirmLabel: 'Remove' },
      inputSchema: GithubRelatedEntryInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubBlockingAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.projectItemAdd]: {
      title: 'Add to GitHub Project', description: 'Adds this exact issue or pull request to one selected GitHub Project.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Add to Project?', body: 'This adds the selected entry to the selected GitHub Project.', confirmLabel: 'Add' },
      inputSchema: GithubProjectItemAddInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubProjectItemAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.projectItemRemove]: {
      title: 'Remove from GitHub Project', description: 'Removes the exact Project item belonging to this issue or pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Remove from Project?', body: 'This removes the selected entry from the selected GitHub Project.', confirmLabel: 'Remove' },
      inputSchema: GithubProjectItemRemoveInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubProjectItemAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.projectFieldSet]: {
      title: 'Edit GitHub Project field', description: 'Sets one exact Project item field: text, number, date, single-select, multi-select or iteration.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Save Project field?', body: 'This updates one field on the selected GitHub Project item.', confirmLabel: 'Save' },
      inputSchema: GithubProjectFieldSetInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).setGithubProjectFieldAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.projectFieldClear]: {
      title: 'Clear GitHub Project field', description: 'Clears one exact field on the selected Project item.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Clear Project field?', body: 'This clears the selected field on the selected GitHub Project item.', confirmLabel: 'Clear' },
      inputSchema: GithubProjectFieldClearInputV1Schema.jsonSchema, resultSchema: GithubRelationshipMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).clearGithubProjectFieldAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestEdit]: {
      title: 'Edit pull request title or description',
      description: 'Updates only the title and description fields you supply on this GitHub pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Save pull request changes?', body: 'This updates the selected title or description on GitHub.', confirmLabel: 'Save changes' },
      inputSchema: GithubPullRequestEditInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).editGithubPullRequestAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryMilestoneSet]: {
      title: 'Set or clear milestone', description: 'Sets the chosen milestone on this GitHub issue or pull request, or clears it with null.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Change milestone?', body: 'This changes the milestone on GitHub.', confirmLabel: 'Save milestone' },
      inputSchema: GithubEntryMilestoneSetInputV1Schema.jsonSchema, resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).setGithubEntryMilestoneAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueTypeSet]: {
      title: 'Set or clear issue type', description: 'Changes the issue type using GitHub’s native type name, or clears it with null.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Change issue type?', body: 'This changes the selected issue’s type on GitHub.', confirmLabel: 'Save type' },
      inputSchema: GithubIssueTypeSetInputV1Schema.jsonSchema, resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).setGithubIssueTypeAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryLock]: {
      title: 'Lock conversation', description: 'Locks this issue or pull request’s conversation with an optional native lock reason.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Lock conversation?', body: 'This restricts new comments according to GitHub’s repository permissions.', confirmLabel: 'Lock' },
      inputSchema: GithubEntryLockInputV1Schema.jsonSchema, resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).lockGithubEntryAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnlock]: {
      title: 'Unlock conversation', description: 'Unlocks this GitHub issue or pull request’s conversation.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Unlock conversation?', body: 'This allows comments again under the repository’s ordinary permissions.', confirmLabel: 'Unlock' },
      inputSchema: GithubEntryUnlockInputV1Schema.jsonSchema, resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).unlockGithubEntryAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestChangeBase]: {
      title: 'Change pull request base',
      description: 'Changes the base branch of this pull request within its current GitHub repository.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Change base branch?', body: 'This changes the target branch and the comparison shown on GitHub.', confirmLabel: 'Change base' },
      inputSchema: GithubPullRequestChangeBaseInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).changeGithubPullRequestBaseAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestHeadBranchDelete]: {
      title: 'Delete pull request head branch', description: 'Deletes the source branch only when its current tip still matches the head you selected.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Delete source branch?', body: 'This deletes the pull request’s source branch on GitHub, not its base branch.', confirmLabel: 'Delete branch' },
      inputSchema: GithubPullRequestHeadBranchDeleteInputV1Schema.jsonSchema, resultSchema: GithubPullRequestHeadBranchDeleteResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).deleteGithubPullRequestHeadBranchAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestHeadBranchRestore]: {
      title: 'Restore pull request head branch', description: 'Recreates the source branch at the head you selected, without overwriting an existing branch.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Restore source branch?', body: 'This recreates the deleted source branch at the selected commit.', confirmLabel: 'Restore branch' },
      inputSchema: GithubPullRequestHeadBranchRestoreInputV1Schema.jsonSchema, resultSchema: GithubPullRequestHeadBranchRestoreResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).restoreGithubPullRequestHeadBranchAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRevert]: {
      title: 'Revert pull request', description: 'Creates a new GitHub pull request reverting this merged pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'externalSideEffect',
      confirmation: { title: 'Create revert pull request?', body: 'This creates a new pull request on GitHub; the merged original stays unchanged.', confirmLabel: 'Create revert' },
      inputSchema: GithubPullRequestRevertInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).revertGithubPullRequestAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueTransfer]: {
      title: 'Transfer issue', description: 'Moves this issue to the chosen owner/repository through the existing repository reader.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Transfer issue?', body: 'This moves the issue and its conversation to the chosen GitHub repository.', confirmLabel: 'Transfer issue' },
      inputSchema: GithubIssueTransferInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).transferGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueDelete]: {
      title: 'Delete issue', description: 'Deletes this issue and its conversation on GitHub.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'destructive',
      confirmation: { title: 'Delete issue?', body: 'This permanently deletes the issue and its comments on GitHub.', confirmLabel: 'Delete issue' },
      inputSchema: GithubEntryAdministrationInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).deleteGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issuePin]: {
      title: 'Pin issue', description: 'Pins this issue to the repository issue list.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Pin issue?', body: 'This pins the selected issue on GitHub.', confirmLabel: 'Pin issue' },
      inputSchema: GithubEntryAdministrationInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).pinGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueUnpin]: {
      title: 'Unpin issue', description: 'Unpins this issue from the repository issue list.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Unpin issue?', body: 'This unpins the selected issue on GitHub.', confirmLabel: 'Unpin issue' },
      inputSchema: GithubEntryAdministrationInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).unpinGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entrySubscribe]: {
      title: 'Subscribe to conversation', description: 'Subscribes the acting GitHub user to this issue or pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Subscribe?', body: 'GitHub will notify you about this conversation.', confirmLabel: 'Subscribe' },
      inputSchema: GithubEntryAdministrationInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).subscribeGithubEntryAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnsubscribe]: {
      title: 'Unsubscribe from conversation', description: 'Restores ordinary participation and mention notifications for this issue or pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Unsubscribe?', body: 'GitHub will notify you only when participating or mentioned.', confirmLabel: 'Unsubscribe' },
      inputSchema: GithubEntryAdministrationInputV1Schema.jsonSchema, resultSchema: GithubEntryAdministrationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).unsubscribeGithubEntryAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewCreate]: {
      title: 'Start a pending review', description: 'Creates a GitHub-hosted pending review at the chosen commit.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Save pending review?', body: 'This saves a review draft on GitHub without submitting it.', confirmLabel: 'Save draft' },
      inputSchema: GithubPullRequestPendingReviewCreateInputV1Schema.jsonSchema, resultSchema: GithubPullRequestReviewMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).createGithubPendingReviewAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewSubmit]: {
      title: 'Submit a pending review', description: 'Submits the selected native GitHub review as Approve, Request changes or Comment.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'externalSideEffect',
      confirmation: { title: 'Submit pending review?', body: 'This publishes the saved review and its verdict on GitHub.', confirmLabel: 'Submit review' },
      inputSchema: GithubPullRequestPendingReviewSubmitInputV1Schema.jsonSchema, resultSchema: GithubPullRequestReviewMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).submitGithubPendingReviewAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewDelete]: {
      title: 'Delete a pending review', description: 'Deletes the selected unsubmitted review on GitHub.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'destructive',
      confirmation: { title: 'Delete pending review?', body: 'This deletes the review draft and its pending comments on GitHub.', confirmLabel: 'Delete review' },
      inputSchema: GithubPullRequestPendingReviewDeleteInputV1Schema.jsonSchema, resultSchema: GithubPullRequestReviewMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).deleteGithubPendingReviewAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.reviewDismiss]: {
      title: 'Dismiss a review', description: 'Dismisses the selected submitted GitHub review with the supplied reason.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Dismiss review?', body: 'This withdraws the review’s approval or request for changes on GitHub.', confirmLabel: 'Dismiss review' },
      inputSchema: GithubPullRequestReviewDismissInputV1Schema.jsonSchema, resultSchema: GithubPullRequestReviewMutationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).dismissGithubReviewAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestConvertToDraft]: {
      title: 'Convert pull request to draft',
      description: 'Returns one open GitHub pull request to draft status.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: ['detailsPanel'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Convert to draft?', body: 'This pull request will no longer be marked ready for review.', confirmLabel: 'Convert to draft' },
      inputSchema: GithubPullRequestConvertToDraftInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).convertGithubPullRequestToDraftAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge]: {
      title: 'Merge this pull request',
      description: 'Merges one GitHub pull request at the exact head revision you are looking at,'
        + ' using a merge method this repository allows.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
        inputFields: [
          { path: 'routingToken', title: { key: 'plugins.github.ui.field.repository', fallback: 'Repository' } },
          { path: 'localRef.entryId', title: { key: 'plugins.github.ui.field.number', fallback: 'Number' } },
          { path: 'headRevision', title: { key: 'plugins.github.ui.atHead', fallback: 'At this head' } },
          { path: 'mergeMethod', title: { key: 'plugins.github.ui.mutations.mergeMethod', fallback: 'Merge method' } },
          { path: 'skippedRequirements.[].label', title: {
            key: 'plugins.github.ui.primaryWrite.withoutWaiting', fallback: 'Merge without waiting for requirements',
          } },
        ],
      },
      inputSchema: GithubPullRequestMergeInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestMergeActionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).mergeGithubPullRequestAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestEnqueue]: {
      title: 'Add this pull request to the merge queue',
      description: 'Asks GitHub to queue this pull request at the exact observed head.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: { title: 'Add to merge queue?', body: 'GitHub will merge this pull request when its queue requirements are satisfied.' },
      confirmationWhen: { presentUserUi: false },
      inputSchema: GithubPullRequestEnqueueInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestNativeMergeActionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).enqueueGithubPullRequestAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestDequeue]: {
      title: 'Remove this pull request from the merge queue',
      description: 'Asks GitHub to remove this exact pull request from its merge queue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: { title: 'Remove from merge queue?' },
      confirmationWhen: { presentUserUi: false },
      inputSchema: GithubPullRequestDequeueInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestNativeMergeActionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).dequeueGithubPullRequestAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAutoMergeSet]: {
      title: 'Set native pull request auto-merge',
      description: 'Enables GitHub auto-merge, which may merge immediately, or cancels it.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'destructive',
      confirmation: { title: 'Merge when ready?', body: 'GitHub may merge this pull request immediately. This cannot be undone.', confirmLabel: 'Enable auto-merge' },
      confirmationWhen: { presentUserUi: { op: 'eq', path: 'enabled', value: true } },
      inputSchema: GithubPullRequestAutoMergeSetInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestNativeMergeActionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).setGithubPullRequestAutoMergeAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose]: {
      title: 'Close this pull request',
      description: 'Closes one open GitHub pull request without merging it. Its branch and commits'
        + ' are left untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestCloseInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).closeGithubPullRequestAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen]: {
      title: 'Reopen this pull request',
      description: 'Reopens one closed, unmerged GitHub pull request.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestReopenInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).reopenGithubPullRequestAction(input, context),
    },
    // Draft → ready and a reviewer request are `externalSideEffect` rather than
    // `writesRemote` because the effect a person feels is the NOTIFICATION
    // fan-out, not the field that changed. Update-branch and a withdrawal move
    // remote state and summon nobody, so they are `writesRemote`.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady]: {
      title: 'Mark this pull request ready for review',
      description: 'Takes one GitHub pull request out of draft at the exact head revision you are'
        + ' looking at, which notifies every requested reviewer and starts its checks.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestMarkReadyInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestMarkReadyActionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).markGithubPullRequestReadyAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview]: {
      title: 'Submit this pull request review',
      description: 'Publishes one canonical Happier review proposal and its verdict against the exact base and head revisions you are looking at.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestReviewPublicationInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewPublicationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).publishGithubPullRequestReviewAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReviewCommentCreate]: {
      title: 'Publish this pull request review comment',
      description: 'Publishes one canonical Happier review proposal at its exact pinned GitHub diff anchor.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'externalSideEffect',
      confirmation: {
        title: { key: 'plugins.github.mutations.reviewCommentCreate.confirmation.title', fallback: 'Publish this review comment?' },
        body: { key: 'plugins.github.mutations.reviewCommentCreate.confirmation.body', fallback: 'This posts the selected comment on GitHub at the exact pull request comparison you reviewed.' },
        confirmLabel: { key: 'plugins.github.mutations.reviewCommentCreate.confirmation.confirmLabel', fallback: 'Publish comment' },
      },
      inputSchema: GithubPullRequestReviewCommentCreateInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewCommentCreateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).createGithubPullRequestReviewCommentAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadReply]: {
      title: 'Reply to this pull request review thread',
      description: 'Publishes one canonical Happier proposal as a reply to the exact GitHub review thread.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.github.mutations.threadReply.confirmation.title', fallback: 'Post this thread reply?' },
        body: { key: 'plugins.github.mutations.threadReply.confirmation.body', fallback: 'This reply becomes visible in the selected GitHub review conversation.' },
        confirmLabel: { key: 'plugins.github.mutations.threadReply.confirmation.confirmLabel', fallback: 'Post reply' },
      },
      inputSchema: GithubPullRequestThreadReplyInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestThreadReplyResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).replyToGithubPullRequestThreadAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueComment]: {
      title: 'Comment on this GitHub issue',
      description: 'Publishes one canonical Happier proposal into the exact GitHub issue conversation.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.github.mutations.issueComment.confirmation.title', fallback: 'Post this issue comment?' },
        body: { key: 'plugins.github.mutations.issueComment.confirmation.body', fallback: 'This comment becomes visible in the selected GitHub issue conversation.' },
        confirmLabel: { key: 'plugins.github.mutations.issueComment.confirmation.confirmLabel', fallback: 'Post comment' },
      },
      inputSchema: GithubIssueCommentInputV1Schema.jsonSchema,
      resultSchema: GithubIssueCommentResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).createGithubIssueCommentAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestUpdateBranch]: {
      title: 'Update this branch',
      description: 'Merges the base branch into one GitHub pull request’s branch, guarded by the'
        + ' exact head revision you are looking at.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestUpdateBranchInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestUpdateBranchResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).updateGithubPullRequestBranchAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAddReviewers]: {
      title: 'Request review from people',
      description: 'Asks exactly the named GitHub users and teams to review this pull request,'
        + ' leaving reviewers somebody else requested untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestAddReviewersInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewersResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubPullRequestReviewersAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRemoveReviewers]: {
      title: 'Withdraw review requests',
      description: 'Stops asking exactly the named GitHub users and teams to review this pull'
        + ' request, leaving every reviewer you did not name untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestRemoveReviewersInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestReviewersResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubPullRequestReviewersAction(input, context),
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
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubPullRequestThreadResolutionInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestThreadResolutionResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).setGithubPullRequestThreadResolutionAction(input, context),
    },
    // Editing a comment is `writesRemote`: it changes text everyone can read and
    // summons nobody, and GitHub keeps the earlier text in its edit history.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentEdit]: {
      title: 'Edit a GitHub comment',
      description: 'Replaces the text of one comment, line review comment or review summary on'
        + ' this GitHub issue or pull request, where GitHub lets you edit it.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.github.mutations.commentEdit.confirmation.title', fallback: 'Save this edit?' },
        body: {
          key: 'plugins.github.mutations.commentEdit.confirmation.body',
          fallback: 'The new text replaces this comment on GitHub for everyone who can see it.'
            + ' GitHub keeps the earlier text in the comment\'s edit history.',
        },
        confirmLabel: { key: 'plugins.github.mutations.commentEdit.confirmation.confirmLabel', fallback: 'Save edit' },
      },
      inputSchema: GithubCommentEditInputV1Schema.jsonSchema,
      resultSchema: GithubCommentEditResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).editGithubCommentAction(input, context),
    },
    // Posting is `writesRemote` like every conversation write here: everyone
    // watching the entry reads it, and GitHub notifies its subscribers.
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate]: {
      title: 'Comment on this GitHub issue or pull request',
      description: 'Posts one new comment at the end of this GitHub issue or pull request conversation.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: { key: 'plugins.github.mutations.commentCreate.confirmation.title', fallback: 'Post this comment?' },
        body: {
          key: 'plugins.github.mutations.commentCreate.confirmation.body',
          fallback: 'Your comment is added to this conversation on GitHub for everyone who can see it.',
        },
        confirmLabel: { key: 'plugins.github.mutations.commentCreate.confirmation.confirmLabel', fallback: 'Post comment' },
      },
      inputSchema: GithubCommentCreateInputV1Schema.jsonSchema,
      resultSchema: GithubCommentCreateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).createGithubCommentAction(input, context),
    },
    // The issue writes. Each is `writesRemote`: it moves remote state, summons
    // nobody, and is reversible through the Action that undoes it. Every one of
    // them is an exact transition or an exact delta — none can express a desired
    // full set, so a concurrent unrelated assignee or label always survives.
    [GITHUB_TRIAGE_ACTION_IDS_V1.create]: {
      title: 'Create a GitHub issue',
      description: 'Creates one issue in the selected GitHub repository.',
      surfaces: sources.operations.create.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.create.declaration.dangerLevel,
      confirmation: {
        title: { key: 'plugins.github.mutations.issueCreate.confirmation.title', fallback: 'Create this issue?' },
        body: { key: 'plugins.github.mutations.issueCreate.confirmation.body', fallback: 'This creates a new issue on GitHub in the repository you selected.' },
        confirmLabel: { key: 'plugins.github.mutations.issueCreate.confirmation.confirmLabel', fallback: 'Create' },
      },
      inputSchema: TriageSourceCredentialInputsV1.create.jsonSchema,
      resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).createGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.edit]: {
      title: 'Edit a GitHub issue',
      description: 'Edits issue content and applies exact assignee and label changes on GitHub.',
      surfaces: sources.operations.edit.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.edit.declaration.dangerLevel,
      confirmation: {
        title: { key: 'plugins.github.mutations.issueEdit.confirmation.title', fallback: 'Save these issue changes?' },
        body: { key: 'plugins.github.mutations.issueEdit.confirmation.body', fallback: 'This updates the selected issue on GitHub with the fields you chose.' },
        confirmLabel: { key: 'plugins.github.mutations.issueEdit.confirmation.confirmLabel', fallback: 'Save changes' },
      },
      inputSchema: TriageSourceCredentialInputsV1.edit.jsonSchema,
      resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).editGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_ACTION_IDS_V1.transition]: {
      title: 'Change GitHub issue status',
      description: 'Opens an issue or closes it with the selected native GitHub reason.',
      surfaces: sources.operations.transition.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.transition.declaration.dangerLevel,
      confirmation: {
        title: { key: 'plugins.github.mutations.issueTransition.confirmation.title', fallback: 'Change this issue status?' },
        body: { key: 'plugins.github.mutations.issueTransition.confirmation.body', fallback: 'This changes the issue status on GitHub using the transition you selected.' },
        confirmLabel: { key: 'plugins.github.mutations.issueTransition.confirmation.confirmLabel', fallback: 'Change status' },
      },
      inputSchema: TriageSourceCredentialInputsV1.transition.jsonSchema,
      resultSchema: TriageTaskWriteResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).transitionGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueClose]: {
      title: 'Close this issue',
      description: 'Closes one open GitHub issue with the reason you choose, which everyone watching it sees.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubIssueCloseInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).closeGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueReopen]: {
      title: 'Reopen this issue',
      description: 'Reopens one closed GitHub issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
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
      inputSchema: GithubIssueReopenInputV1Schema.jsonSchema,
      resultSchema: GithubPullRequestStateResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).reopenGithubIssueAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeAdd]: {
      title: 'Assign people',
      description: 'Assigns exactly the named GitHub users to this issue or pull request, leaving other assignees untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueAssigneeAdd.confirmation.title',
          fallback: 'Assign these people?',
        },
        body: {
          key: 'plugins.github.mutations.issueAssigneeAdd.confirmation.body',
          fallback: 'Everyone you named is assigned to this issue or pull request on GitHub and is notified. Other assignees are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueAssigneeAdd.confirmation.confirmLabel',
          fallback: 'Assign',
        },
      },
      inputSchema: GithubIssueAssigneeAddInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubIssueAssigneesAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeRemove]: {
      title: 'Unassign people',
      description: 'Unassigns exactly the named GitHub users from this issue or pull request, leaving other assignees untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueAssigneeRemove.confirmation.title',
          fallback: 'Unassign these people?',
        },
        body: {
          key: 'plugins.github.mutations.issueAssigneeRemove.confirmation.body',
          fallback: 'Everyone you named stops being assigned to this issue or pull request on GitHub. Other assignees are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueAssigneeRemove.confirmation.confirmLabel',
          fallback: 'Unassign',
        },
      },
      inputSchema: GithubIssueAssigneeRemoveInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubIssueAssigneesAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelAdd]: {
      title: 'Add labels',
      description: 'Adds exactly the named labels to this issue or pull request, leaving other labels untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueLabelAdd.confirmation.title',
          fallback: 'Add these labels?',
        },
        body: {
          key: 'plugins.github.mutations.issueLabelAdd.confirmation.body',
          fallback: 'Exactly the labels you named are added to this issue or pull request on GitHub. Other labels are left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueLabelAdd.confirmation.confirmLabel',
          fallback: 'Add labels',
        },
      },
      inputSchema: GithubIssueLabelAddInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).addGithubIssueLabelsAction(input, context),
    },
    [GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelRemove]: {
      title: 'Remove a label',
      description: 'Removes exactly one named label from this issue or pull request, leaving every other label untouched.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: ['detailsPanel'],
      dangerLevel: 'writesRemote',
      confirmation: {
        title: {
          key: 'plugins.github.mutations.issueLabelRemove.confirmation.title',
          fallback: 'Remove this label?',
        },
        body: {
          key: 'plugins.github.mutations.issueLabelRemove.confirmation.body',
          fallback: 'Exactly the label you named is removed from this issue or pull request on GitHub. Every other label is left alone.',
        },
        confirmLabel: {
          key: 'plugins.github.mutations.issueLabelRemove.confirmation.confirmLabel',
          fallback: 'Remove label',
        },
      },
      inputSchema: GithubIssueLabelRemoveInputV1Schema.jsonSchema,
      resultSchema: GithubIssueDeltaResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./triage/mutationOperations.js')).removeGithubIssueLabelAction(input, context),
    },
    [GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID]: {
      title: 'Run GitHub repository Event source attempt',
      description: 'Runs one GitHub repository Event source attempt.',
      surfaces: ['plugin'],
      inputSchema: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_INPUT_SCHEMA,
      resultSchema: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_RESULT_SCHEMA,
      hostAccess: [
        'github-api',
        GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        'automation-event-checkpoint-storage',
      ],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        nativeServicePath: 'nativeService',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      run: runGithubAutomationEventSourceAttempt,
    },
    [GITHUB_WEBHOOK_ACTION_ID]: {
      title: 'Receive GitHub webhook',
      description: 'Receives one GitHub webhook delivery for processing.',
      inputSchema: GITHUB_WEBHOOK_ACTION_INPUT_SCHEMA,
      resultSchema: GITHUB_WEBHOOK_ACTION_RESULT_SCHEMA,
      surfaces: ['plugin'],
      run: receiveGithubWebhook,
    },
    [GITHUB_CHANNEL_ACTION_IDS.setup]: {
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          credentialRef: { anyOf: [QualifiedConnectedAccountRefJsonSchema, { type: 'null' }] },
          repository: GITHUB_REPOSITORY_INPUT_SCHEMA,
        },
        required: ['repository'],
      },
      title: 'Set up GitHub Channels',
      description: 'Verifies the selected GitHub repository for Channels setup.',
      resultSchema: providers.operations.setup.declaration.resultSchema.jsonSchema,
      surfaces: providers.operations.setup.declaration.surfaces,
      // This transport input also admits the machine-native service. Its
      // semantic purpose binding selects credentials; an Account-only select
      // form cannot describe the nullable native credential operand.
      inputHints: { fields: GITHUB_REPOSITORY_SETUP_INPUT_HINTS.fields.filter(field => field.path !== 'credentialRef') },
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.setup.declaration.dangerLevel,
      run: setupGithubChannels,
    },
    [GITHUB_CHECKS_WAIT_ACTION_ID]: {
      title: 'Wait for GitHub pull request checks',
      description: 'Observes an admitted GitHub checks source checkpoint. Cancellation and timeout stop observation only.',
      surfaces: ['plugin', 'cli', 'mcp', 'agent'], inputSchema: GITHUB_CHECKS_WAIT_INPUT_SCHEMA, resultSchema: GITHUB_CHECKS_WAIT_RESULT_SCHEMA,
      hostAccess: ['automation-event-checkpoint-storage'], run: waitGithubChecksSource,
    },
    [GITHUB_CHECKS_SETUP_ACTION_ID]: {
      title: 'Set up GitHub pull request checks',
      description: 'Binds checks observation to the chosen pull request head and all or required checks.',
      surfaces: ['plugin'],
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { credentialRef: QualifiedConnectedAccountRefJsonSchema, repository: GITHUB_REPOSITORY_INPUT_SCHEMA, checks: GITHUB_CHECKS_SOURCE_SCHEMA },
        required: ['credentialRef', 'repository', 'checks'],
      },
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION, GITHUB_CHECKS_SOURCE_CONFIG_SCHEMA),
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }],
      run: setupGithubPullRequestChecksSource,
    },
    [GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID]: {
      title: 'Set up GitHub repository Event source',
      description: 'Resolves a GitHub repository to immutable source facts for an Automation Event.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'],
      dangerLevel: 'safe',
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
      run: setupGithubRepositoryEventSource,
    },
    [GITHUB_DEPLOYMENT_REVIEW_SETUP_ACTION_ID]: {
      title: 'Set up GitHub deployment review Event source',
      description: 'Resolves one repository, exact Connected Account and monitoring Machine through the existing repository setup owner.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe',
      inputSchema: githubCredentialInputSchema({ repository: GITHUB_REPOSITORY_INPUT_SCHEMA,
        deploymentReview: GithubDeploymentMonitoringSelectionV1Schema.jsonSchema }, ['repository']),
      // The declared nativeServicePath gives this existing chooser an exact
      // native-service option alongside its qualified Connected Accounts.
      inputHints: GITHUB_REPOSITORY_SETUP_INPUT_HINTS,
      resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONTRACT_VERSION, GITHUB_DEPLOYMENT_SOURCE_CONFIG_SCHEMA),
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{ path: 'credentialRef', nativeServicePath: 'nativeService', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }],
      run: setupGithubDeploymentReviewEventSource,
    },
    [GITHUB_AUTOMATION_REPOSITORY_BASELINE_RESET_ACTION_ID]: {
      title: 'Start a new GitHub repository Event baseline',
      description: 'Explicitly replaces a GitHub Event history gap with an authenticated current-head baseline. Events in the gap are not replayed.',
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
      run: resetGithubRepositoryEventHistoryGap,
    },
    [GITHUB_CHANNEL_ACTION_IDS.connectionTest]: {
      inputSchema: providers.operations.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.connectionTest.declaration.resultSchema.jsonSchema,
      title: 'Test GitHub Channel connection',
      description: 'Tests the selected GitHub Channel connection.',
      surfaces: providers.operations.connectionTest.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.connectionTest.declaration.dangerLevel,
      run: testGithubChannelConnection,
    },
    [GITHUB_CHANNEL_ACTION_IDS.endpointResolve]: {
      inputSchema: providers.operations.endpointResolve.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.endpointResolve.declaration.resultSchema.jsonSchema,
      title: 'Resolve GitHub issue or pull request',
      description: 'Resolves a GitHub issue or pull request destination.',
      surfaces: providers.operations.endpointResolve.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.endpointResolve.declaration.dangerLevel,
      run: resolveGithubChannelEndpoint,
    },
    [GITHUB_CHANNEL_ACTION_IDS.principalResolve]: {
      inputSchema: providers.operations.principalResolve.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.principalResolve.declaration.resultSchema.jsonSchema,
      title: 'Resolve GitHub principal',
      description: 'Resolves a GitHub principal for the selected repository.',
      surfaces: providers.operations.principalResolve.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.principalResolve.declaration.dangerLevel,
      run: resolveGithubChannelPrincipal,
    },
    [GITHUB_CHANNEL_ACTION_IDS.observationsPoll]: {
      inputSchema: providers.operations.observationsPoll.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.observationsPoll.declaration.resultSchema.jsonSchema,
      title: 'Poll GitHub issue comments',
      description: 'Polls the selected GitHub issue or pull request for new comments.',
      surfaces: providers.operations.observationsPoll.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.observationsPoll.declaration.dangerLevel,
      run: pollGithubChannelObservations,
    },
    [GITHUB_CHANNEL_ACTION_IDS.messageDeliver]: {
      inputSchema: providers.operations.messageDeliver.declaration.input.schema.jsonSchema,
      resultSchema: providers.operations.messageDeliver.declaration.resultSchema.jsonSchema,
      title: 'Deliver GitHub issue or pull-request comment',
      description: 'Delivers a comment to the selected GitHub issue or pull request.',
      surfaces: providers.operations.messageDeliver.declaration.surfaces,
      hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
      connectedAccountPurposeBindings: [{
        path: 'credentialRef',
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      }],
      dangerLevel: providers.operations.messageDeliver.declaration.dangerLevel,
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
  notifications: {
    [GITHUB_DEPLOYMENT_REVIEW_CATEGORY_ID]: { kind: 'approval', title: 'Deployment reviews',
      description: 'Pending GitHub deployment reviews. Open the review before allowing or denying.',
      eventIds: ['automation/deployment-review-v1'],
      // No page override: both buttons open this notice's exact admitted locator.
      buttons: [
        { id: 'allow', label: { key: 'plugins.github.deploymentReview.allow', fallback: 'Allow' }, effect: { kind: 'open' } },
        { id: 'deny', label: { key: 'plugins.github.deploymentReview.deny', fallback: 'Deny' }, effect: { kind: 'open' } },
      ],
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
            supportedObservationTransports: isGithubChecksEvent(event.localId) ? ['checkpointedPull'] : ['checkpointedPull', 'durablePush'],
            ...(isGithubChecksEvent(event.localId) ? {} : { webhookContributionRef: {
              pluginId: GITHUB_PLUGIN_ID,
              localId: GITHUB_WEBHOOK_CONTRIBUTION_ID,
            } }),
            sourceConfigSchema: isGithubChecksEvent(event.localId) ? GITHUB_CHECKS_SOURCE_CONFIG_SCHEMA : event.kind === 'deploymentReview' ? GITHUB_DEPLOYMENT_SOURCE_CONFIG_SCHEMA : GITHUB_AUTOMATION_REPOSITORY_SOURCE_CONFIG_SCHEMA,
            setupActionRef: {
              pluginId: GITHUB_PLUGIN_ID,
              localId: isGithubChecksEvent(event.localId) ? GITHUB_CHECKS_SETUP_ACTION_ID
                : event.kind === 'deploymentReview' ? GITHUB_DEPLOYMENT_REVIEW_SETUP_ACTION_ID : GITHUB_AUTOMATION_REPOSITORY_SETUP_ACTION_ID,
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
        resolveRefAction: GITHUB_OVERVIEW_TARGET_ACTION_ID,
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
          native: { systemTool: 'gh' },
          account: { artifactId: 'github-account-runtime', exportName: 'activate' },
          defaultModeId: 'fine-grained-pat',
          modes: [{
            id: 'fine-grained-pat',
            kind: 'manual',
            setup: {
              url: 'https://github.com/settings/personal-access-tokens/new',
              checklist: ['Generate a fine-grained personal access token and choose its resource owner, repositories, and expiration.', 'Grant the repository and organization permissions needed for the actions you want to use; an organization may require approval.', 'Copy the generated token and paste it here.'],
              createKeyTitle: 'Open GitHub fine-grained tokens',
            },
            credentialOrigin: 'authentication',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: 'Fine-grained personal access token',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'token',
              title: 'Fine-grained personal access token',
              description: 'A GitHub fine-grained personal access token with access to the repositories you use in Happier.',
              schema: { type: 'string', minLength: 1 },
              secret: true,
            }],
          }, {
            id: 'native-import',
            kind: 'manual',
            setup: {
              url: 'https://cli.github.com/manual/gh_auth_login',
              checklist: ['On the computer you will import from, run gh auth login and complete the GitHub sign-in.', 'Choose that computer in Happier to import its saved GitHub CLI login.'],
              createKeyTitle: 'Read GitHub CLI login instructions',
            },
            credentialOrigin: 'native_import',
            directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
            title: 'Import GitHub CLI login',
            outcomeReconciliation: 'none',
            fields: [{
              id: 'source',
              title: 'Source',
              description: 'Save this machine’s GitHub CLI login as a connected GitHub account in Happier.',
              schema: { type: 'string', enum: ['native'] },
              secret: false,
              default: 'native',
              presentation: { control: 'select', options: [{ value: 'native', title: 'GitHub CLI login' }] },
            }],
          }],
        },
        capabilities: ['scmHostingToken'],
      },
      runtime: githubConnectedAccountRuntime,
      accountRuntime: githubAccountCredentialRuntime,
    },
  },
  contributesTo: {
    [TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1]: {
      [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: {
        [GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1]: sources.contribute({
          descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
          operations: {
            create: sources.operations.create.bind(GITHUB_TRIAGE_ACTION_IDS_V1.create),
            edit: sources.operations.edit.bind(GITHUB_TRIAGE_ACTION_IDS_V1.edit),
            transition: sources.operations.transition.bind(GITHUB_TRIAGE_ACTION_IDS_V1.transition),
            listScopeUnits: sources.operations.listScopeUnits.bind(GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits),
            listInstances: sources.operations.listInstances
              .bind(GITHUB_TRIAGE_ACTION_IDS_V1.listInstances),
            scan: sources.operations.scan.bind(GITHUB_TRIAGE_ACTION_IDS_V1.scan),
            resolveResource: sources.operations.resolveResource.bind(GITHUB_TRIAGE_ACTION_IDS_V1.resolveResource),
            readAttention: sources.operations.readAttention.bind(GITHUB_TRIAGE_ACTION_IDS_V1.readAttention),
            get: sources.operations.get.bind(GITHUB_TRIAGE_ACTION_IDS_V1.get),
            linkSession: sources.operations.linkSession.bind(GITHUB_TRIAGE_ACTION_IDS_V1.linkSession),
            readSessionLinks: sources.operations.readSessionLinks.bind(GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks),
            readFixPullRequests: sources.operations.readFixPullRequests.bind(GITHUB_TRIAGE_ACTION_IDS_V1.readFixPullRequests),
            readPullRequestStatus: sources.operations.readPullRequestStatus
              .bind(GITHUB_TRIAGE_ACTION_IDS_V1.readPullRequestStatus),
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
          descriptor: { v: 1, displayName: 'GitHub', pullRequests: GITHUB_CHANNEL_PULL_REQUESTS },
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

export const GITHUB_PLUGIN = { ...createGithubPlugin(), activateAccount: activateGithubAccountRuntime };

export const PLUGIN_MANIFEST = GITHUB_PLUGIN.manifest;

/**
 * The executable half of the declared Account Collections. The host projects
 * this against the parsed manifest declarations before a candidate may load,
 * so it must travel with the manifest rather than be derived by consumers.
 */
export const collectionMigrations = GITHUB_PLUGIN.collectionMigrations;
