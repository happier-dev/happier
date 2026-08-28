import type {
  JsonValue,
  PluginInvocationContext,
  TargetedContributionPointRef,
} from '@happier-dev/plugin-sdk';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import {
  MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
  PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
  type PluginDynamicResourceRuntime,
} from '@happier-dev/plugin-sdk/resources';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import {
  COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
  MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
} from '@happier-dev/plugin-sdk/ui';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationProviderConnectionReadInputV1Schema,
  ConversationProviderConnectionReadResultV1Schema,
  ConversationProviderConnectionsListInputV1Schema,
  ConversationProviderConnectionsListResultV1Schema,
  ConversationProviderObservationIngestInputV1Schema,
} from '@happier-dev/channels-protocol/v1';

import { deliverConversationAutomationResultForInvocation } from './automationResultDelivery.js';
import { BINDINGS_RESOURCE_RUNTIME } from './bindingsResource.js';
import { createIngressSupervisor } from './checkpointedPollSupervisor.js';
import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_COLLECTION_ID,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_COLLECTION_ID,
} from './collections.js';
import { CONNECTIONS_RESOURCE_RUNTIME } from './connectionsResource.js';
import {
  acceptConversationStreamBaselineForInvocation,
  createConversationProviderObservationIngestHandler,
  retryConversationIngressForInvocation,
} from './ingress.js';
import {
  abandonConversationConnectionForInvocation,
  acceptConversationSessionProjectionBaselineForInvocation,
  createConversationBindingForInvocation,
  createConversationConnectionForInvocation,
  createConversationPairingManagementHandlers,
  createConversationPairingManagerForActivation,
  deleteConversationBindingForInvocation,
  deleteConversationConnectionForInvocation,
  prepareConversationConnectionForInvocation,
  readConversationBindingForInvocation,
  reportConversationTransportFactForInvocation,
  resolveConversationBindingForInvocation,
  resolveConversationDeliveryForInvocation,
  retestConversationConnectionForInvocation,
  retryConversationConnectionPollForInvocation,
  setConversationBindingEnabledForInvocation,
  transferConversationConnectionForInvocation,
  updateConversationBindingForInvocation,
  updateConversationConnectionForInvocation,
} from './management.js';
import { createConversationOutwardDeliverySupervisor } from './outwardDeliverySupervisor.js';
import { createConversationPairingResourceRuntime } from './pairingResource.js';
import {
  listConversationProviderConnectionsForInvocation,
  readConversationProviderConnectionForInvocation,
} from './reconciliation.js';
import { MAX_CHANNELS_BINDINGS_RESOURCE_BYTES } from './resourceBounds.js';
import {
  CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID,
  TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME,
} from './transcriptActivitiesResource.js';
import {
  MAX_CHANNELS_SESSION_CONVERSATIONS_BYTES,
  SESSION_CONVERSATIONS_ATTENTION_CONTROL_STATE_RESOURCE_RUNTIME,
  SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME,
  SESSION_CONVERSATIONS_RESOURCE_RUNTIME,
} from './sessionConversationsResource.js';
import {
  CHANNELS_SESSION_INFO_RESOURCE_ID,
  CHANNELS_SESSION_INFO_RESOURCE_MAX_BYTES,
  SESSION_INFO_RESOURCE_RUNTIME,
} from './sessionInfoResource.js';
import {
  CHANNELS_SESSION_COMPOSER_ATTENTION_CONTROL_ID,
  CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID,
  CHANNELS_SESSION_COMPOSER_CONTROL_ID,
  CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_HEADER_ACTION_ID,
  CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
  CHANNELS_SETTINGS_PAGE_ID,
} from './sessionSurfaceIds.js';
import { CHANNELS_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import {
  CHANNELS_PROVIDER_POINT_ID,
  PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
} from './targetedContributions.js';

export { CHANNELS_PROVIDER_POINT_ID } from './targetedContributions.js';

export const CHANNELS_PLUGIN_ID = 'happier.channels';
export const CHANNELS_NATIVE_BUNDLE_ID = 'channels-app-native';
export const CHANNELS_RENDERER_ID = 'channels-renderer';
export const CHANNELS_SETTINGS_GROUP_ID = 'channels';

/**
 * The Session-facing destinations. All three entry points — the Session-header
 * catalog entry and both Composer chips — open this ONE generic
 * `rightSidebarTab`/`session` destination, so Channels never adds a second
 * Session navigation owner.
 */
export {
  CHANNELS_SETTINGS_PAGE_ID,
  CHANNELS_SESSION_COMPOSER_ATTENTION_CONTROL_ID,
  CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID,
  CHANNELS_SESSION_COMPOSER_CONTROL_ID,
  CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_HEADER_ACTION_ID,
  CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
} from './sessionSurfaceIds.js';

/**
 * The sole provider discovery authority for Channels runtime work. The host
 * supplies its immutable admitted snapshot; Channels selects only within it.
 */
/**
 * The generic Settings catalog owns the route and availability decision. This
 * contribution supplies one native renderer and one page, rather than a
 * Channels-specific route, Resource store, or connection cache.
 */
export const CHANNELS_UI = {
  views: [{
    id: CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
    container: 'rightSidebarTab' as const,
    target: { kind: 'session' as const },
    // The same artifact serves Settings and the Session destination; the
    // host-stamped mount context is what distinguishes them.
    renderer: CHANNELS_RENDERER_ID,
    title: {
      key: 'plugins.channels.session.title',
      fallback: 'External conversations',
    },
    icon: 'globe' as const,
  }],
  renderers: [{
    id: CHANNELS_RENDERER_ID,
    kind: 'reactNative' as const,
    artifact: CHANNELS_NATIVE_BUNDLE_ID,
    // Resources and Actions are opportunistic daemon capabilities. This
    // Account-Collection renderer remains useful cold offline through the
    // admitted direct Data client, so declaring either as a mount requirement
    // would make the manifest contradict its real supported lifecycle.
    requiredHostMethods: [],
  }],
  settingsGroups: [{
    id: CHANNELS_SETTINGS_GROUP_ID,
    title: { key: 'plugins.channels.title', fallback: 'Conversation Channels' },
    icon: 'settings' as const,
    defaultRank: 20,
  }],
  settingsPages: [{
    id: CHANNELS_SETTINGS_PAGE_ID,
    group: { kind: 'plugin' as const, localId: CHANNELS_SETTINGS_GROUP_ID },
    title: { key: 'plugins.channels.settings.connections', fallback: 'Connections' },
    subtitle: {
      key: 'plugins.channels.settings.connections.subtitle',
      fallback: 'Account policy for external conversation integrations.',
    },
    keywords: ['conversation', 'channels', 'connections'],
    icon: 'settings' as const,
    defaultRank: 20,
    renderer: CHANNELS_RENDERER_ID,
  }],
  translations: CHANNELS_UI_TRANSLATION_BUNDLES,
};

/**
 * Per-generation Channels runtime state.
 *
 * Declarations are static, so every registration that needs activation-scoped
 * state — the pairing manager and the two persisted-work supervisors — is
 * declared as a static delegate and dereferences the generation `setup`
 * established. Closing over the state directly would make one process-wide
 * pairing manager serve every activation.
 */
type ChannelsPluginActivationRuntime = Readonly<{
  pairingHandlers: ReturnType<typeof createConversationPairingManagementHandlers>;
  pairingResource: PluginDynamicResourceRuntime;
  ingestProviderObservation: ReturnType<typeof createConversationProviderObservationIngestHandler>;
  ingressSupervisor: ReturnType<typeof createIngressSupervisor>;
  outwardDeliverySupervisor: ReturnType<typeof createConversationOutwardDeliverySupervisor>;
  dispose: () => Promise<void>;
}>;

/**
 * The Channels core owns durable Account state and the strict caller-filtered
 * provider reconciliation Actions. Its management Resource projects only
 * safe local Account facts; provider list/read remain the reconciliation
 * authority and do not consume this Resource.
 *
 * `definePlugin` is the one author path: it projects the cold manifest, the
 * generated activation, the target-owned provider contribution point reference
 * and the executable Collection-migration half from these same declarations.
 * No Channels contribution is declared from a second manifest and no Channels
 * registration is written by hand.
 */
function createChannelsPlugin() {
  let activeChannelsPluginRuntime: ChannelsPluginActivationRuntime | null = null;

  function requireActiveChannelsPluginRuntime(): ChannelsPluginActivationRuntime {
    if (activeChannelsPluginRuntime === null) {
      throw new Error('Channels plugin runtime is unavailable outside an active plugin generation');
    }
    return activeChannelsPluginRuntime;
  }

  async function createConversationPairingForInvocation(input: JsonValue, context: PluginInvocationContext) {
    return await requireActiveChannelsPluginRuntime().pairingHandlers.create(input, context);
  }

  async function finalizeConversationPairingForInvocation(input: JsonValue, context: PluginInvocationContext) {
    return await requireActiveChannelsPluginRuntime().pairingHandlers.finalize(input, context);
  }

  async function cancelConversationPairingForInvocation(input: JsonValue, context: PluginInvocationContext) {
    return await requireActiveChannelsPluginRuntime().pairingHandlers.cancel(input, context);
  }

  const ingestConversationProviderObservationForInvocation: ActionHandler<
    ReturnType<typeof ConversationProviderObservationIngestInputV1Schema.parse>,
    void
  > = async (input, context) => {
    await requireActiveChannelsPluginRuntime().ingestProviderObservation(input, context);
  };

  const PAIRING_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = Object.freeze({
    read: async (options) => await requireActiveChannelsPluginRuntime().pairingResource.read(options),
    observe: (invalidate, options) => (
      requireActiveChannelsPluginRuntime().pairingResource.observe(invalidate, options)
    ),
  });

  async function runConversationIngressSupervisor(context: BackgroundServiceContext): Promise<void> {
    await requireActiveChannelsPluginRuntime().ingressSupervisor.run(context);
  }

  async function runConversationOutwardDeliverySupervisor(context: BackgroundServiceContext): Promise<void> {
    await requireActiveChannelsPluginRuntime().outwardDeliverySupervisor.run(context);
  }

  function setupChannelsPluginGeneration(): () => Promise<void> {
    // Each activation takes the generation, exactly as the hand-written spine
    // did when it built a fresh pairing manager and supervisor pair per call.
    const pairing = createConversationPairingManagerForActivation();
    const ingressSupervisor = createIngressSupervisor({ pairing });
    const outwardDeliverySupervisor = createConversationOutwardDeliverySupervisor();
    const runtime: ChannelsPluginActivationRuntime = Object.freeze({
      pairingHandlers: createConversationPairingManagementHandlers(pairing),
      pairingResource: createConversationPairingResourceRuntime(pairing),
      ingestProviderObservation: createConversationProviderObservationIngestHandler(pairing),
      ingressSupervisor,
      outwardDeliverySupervisor,
      dispose: async () => {
        await outwardDeliverySupervisor.dispose();
        await ingressSupervisor.dispose();
        pairing.dispose();
      },
    });
    activeChannelsPluginRuntime = runtime;
    return async () => {
      if (activeChannelsPluginRuntime === runtime) activeChannelsPluginRuntime = null;
      await runtime.dispose();
    };
  }

  return definePlugin({
    id: CHANNELS_PLUGIN_ID,
    version: '0.0.0',
    displayName: 'Conversation Channels',
    description: 'Connects external conversations to Happier sessions and automations.',
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: {
      required: [{
        id: 'account-storage',
        capability: 'storage.account',
        reason: 'Read current Channel connection and binding state.',
        scope: { enabled: true },
      }],
      optional: [],
    },
    accountCollections: {
      [CHANNEL_STATE_COLLECTION_ID]: CHANNEL_STATE_COLLECTION,
      [CHANNEL_DELIVERIES_COLLECTION_ID]: CHANNEL_DELIVERIES_COLLECTION,
    },
    contributionPoints: PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
    resources: {
      'connections-v1': {
        source: 'dynamic',
        kind: 'config',
        scope: 'global',
        contentType: 'application/json',
        maxBytes: 196_608,
        hostAccess: ['account-storage'],
        runtime: CONNECTIONS_RESOURCE_RUNTIME,
      },
      'bindings-v1': {
        source: 'dynamic',
        kind: 'config',
        scope: 'global',
        contentType: 'application/json',
        maxBytes: MAX_CHANNELS_BINDINGS_RESOURCE_BYTES,
        hostAccess: ['account-storage'],
        runtime: BINDINGS_RESOURCE_RUNTIME,
      },
      'pairing-v1': {
        source: 'dynamic',
        kind: 'config',
        scope: 'global',
        contentType: 'application/json',
        maxBytes: 524_288,
        hostAccess: ['account-storage'],
        runtime: PAIRING_RESOURCE_RUNTIME,
      },
      [CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID]: {
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
        maxBytes: MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
        hostAccess: ['account-storage'],
        runtime: TRANSCRIPT_ACTIVITIES_RESOURCE_RUNTIME,
      },
      [CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID]: {
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/json',
        maxBytes: MAX_CHANNELS_SESSION_CONVERSATIONS_BYTES,
        hostAccess: ['account-storage'],
        runtime: SESSION_CONVERSATIONS_RESOURCE_RUNTIME,
      },
      [CHANNELS_SESSION_INFO_RESOURCE_ID]: {
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
        maxBytes: CHANNELS_SESSION_INFO_RESOURCE_MAX_BYTES,
        hostAccess: ['account-storage'],
        runtime: SESSION_INFO_RESOURCE_RUNTIME,
      },
      [CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID]: {
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
        maxBytes: MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
        hostAccess: ['account-storage'],
        runtime: SESSION_CONVERSATIONS_CONTROL_STATE_RESOURCE_RUNTIME,
      },
      [CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID]: {
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
        maxBytes: MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
        hostAccess: ['account-storage'],
        runtime: SESSION_CONVERSATIONS_ATTENTION_CONTROL_STATE_RESOURCE_RUNTIME,
      },
    },
    sessionHeaderActions: {
      [CHANNELS_SESSION_CONVERSATIONS_HEADER_ACTION_ID]: {
        title: {
          key: 'plugins.channels.session.title',
          fallback: 'External conversations',
        },
        icon: 'globe',
        command: {
          kind: 'openSurface',
          destination: CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
        },
      },
    },
    composer: {
      controls: {
        [CHANNELS_SESSION_COMPOSER_CONTROL_ID]: {
          label: {
            key: 'plugins.channels.session.composerChip',
            fallback: 'External conversations',
          },
          icon: 'globe',
          // Only a Session Composer can carry a Session binding. An absent
          // `scopes` would be the widest policy, offering the chip on the
          // new-Session and Automation-authoring drafts it cannot describe.
          scopes: ['session'],
          state: { resource: CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID },
          interaction: {
            kind: 'destination',
            destination: CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
          },
        },
        [CHANNELS_SESSION_COMPOSER_ATTENTION_CONTROL_ID]: {
          label: {
            key: 'plugins.channels.session.composerChipAttention',
            fallback: 'External delivery needs attention',
          },
          icon: 'warning',
          scopes: ['session'],
          state: { resource: CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID },
          interaction: {
            kind: 'destination',
            destination: CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
          },
        },
      },
    },
    transcriptActivities: {
      'outward-delivery': {
        resourceId: CHANNELS_TRANSCRIPT_ACTIVITIES_RESOURCE_ID,
        actions: [],
      },
    },
    sessionInfoSections: {
      'external-conversations': {
        resourceId: CHANNELS_SESSION_INFO_RESOURCE_ID,
        order: 50,
        actions: [],
      },
    },
    ui: CHANNELS_UI,
    actions: {
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPairingCreate,
        title: 'Create conversation pairing challenge',
        description: 'Creates a short-lived pairing challenge for a conversation connection.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Create conversation pairing challenge?',
          body: 'This creates a short-lived pairing challenge for the selected connection.',
          confirmLabel: 'Create challenge',
        },
        hostAccess: ['account-storage'],
        run: createConversationPairingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPairingFinalize,
        title: 'Finalize conversation pairing',
        description: 'Saves an authenticated pairing proposal as a paused conversation binding.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Finalize conversation pairing?',
          body: 'This saves the authenticated pairing proposal as a paused conversation binding.',
          confirmLabel: 'Finalize pairing',
        },
        hostAccess: ['account-storage'],
        run: finalizeConversationPairingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPairingCancel,
        title: 'Cancel conversation pairing',
        description: 'Cancels an unfinished conversation pairing challenge or proposal.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Cancel conversation pairing?',
          body: 'This cancels the selected unfinished pairing challenge or proposal.',
          confirmLabel: 'Cancel pairing',
        },
        hostAccess: ['account-storage'],
        run: cancelConversationPairingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionCreate,
        title: 'Create conversation connection',
        description: 'Saves a conversation connection and its transport configuration to the Account.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Create conversation connection?',
          body: 'This saves the connection and its current transport configuration to this Happier Account.',
          confirmLabel: 'Create connection',
        },
        hostAccess: ['account-storage'],
        run: createConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionTransfer,
        title: 'Transfer conversation connection',
        description: 'Replaces a conversation connection’s provider setup and transport.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Transfer conversation connection?',
          body: 'This replaces the saved provider setup and transport while retaining exact old-stop custody.',
          confirmLabel: 'Transfer connection',
        },
        hostAccess: ['account-storage'],
        run: transferConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPrepare,
        title: 'Prepare conversation connection',
        description: 'Prepares the selected conversation provider connection for setup.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        run: prepareConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionRetest]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionRetest,
        title: 'Retest conversation connection',
        description: 'Re-probes a conversation connection and reconciles its readiness.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        // The only Account write a retest can make is to the retained
        // readiness attention on the connection it re-probed: clearing the one
        // the provider itself just contradicted, or recording the narrowing
        // its restated capability proves against saved bindings. It touches no
        // setup, credential, transport, policy or binding state, so it stays a
        // diagnostic the user can run without a confirmation step.
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: retestConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionUpdate,
        title: 'Update conversation connection',
        description: 'Saves an edited conversation connection policy to the Account.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Update conversation connection?',
          body: 'This saves the edited connection policy to this Happier Account.',
          confirmLabel: 'Update connection',
        },
        hostAccess: ['account-storage'],
        run: updateConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionDelete,
        title: 'Delete conversation connection',
        description: 'Disables and removes a conversation connection after transport cleanup.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Delete conversation connection?',
          body: 'This disables the connection and waits for exact transport-stop proof before cleanup.',
          confirmLabel: 'Delete connection',
        },
        hostAccess: ['account-storage'],
        run: deleteConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionAbandon,
        title: 'Abandon pending conversation connection stop',
        description: 'Accepts possible message loss so a pending connection stop can proceed.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Accept possible message loss?',
          body: 'This permits the connection lifecycle to continue without claiming the old physical transport stopped.',
          confirmLabel: 'Accept possible loss',
        },
        hostAccess: ['account-storage'],
        run: abandonConversationConnectionForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.streamBaselineAccept,
        title: 'Accept conversation history baseline',
        description: 'Accepts the provider’s current replay baseline without replaying unavailable history.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Accept a new conversation history baseline?',
          body: 'This accepts the provider’s current replay baseline and resumes the saved connection without replaying unavailable history.',
          confirmLabel: 'Accept baseline',
        },
        hostAccess: ['account-storage'],
        run: acceptConversationStreamBaselineForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPollRetry,
        title: 'Retry blocked conversation poll',
        description: 'Clears blocked poll state so the conversation connection can retry.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Retry this blocked conversation poll?',
          body: 'This clears the saved blocked poll state so the current connection can retry it.',
          confirmLabel: 'Retry poll',
        },
        hostAccess: ['account-storage'],
        run: retryConversationConnectionPollForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingRead,
        title: 'Read conversation binding',
        description: 'Reads the saved conversation binding policy and details.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: readConversationBindingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingResolve,
        title: 'Resolve conversation binding candidates',
        description: 'Resolves candidate conversations and principals for a binding.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: resolveConversationBindingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingCreate,
        title: 'Create conversation binding',
        description: 'Saves an external conversation binding and its target policy to the Account.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Create conversation binding?',
          body: 'This saves the external conversation binding and its target policy to this Happier Account.',
          confirmLabel: 'Create binding',
        },
        hostAccess: ['account-storage'],
        run: createConversationBindingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingUpdate,
        title: 'Update conversation binding',
        description: 'Saves an edited external conversation binding policy to the Account.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Update conversation binding?',
          body: 'This saves the edited external conversation binding policy to this Happier Account.',
          confirmLabel: 'Update binding',
        },
        hostAccess: ['account-storage'],
        run: updateConversationBindingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingSetEnabled,
        title: 'Set conversation binding enabled state',
        description: 'Changes whether a conversation binding may route eligible messages.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Change conversation binding enabled state?',
          body: 'This changes whether the binding may route eligible external messages to its saved target.',
          confirmLabel: 'Save binding state',
        },
        hostAccess: ['account-storage'],
        run: setConversationBindingEnabledForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingDelete,
        title: 'Delete conversation binding',
        description: 'Disables a conversation binding while retained delivery custody finishes safely.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Delete conversation binding?',
          body: 'This immediately disables new binding effects while retained ingress and delivery custody finish safely.',
          confirmLabel: 'Delete binding',
        },
        hostAccess: ['account-storage'],
        run: deleteConversationBindingForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.sessionProjectionBaselineAccept]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.sessionProjectionBaselineAccept,
        title: 'Accept Session conversation transcript baseline',
        description: 'Resumes one paused Session conversation from the current transcript tail.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Continue without unavailable transcript history?',
          body: 'This resumes the conversation from the Session’s current transcript tail without replaying unavailable history.',
          confirmLabel: 'Accept baseline',
        },
        hostAccess: ['account-storage'],
        run: acceptConversationSessionProjectionBaselineForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.ingressRetry,
        title: 'Retry blocked conversation ingress',
        description: 'Re-enables a blocked conversation input for bounded retry.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Retry this blocked conversation input?',
          body: 'This re-enables the same frozen admission request for bounded retry.',
          confirmLabel: 'Retry input',
        },
        hostAccess: ['account-storage'],
        run: retryConversationIngressForInvocation,
      },
      [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve]: {
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.deliveryResolve,
        title: 'Resolve ambiguous conversation delivery',
        description: 'Records whether to accept or discard an ambiguous delivery outcome without resending.',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        confirmation: {
          title: 'Record this delivery decision?',
          body: 'This records whether you accept or discard the current delivery outcome. It does not resend the message.',
          confirmLabel: 'Record decision',
        },
        hostAccess: ['account-storage'],
        run: resolveConversationDeliveryForInvocation,
      },
      [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest]: {
        // The three provider reads below declare their composed protocol schema
        // rather than the JSON projection of it. The manifest bytes are the
        // same — `definePlugin` serializes `.jsonSchema` — but the declared
        // contract now types the handler, so the typed input these three
        // handlers already assume is enforced at the seam that declares it
        // instead of being trusted from the host.
        inputSchema: ConversationProviderObservationIngestInputV1Schema,
        title: 'Ingest authenticated provider observation',
        description: 'Ingests one authenticated observation from a conversation provider.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: ingestConversationProviderObservationForInvocation,
      },
      [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList]: {
        inputSchema: ConversationProviderConnectionsListInputV1Schema,
        resultSchema: ConversationProviderConnectionsListResultV1Schema,
        title: 'List current provider connections',
        description: 'Lists the current provider connections available to the Channels runtime.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: listConversationProviderConnectionsForInvocation,
      },
      [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead]: {
        inputSchema: ConversationProviderConnectionReadInputV1Schema,
        resultSchema: ConversationProviderConnectionReadResultV1Schema,
        title: 'Read current provider connection',
        description: 'Reads one current provider connection for the Channels runtime.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: readConversationProviderConnectionForInvocation,
      },
      [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport]: {
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.transportFactReport,
        title: 'Report current transport fact',
        description: 'Reports the current transport fact for a provider connection.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: reportConversationTransportFactForInvocation,
      },
      [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver]: {
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.automationResultDeliver,
        title: 'Accept Automation result delivery custody',
        description: 'Accepts custody of one Automation result for conversation delivery.',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'writesLocal',
        execution: { target: 'daemon' },
        hostAccess: ['account-storage'],
        run: deliverConversationAutomationResultForInvocation,
      },
    },
    // Socket services remain provider-owned. The core owns the two persisted
    // work families: checkpointed ingress and retained outward delivery.
    backgroundServices: [
      {
        declaration: {
          id: 'ingress-supervisor',
          title: 'Conversation ingress supervisor',
        },
        runner: runConversationIngressSupervisor,
      },
      {
        declaration: {
          id: 'outward-delivery-supervisor',
          title: 'Conversation outward delivery supervisor',
        },
        runner: runConversationOutwardDeliverySupervisor,
      },
    ],
    setup: setupChannelsPluginGeneration,
  });
}

/** The one Channels plugin value: manifest, activation and contribution points. */
export const CHANNELS_PLUGIN = createChannelsPlugin();

export const PLUGIN_MANIFEST: PluginManifest = CHANNELS_PLUGIN.manifest;

/**
 * The executable half of `contributes.accountCollections`. The host projects it
 * against the parsed manifest declarations before a candidate may load, so it
 * comes from the same `definePlugin` owner as the declarations rather than from
 * a second hand-maintained map beside the definitions.
 */
export const collectionMigrations = CHANNELS_PLUGIN.collectionMigrations;

/**
 * `definePlugin` is the sole projector of both the cold declaration and the
 * live target reference, preventing a hand-maintained point/ref split. Every
 * consumer dereferences it inside a handler body, never at module evaluation,
 * which is what keeps the deliberate manifest ↔ handler import cycle
 * initialization-safe.
 */
export const CHANNELS_PROVIDER_POINT_REF =
  CHANNELS_PLUGIN.contributionPoints[CHANNELS_PROVIDER_POINT_ID];

/** The one admitted V1 provider contribution at Channels' target-owned point. */
export type ChannelsProviderContributionV1 = (
  typeof CHANNELS_PROVIDER_POINT_REF
) extends TargetedContributionPointRef<infer TContribution>
  ? TContribution
  : never;
