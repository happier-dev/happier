import type {
  BundledRealtimeProviderRuntimeConfig,
  BundledRealtimeProviderRuntimeHost,
} from './bundledConversationRuntimeContract';
import {
  buildQualifiedPluginContributionKey,
  ConnectedServiceBindingsV1Schema,
  createRecipientContractDigestV1,
  createPluginContributionIdentity,
  deriveVoiceCredentialBindingIdentityV1,
  normalizeRecipientContractV1,
  VoiceProviderContributionSchema,
  readVoiceProviderCredentialRemediationCode,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
  type VoiceProviderContribution,
  type RecipientContractV1,
  type DaemonPluginReactNativeBundleCacheIdentityV1,
} from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import type {
  VoiceAccountOperationService,
  VoiceCredentialAccess,
  VoiceProviderRuntime,
  VoiceSettingsActionContext,
} from '@happier-dev/plugin-sdk/voice';
import type {
  RealtimeVoiceProviderProtocol,
  RealtimeVoiceProviderSettingsOperations,
  VoiceHostedConversationService,
  VoiceRealtimeConnection,
  VoiceRuntimePlatform,
} from '@happier-dev/plugin-sdk/voice/client';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type {
  PluginSettingsActionInput,
  PluginSettingsActionRuntime,
} from '@happier-dev/plugin-sdk/settings';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';

import type { PluginUiExecutableActivationScope } from '@/components/plugins/reactNative/executableModuleHost';
import {
  readVoiceSettingsInput,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import type {
  BundledVoiceRuntimeContribution,
  VoiceAdapterController,
} from '@/voice/session/types';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
  type ExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';
import { bindVoiceClientToolsToAttempt } from './attemptVoiceClientTools';

import {
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import {
  createAccountVoiceCredentialAuthorityLease,
  createAccountVoiceOperationService,
} from '@/voice/credentials/accountVoiceOperationService';
import { subscribeBundledConversationRuntimeGeneration } from './bundledConversationRuntimeGeneration';
import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';
import {
  projectVoiceProviderDeclarationRequirements,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from './externalVoiceProviderRegistrations';
import { getProviderConversationServiceFactory } from './providerConversationService';
import { createVoiceClientRawCredentialAccess } from '@/voice/credentials/rawCredentialClient';
import { createVoiceClientMediatedCredentialHeadersMaterializer } from '@/voice/credentials/mediatedCredentialClient';
import { resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';
import { createAppShellTransientInteractions } from '@/components/appShell/plugins/appShellQuestionInteractions';

type ExternalVoiceProviderProtocolLeaf = RealtimeVoiceProviderProtocol;
export type VoiceConversationProviderContribution = Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
>;

/**
 * Internal experimental UI-module ABI. External providers contribute only
 * provider-native protocol and connection leaves; the app host retains voice
 * lifecycle, mic, transcript, tools, privacy, cancellation, and persistence.
 */
export type ExternalVoiceProviderRuntimeRegistration = Extract<
  VoiceProviderRuntime,
  Readonly<{ kind: 'conversation' }>
>;

type BoundVoiceProviderSettingsOperations = NonNullable<
  import('./externalVoiceProviderRegistrations').ExternalVoiceProviderRegistration['settingsOperations']
>;
type BoundVoiceProviderSettingsActions = NonNullable<
  import('./externalVoiceProviderRegistrations').ExternalVoiceProviderRegistration['settingsActions']
>;

function settingsOperationCancelled(): Error {
  return Object.assign(new Error('voice_account_operation_cancelled'), {
    code: 'voice_account_operation_cancelled',
  });
}

function assertSettingsOperationCurrent(
  signal: AbortSignal,
  isCurrent: () => boolean,
): void {
  if (signal.aborted || !isCurrent()) throw settingsOperationCancelled();
}

const MAX_VOICE_PROVIDER_CATALOG_ITEMS = 1_000;
const MAX_VOICE_PROVIDER_CATALOG_BYTES = 1_048_576;
const MAX_VOICE_PROVIDER_PREVIEW_URL_LENGTH = 16_384;

function settingsOperationResponseInvalid(): Error {
  return Object.assign(new Error('voice_provider_settings_response_invalid'), {
    code: 'voice_provider_settings_response_invalid',
  });
}

function parseVoiceProviderPreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_VOICE_PROVIDER_PREVIEW_URL_LENGTH) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && Boolean(parsed.hostname)
      ? raw
      : null;
  } catch {
    return null;
  }
}

function sanitizeVoiceProviderCatalogItem(value: VoiceRealtimeJsonValue): VoiceRealtimeJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, VoiceRealtimeJsonValue>>;
  const result: Record<string, VoiceRealtimeJsonValue> = { ...record };
  if ('previewUrl' in result) {
    const previewUrl = parseVoiceProviderPreviewUrl(result.previewUrl);
    if (previewUrl) result.previewUrl = previewUrl;
    else delete result.previewUrl;
  }
  if (result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata)) {
    const metadata = {
      ...(result.metadata as Readonly<Record<string, VoiceRealtimeJsonValue>>),
    };
    if ('previewUrl' in metadata) {
      const previewUrl = parseVoiceProviderPreviewUrl(metadata.previewUrl);
      if (previewUrl) metadata.previewUrl = previewUrl;
      else delete metadata.previewUrl;
    }
    result.metadata = Object.freeze(metadata);
  }
  return Object.freeze(result);
}

function parseBoundedVoiceProviderCatalog(
  value: readonly VoiceRealtimeJsonValue[],
): readonly VoiceRealtimeJsonValue[] {
  if (value.length > MAX_VOICE_PROVIDER_CATALOG_ITEMS) {
    throw settingsOperationResponseInvalid();
  }
  const encoder = new TextEncoder();
  const items: VoiceRealtimeJsonValue[] = [];
  let totalBytes = 0;
  for (const item of value) {
    const parsed = sanitizeVoiceProviderCatalogItem(VoiceRealtimeJsonValueSchema.parse(item));
    totalBytes += encoder.encode(JSON.stringify(parsed)).byteLength;
    if (totalBytes > MAX_VOICE_PROVIDER_CATALOG_BYTES) {
      throw settingsOperationResponseInvalid();
    }
    items.push(parsed);
  }
  return Object.freeze(items);
}

async function withVoiceProviderInvocationLifetime<T>(input: Readonly<{
  callerSignal: AbortSignal;
  revocationSignal?: AbortSignal;
  run(signal: AbortSignal): Promise<T>;
}>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.callerSignal.aborted || input.revocationSignal?.aborted) abort();
  input.callerSignal.addEventListener('abort', abort, { once: true });
  input.revocationSignal?.addEventListener('abort', abort, { once: true });
  try {
    return await input.run(controller.signal);
  } finally {
    input.callerSignal.removeEventListener('abort', abort);
    input.revocationSignal?.removeEventListener('abort', abort);
    // Raw materialization is an invocation capability, not an attempt-wide
    // credential handle. Retire every retained capability as its host leaf
    // returns, including successful returns.
    if (!controller.signal.aborted) controller.abort();
  }
}

/**
 * Project a provider-owned settings leaf through the host-owned account and
 * activation lifecycle boundary. One host-composed AbortSignal is shared by
 * the provider leaf and every account request in the invocation.
 */
export function bindVoiceProviderSettingsOperations(input: Readonly<{
  operations: RealtimeVoiceProviderSettingsOperations;
  createCredentials(signal: AbortSignal): VoiceCredentialAccess<'settings'>;
  isCurrent(): boolean;
  revocationSignal?: AbortSignal;
}>): BoundVoiceProviderSettingsOperations {
  const { operations } = input;
  const revocationSignal = input.revocationSignal ?? new AbortController().signal;
  return Object.freeze({
    ...(operations.listCatalog ? {
      async listCatalog(
        request: Parameters<NonNullable<BoundVoiceProviderSettingsOperations['listCatalog']>>[0],
      ) {
        return await withVoiceProviderInvocationLifetime({
          callerSignal: request.signal,
          revocationSignal,
          async run(signal) {
            assertSettingsOperationCurrent(signal, input.isCurrent);
            let result: readonly VoiceRealtimeJsonValue[];
            try {
              result = await operations.listCatalog!({
                ...request,
                signal,
                credentials: input.createCredentials(signal),
              });
            } catch (error) {
              if (revocationSignal.aborted || !input.isCurrent()) throw settingsOperationCancelled();
              throw error;
            }
            assertSettingsOperationCurrent(signal, input.isCurrent);
            return parseBoundedVoiceProviderCatalog(result);
          },
        });
      },
    } : {}),
  });
}

/** Bind declared generic settings actions to current credential/currentness authority. */
export function bindVoiceProviderSettingsActions(input: Readonly<{
  actions: PluginSettingsActionRuntime<VoiceSettingsActionContext>;
  declaredActions: readonly Readonly<{ id: string; patchFieldIds: readonly string[] }>[];
  createCredentials(signal: AbortSignal): VoiceCredentialAccess<'settings'>;
  createInteractions(input: Readonly<{
    signal: AbortSignal;
    isCurrent(): boolean;
  }>): VoiceSettingsActionContext['interactions'];
  getRealtimeClientToolDefinitions(): VoiceSettingsActionContext['tools'];
  isCurrent(): boolean;
  revocationSignal?: AbortSignal;
}>): BoundVoiceProviderSettingsActions {
  if (typeof input.createInteractions !== 'function') {
    throw activationError('voice_settings_interaction_host_required');
  }
  const declaredActions = new Map(input.declaredActions.map((action) => [action.id, action]));
  const revocationSignal = input.revocationSignal ?? new AbortController().signal;
  return Object.freeze({
    async execute(request) {
      const declaration = declaredActions.get(request.actionId);
      if (!declaration) {
        throw activationError('undeclared_voice_provider_settings_action');
      }
      return await withVoiceProviderInvocationLifetime({
        callerSignal: request.signal,
        revocationSignal,
        async run(signal) {
          assertSettingsOperationCurrent(signal, input.isCurrent);
          let result: Awaited<ReturnType<typeof input.actions.execute>>;
          try {
            const actionInput: PluginSettingsActionInput = Object.freeze({
              actionId: request.actionId,
              settings: request.settings,
            });
            result = await input.actions.execute(actionInput, Object.freeze({
              credentials: input.createCredentials(signal),
              interactions: input.createInteractions({
                signal,
                isCurrent: input.isCurrent,
              }),
              signal,
              tools: input.getRealtimeClientToolDefinitions(),
            }));
          } catch (error) {
            if (revocationSignal.aborted || !input.isCurrent()) throw settingsOperationCancelled();
            throw error;
          }
          assertSettingsOperationCurrent(signal, input.isCurrent);
          // The generic host settings-action invoker is the single patch
          // allowlist/bounds/JSON normalization owner. This binding owns only
          // manifest admission, credentials, cancellation, and generation.
          return result;
        },
      });
    },
  });
}

export type ExternalVoiceProviderActivationApi = Readonly<{
  voiceProviders: Readonly<{
    register(localId: string, runtime: ExternalVoiceProviderRuntimeRegistration): void;
  }>;
}>;

export type VoiceProviderActivationHostBinding = Readonly<{
  recipientContract?: RecipientContractV1 | null;
  createInvocationAccountOperations?(
    signal: AbortSignal,
    conversationSessionId: string | null,
    isCurrent: () => boolean,
    phase: 'settings' | 'prepare' | 'connection',
  ): VoiceAccountOperationService;
  createInvocationHostedConversation?(
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): VoiceHostedConversationService;
  resolveSurfaceCapabilities?: BundledRealtimeProviderRuntimeConfig['resolveSurfaceCapabilities'];
  descriptor: 'external' | 'bundled';
}>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isVoiceRealtimeConnection(value: unknown): value is VoiceRealtimeConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const connection = value as Readonly<Record<string, unknown>>;
  return (connection.kind === 'websocket_pcm' || connection.kind === 'webrtc' || connection.kind === 'sdk_handle')
    && typeof connection.connect === 'function'
    && typeof connection.sendControl === 'function'
    && typeof connection.controlEvents === 'function'
    && typeof connection.transportEvents === 'function'
    && typeof connection.close === 'function'
    && typeof connection.state === 'function'
    && typeof connection.currentProviderSessionId === 'function'
    && typeof connection.playbackCursorMs === 'function'
    && typeof connection.beginOutputInterruptionCandidate === 'function'
    && typeof connection.resolveOutputInterruptionCandidate === 'function';
}

function activationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function createUnavailableInvocationUi(): PluginUiHostApi {
  const unavailable = (): never => { throw activationError('plugin_ui_action_host_unavailable'); };
  return Object.freeze({
    version: () => Object.freeze({
      apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
      wireVersion: 1,
      methods: Object.freeze([]),
    }),
    context: async () => unavailable(),
    watchContext: unavailable,
    activeComposer: async () => unavailable(),
    readComposer: async () => unavailable(),
    watchComposer: async () => unavailable(),
    applyComposer: async () => unavailable(),
    focusComposer: async () => unavailable(),
    setComposerDecorations: async () => unavailable(),
    acquireComposerInputLock: async () => unavailable(),
    pickComposerMedia: async () => unavailable(),
    inspectComposerContent: async () => unavailable(),
    releaseComposerContent: async () => unavailable(),
    executeAction: async () => unavailable(),
    selectActionInput: async () => unavailable(),
    readResource: async () => unavailable(),
    statOpenableContent: async () => unavailable(),
    readOpenableContent: async () => unavailable(),
    watchResource: async () => unavailable(),
    openSurface: async () => unavailable(),
    replacePageLocation: async () => unavailable(),
    notify: async () => unavailable(),
    confirm: async () => unavailable(),
    diagnostic: () => {},
    readClipboard: async () => unavailable(),
    writeClipboard: async () => unavailable(),
    openExternalLink: async () => unavailable(),
  });
}

function createVoiceAttemptInvocationUi(input: Readonly<{
  base: PluginUiHostApi;
  host: BundledRealtimeProviderRuntimeHost;
  controlSessionId: string;
  attemptId: number;
}>): PluginUiHostApi {
  return Object.freeze({
    ...input.base,
    diagnostic(diagnostic: Parameters<PluginUiHostApi['diagnostic']>[0]) {
      input.host.presentAttemptDiagnostic({
        controlSessionId: input.controlSessionId,
        attemptId: input.attemptId,
        diagnostic,
      });
      input.base.diagnostic(diagnostic);
    },
  });
}

function declarationTitle(declaration: VoiceProviderContribution): string {
  return typeof declaration.title === 'string' ? declaration.title : declaration.title.fallback;
}

function projectExternalAccountCredentialSlot(
  declaration: VoiceConversationProviderContribution,
  recipientContract: RecipientContractV1 | null,
): NonNullable<VoiceProviderRegistryEntry['accountCredentialSlot']> | null {
  const credentials = declaration.credentials;
  if (!credentials?.hostMediated || !recipientContract) return null;
  const savedSecret = credentials.sources.find((source) => source.kind === 'savedSecret');
  if (!savedSecret?.secretKinds.includes('apiKey')) return null;
  const slot = credentials.slot;
  const normalizedRecipientContract = normalizeRecipientContractV1(recipientContract);
  if (credentials.hostMediated.operations.some((operation) => operation.credentialSlotId !== slot.id)
    || normalizedRecipientContract.credentialSlot.id !== slot.id) return null;
  return Object.freeze({
    id: slot.id,
    scope: 'account' as const,
    kind: 'apiKey' as const,
    recipientContract: normalizedRecipientContract,
    recipientContractDigest: createRecipientContractDigestV1(normalizedRecipientContract),
  });
}

function createVoiceCredentialAccess<P extends 'settings' | 'prepare' | 'connection'>(input: Readonly<{
  declaration: VoiceConversationProviderContribution;
  phase: P;
  createMediated?: () => VoiceAccountOperationService;
  raw: VoiceCredentialAccess<P>['raw'];
}>): VoiceCredentialAccess<P> {
  const permitsMediatedAccess = input.declaration.credentials?.sources.some((source) => (
    source.operationProjections?.some((projection) => projection.phase === input.phase) === true
  )) === true;
  return Object.freeze({
    phase: input.phase,
    mediated: permitsMediatedAccess ? input.createMediated?.() ?? null : null,
    raw: input.raw,
  });
}

export function createDeclaredVoiceClientRawCredentialAccess(input: Readonly<{
  pluginId: string;
  declaration: VoiceConversationProviderContribution;
  identity: DaemonPluginReactNativeBundleCacheIdentityV1;
  hostPlatform: 'web' | 'ios' | 'android';
  phase: 'settings' | 'prepare' | 'connection';
  generation: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}>): VoiceCredentialAccess<'connection'>['raw'] {
  if (
    input.identity.pluginId !== input.pluginId
    || input.identity.contributionId !== input.declaration.id
    || input.identity.platform !== input.hostPlatform
    || String(input.identity.projectionGeneration) !== input.generation
  ) return null;
  const declared = input.declaration.credentials?.sources.some((source) => (
    source.rawGrants?.some((grant) => (
      grant.realm === input.hostPlatform
      && grant.phase === input.phase
      && grant.request.kind === 'httpHeaders'
    )) === true
  )) === true;
  if (!declared) return null;
  let credentialBinding: ReturnType<typeof deriveVoiceCredentialBindingIdentityV1>;
  try {
    credentialBinding = deriveVoiceCredentialBindingIdentityV1({
      pluginId: input.pluginId,
      contribution: input.declaration,
    });
  } catch {
    return null;
  }
  if (!credentialBinding) return null;
  // The selected daemon is part of this credential authority: both source
  // selection and raw RPC dispatch must stay on the same captured target for
  // this one provider invocation.
  const machineId = resolveVoiceExecutionMachineId();
  const sourceLease = createAccountVoiceCredentialAuthorityLease({
    contribution: credentialBinding.contribution,
    providerId: buildQualifiedPluginContributionKey(credentialBinding.contribution),
    credentialSlotId: credentialBinding.credentialSlotId,
    purpose: credentialBinding.purpose,
    machineId,
    isCurrent: input.isCurrent,
  });
  return createVoiceClientRawCredentialAccess({
    identity: input.identity,
    phase: input.phase,
    signal: input.signal,
    isCurrent: input.isCurrent,
    machineId,
    isInvocationCurrent: () => (
      machineId !== null
      && resolveVoiceExecutionMachineId() === machineId
      && sourceLease.isCurrent()
    ),
  });
}

export function createExternalProtocol(
  host: BundledRealtimeProviderRuntimeHost,
  providerId: string,
  platform: VoiceRuntimePlatform,
  declaration: VoiceConversationProviderContribution,
  leaf: ExternalVoiceProviderProtocolLeaf,
  createInvocationAccountOperations?: (
    signal: AbortSignal,
    conversationSessionId: string | null,
    phase: 'prepare' | 'connection',
  ) => VoiceAccountOperationService,
  createInvocationHostedConversation?: (signal: AbortSignal) => VoiceHostedConversationService,
  createInvocationRawCredentials?: (
    phase: 'prepare' | 'connection',
    signal: AbortSignal,
  ) => VoiceCredentialAccess<'prepare' | 'connection'>['raw'],
): VoiceRealtimeProtocolAdapter {
  const providerConfigByAttemptId = new Map<number, VoiceRealtimeJsonValue>();
  const providerConversationFactory = declaration.capabilities.turn.resumption === 'resume'
    ? getProviderConversationServiceFactory(host, providerId)
    : null;
  const readProviderConfig = (): VoiceRealtimeJsonValue | null => {
    const projection = host.projectVoiceSettings(host.getSettings(), providerId);
    if (!projection || projection.providerId !== providerId) return null;
    const parsed = VoiceRealtimeJsonValueSchema.safeParse(projection.providerConfig);
    return parsed.success ? deepFreeze(parsed.data) : null;
  };
  return Object.freeze({
    ...leaf,
    id: providerId,
    turnControls: Object.freeze({
      cancelResponse: declaration.capabilities.turn.cancelResponse ? 'immediate' as const : 'unsupported' as const,
      truncatePlayback: 'unsupported' as const,
      clearInput: declaration.capabilities.turn.clearInput ?? false,
      stopSession: false,
      resumption: declaration.capabilities.turn.resumption ?? 'none' as const,
      replay: declaration.capabilities.turn.replay ?? 'none' as const,
      exactMessage: declaration.capabilities.turn.exactMessage ?? false,
    }),
    async preflight(preflightInput) {
      const providerConfig = readProviderConfig();
      if (providerConfig === null) return { kind: 'declined', code: 'invalid_provider_settings' };
      providerConfigByAttemptId.set(preflightInput.attemptId, providerConfig);
      try {
        const result = leaf.preflight
          ? await leaf.preflight(Object.freeze({
              ...preflightInput,
              platform,
              providerConfig,
            }))
          : { kind: 'ready' as const };
        if (result.kind !== 'ready') {
          providerConfigByAttemptId.delete(preflightInput.attemptId);
          return result;
        }
        return result;
      } catch (error) {
        providerConfigByAttemptId.delete(preflightInput.attemptId);
        const remediationCode = readVoiceProviderCredentialRemediationCode(error);
        if (remediationCode) {
          return { kind: 'declined', code: remediationCode };
        }
        throw error;
      }
    },
    async prepare(prepareInput) {
      const providerConfig = prepareInput.reason === 'initial'
        ? providerConfigByAttemptId.get(prepareInput.attemptId) ?? readProviderConfig()
        : readProviderConfig();
      providerConfigByAttemptId.delete(prepareInput.attemptId);
      if (providerConfig === null) return { kind: 'declined', code: 'invalid_provider_settings' };
      return await withVoiceProviderInvocationLifetime({
        callerSignal: prepareInput.signal,
        async run(signal) {
          const conversationSessionId = host.resolveConversationSessionId(
            prepareInput.controlSessionId,
            providerId,
          );
          const providerConversationPersistenceAvailable = Boolean(
            conversationSessionId
            && providerConversationFactory
            && host.canPersistProviderConversationState?.({
              providerId,
              conversationSessionId,
            }) === true,
          );
          return await leaf.prepare(Object.freeze({
            ...prepareInput,
            platform,
            providerConfig,
            credentials: createVoiceCredentialAccess({
              declaration,
              phase: 'prepare',
              ...(createInvocationAccountOperations ? {
                createMediated: () => createInvocationAccountOperations(
                  signal,
                  conversationSessionId,
                  'prepare',
                ),
              } : {}),
              raw: createInvocationRawCredentials?.('prepare', signal) ?? null,
            }),
            providerConversation: conversationSessionId
              && providerConversationFactory
              && providerConversationPersistenceAvailable
              ? providerConversationFactory.createAttempt(conversationSessionId)
              : null,
            hostedConversation: createInvocationHostedConversation?.(signal) ?? null,
          }));
        },
      });
    },
    async releasePrepared(releaseInput) {
      providerConfigByAttemptId.delete(releaseInput.attemptId);
      await leaf.releasePrepared?.(releaseInput);
    },
  });
}

/** Compose an external leaf through the same host-owned controller as bundled providers. */
export function createExternalVoiceProviderRuntimeContribution(input: Readonly<{
  host: BundledRealtimeProviderRuntimeHost;
  platform: VoiceRuntimePlatform;
  providerId: string;
  providerRef?: Readonly<{ pluginId: string; localId: string }>;
  declaration: VoiceConversationProviderContribution;
  runtime: ExternalVoiceProviderRuntimeRegistration;
  providerSettings?: ExternalVoiceProviderSettingsDescriptor;
  createInvocationAccountOperations?(
    signal: AbortSignal,
    conversationSessionId: string | null,
    phase: 'prepare' | 'connection',
  ): VoiceAccountOperationService;
  createInvocationHostedConversation?(signal: AbortSignal): VoiceHostedConversationService;
  createInvocationRawCredentials?(
    phase: 'prepare' | 'connection',
    signal: AbortSignal,
  ): VoiceCredentialAccess<'prepare' | 'connection'>['raw'];
  createInvocationUi?(signal: AbortSignal): PluginUiHostApi;
  resolveSurfaceCapabilities?: BundledRealtimeProviderRuntimeConfig['resolveSurfaceCapabilities'];
}>): BundledVoiceRuntimeContribution {
  const { runtime, declaration, providerId } = input;
  const providerSettings = input.providerSettings
    ?? createExternalVoiceProviderSettingsDescriptor(declaration.settings);
  const execution = declaration.execution?.kind === 'experimental_agent_session_realtime'
    ? (() => {
        const provider = input.providerRef ?? (() => {
          throw activationError('voice_agent_realtime_provider_identity_required');
        })();
        const agent = typeof declaration.execution.agent === 'string'
          ? Object.freeze({
              pluginId: provider.pluginId,
              localId: declaration.execution.agent,
            })
          : declaration.execution.agent;
        const connectedServicesBinding = providerSettings.connectedServicesBinding;
        if (connectedServicesBinding) {
          const bindingAgent = typeof connectedServicesBinding.agent === 'string'
            ? Object.freeze({
                pluginId: provider.pluginId,
                localId: connectedServicesBinding.agent,
              })
            : connectedServicesBinding.agent;
          if (bindingAgent.pluginId !== agent.pluginId || bindingAgent.localId !== agent.localId) {
            throw activationError('voice_agent_realtime_binding_agent_mismatch');
          }
        }
        return Object.freeze({
          kind: 'experimental_agent_session_realtime' as const,
          provider,
          agent,
          ...(connectedServicesBinding ? { connectedServicesBinding } : {}),
        });
      })()
    : null;
  const supportsProviderConversationForget = declaration.capabilities.turn.resumption === 'resume';
  if (supportsProviderConversationForget !== (runtime.forgetProviderConversation !== undefined)) {
    throw activationError('voice_provider_resumption_registration_mismatch');
  }
  const forgetProviderConversationState = input.host.forgetProviderConversationState;
  if (supportsProviderConversationForget && !forgetProviderConversationState) {
    throw activationError('voice_provider_resumption_forget_host_unavailable');
  }
  const config: BundledRealtimeProviderRuntimeConfig = Object.freeze({
    providerId,
    ...(input.providerRef
      ? {
          providerSource: Object.freeze({
            pluginId: input.providerRef.pluginId,
            contributionId: input.providerRef.localId,
          }),
        }
      : {}),
    execution: execution
      ? Object.freeze({
          kind: execution.kind,
          provider: execution.provider,
          agent: execution.agent,
        })
      : Object.freeze({ kind: 'direct_media' as const }),
    protocol: createExternalProtocol(
      input.host,
      providerId,
      input.platform,
      declaration,
      runtime.protocol,
      input.createInvocationAccountOperations,
      input.createInvocationHostedConversation,
      input.createInvocationRawCredentials,
    ),
    async createConnection(connectionInput) {
      return await withVoiceProviderInvocationLifetime({
        callerSignal: connectionInput.signal,
        async run(signal) {
          const {
            controlSessionId,
            ...providerConnectionInput
          } = connectionInput;
          const conversationSessionId = input.host.resolveConversationSessionId(
            controlSessionId,
            providerId,
          );
          const baseUi =
            input.createInvocationUi?.(connectionInput.signal) ?? createUnavailableInvocationUi();
          const connection = await runtime.createConnection(Object.freeze({
            ...providerConnectionInput,
            credentials: createVoiceCredentialAccess({
              declaration,
              phase: 'connection',
              ...(input.createInvocationAccountOperations ? {
                createMediated: () => input.createInvocationAccountOperations!(
                  signal,
                  conversationSessionId,
                  'connection',
                ),
              } : {}),
              raw: input.createInvocationRawCredentials?.('connection', signal) ?? null,
            }),
            tools: bindVoiceClientToolsToAttempt(
              input.host.getRealtimeClientToolDefinitions(),
              connectionInput.signal,
            ),
            ui: createVoiceAttemptInvocationUi({
              base: baseUi,
              host: input.host,
              controlSessionId,
              attemptId: connectionInput.attemptId,
            }),
          }));
          if (!isVoiceRealtimeConnection(connection)) {
            throw activationError('invalid_external_voice_provider_connection');
          }
          return connection;
        },
      });
    },
    encodeToolResults: (results) => runtime.encodeToolResults(results),
    encodeToolContinuation: (responseId) => runtime.encodeToolContinuation(responseId),
    ...(runtime.beforeToolContinuation
      ? { beforeToolContinuation: (responseId: string, signal: AbortSignal) => runtime.beforeToolContinuation!(responseId, signal) }
      : {}),
    ...(runtime.forgetProviderConversation
      ? {
          runtimeActions: Object.freeze({
            forget_provider_conversation: async () => {
              await runtime.forgetProviderConversation!();
              await forgetProviderConversationState!({ providerId });
            },
          }),
        }
      : {}),
    ...(declaration.capabilities.turn.cancelResponse && runtime.beforeInterrupt
      ? { beforeInterrupt: () => runtime.beforeInterrupt!() }
      : {}),
    ...(declaration.capabilities.turn.cancelResponse && runtime.encodePostCancelControls
      ? { encodePostCancelControls: () => runtime.encodePostCancelControls!() }
      : {}),
    ...(declaration.capabilities.turn.bargeIn && runtime.encodePostBargeInControls
      ? { encodePostBargeInControls: () => runtime.encodePostBargeInControls!() }
      : {}),
    microphoneMode: runtime.microphoneMode,
    ...(runtime.setInputMuted
      ? { setInputMuted: (muted: boolean) => runtime.setInputMuted!(muted) }
      : {}),
    encodeContextUpdate: (text) => runtime.encodeContextUpdate(text),
    encodeTextTurn: (text) => runtime.encodeTextTurn(text),
    ...(execution
      ? {
          async resolveConversationBinding(bindingInput: Readonly<{
            controlSessionId: string;
            requestedTargetSessionId: string | null;
            settings: unknown;
          }>) {
            const resolveBinding = input.host.resolveAgentRealtimeVoiceConversationBinding;
            if (!resolveBinding) {
              throw activationError('agent_realtime_voice_binding_host_unavailable');
            }
            if (bindingInput.controlSessionId !== input.host.globalVoiceSessionId) {
              return await resolveBinding({
                ...bindingInput,
                provider: execution.provider,
                agent: execution.agent,
              });
            }
            if (!execution.connectedServicesBinding) {
              return await resolveBinding({
                ...bindingInput,
                provider: execution.provider,
                agent: execution.agent,
              });
            }
            const voice = voiceSettingsParse(readVoiceSettingsInput(bindingInput.settings));
            const envelope = voice.providers[providerId];
            if (envelope?.schemaVersion !== providerSettings.schemaVersion) return null;
            const parsedConfig = providerSettings.parseConfig(envelope.config);
            if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) return null;
            const parsedConfigRecord = parsedConfig as Readonly<Record<string, unknown>>;
            const connectedServices = ConnectedServiceBindingsV1Schema.safeParse(
              parsedConfigRecord[execution.connectedServicesBinding.id],
            );
            if (!connectedServices.success) return null;
            return await resolveBinding({
              ...bindingInput,
              provider: execution.provider,
              agent: execution.agent,
              connectedServices: connectedServices.data,
            });
          },
        }
      : {}),
    resolveSurfaceCapabilities: input.resolveSurfaceCapabilities ?? ((settings) => {
      const voiceSettings = voiceSettingsParse(readVoiceSettingsInput(settings));
      const projection = projectExternalVoiceProviderSettings(
        voiceSettings.providers[providerId] ?? null,
        providerSettings,
      );
      if (voiceSettings.providerId !== providerId || projection.status !== 'ready') return null;
      return Object.freeze({
        allowsGlobalStart: true,
        controlSessionScope: 'global' as const,
        requiresVoiceAgentFeature: false,
        bargeInEnabled: declaration.capabilities.turn.bargeIn,
        cancelResponse: declaration.capabilities.turn.cancelResponse ? 'immediate' as const : 'unsupported' as const,
        interruptionPolicy: declaration.capabilities.turn.interruptionPolicy
          ?? (declaration.capabilities.turn.bargeIn ? 'client_two_stage' as const : 'disabled' as const),
      });
    }),
    ...(runtime.outputLevelMeter ? { outputLevelMeter: runtime.outputLevelMeter } : {}),
  });
  const contribution = createBundledRealtimeProviderRuntime(input.host, config);
  if (!runtime.dispose) return contribution;
  let disposed = false;
  return Object.freeze({
    adapter: contribution.adapter,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await contribution.dispose();
      } finally {
        await runtime.dispose!();
      }
    },
  });
}

function projectExternalAdapter(
  contribution: BundledVoiceRuntimeContribution,
  declaration: VoiceConversationProviderContribution,
): VoiceAdapterController {
  if (declaration.capabilities.turn.bargeIn) return contribution.adapter;
  const { bargeIn: _bargeIn, ...adapter } = contribution.adapter;
  return Object.freeze(adapter);
}

type CommittedVoiceRuntimeCleanupOwner = Readonly<{
  transferToContribution(contribution: BundledVoiceRuntimeContribution): void;
  dispose(): Promise<void>;
}>;

function createCommittedVoiceRuntimeCleanupOwner(
  runtime: ExternalVoiceProviderRuntimeRegistration,
): CommittedVoiceRuntimeCleanupOwner {
  let ownedCleanup: (() => Promise<void> | void) | null = runtime.dispose ?? null;
  let transferred = false;
  let disposed = false;
  return Object.freeze({
    transferToContribution(contribution: BundledVoiceRuntimeContribution) {
      if (disposed || transferred) {
        throw activationError('external_voice_provider_cleanup_ownership_transfer_invalid');
      }
      transferred = true;
      ownedCleanup = () => contribution.dispose();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const cleanup = ownedCleanup;
      ownedCleanup = null;
      await cleanup?.();
    },
  });
}

export function createExternalVoiceProviderActivationScope(input: Readonly<{
  pluginId: string;
  generation?: string;
  declarations: readonly VoiceConversationProviderContribution[];
  hostPlatform: string;
  runtimeHost?: BundledRealtimeProviderRuntimeHost;
  isRuntimeHostCurrent?(): boolean;
  recipientContractsByLocalId?: Readonly<Record<string, RecipientContractV1>>;
  clientRuntimeIdentitiesByLocalId?: Readonly<
    Record<string, DaemonPluginReactNativeBundleCacheIdentityV1>
  >;
  hostBindingsByLocalId?: Readonly<Record<string, VoiceProviderActivationHostBinding>>;
  createInvocationUi?(input: Readonly<{
    pluginId: string;
    contributionId: string;
    generation: string;
    signal: AbortSignal;
    isCurrent(): boolean;
  }>): PluginUiHostApi;
}>): PluginUiExecutableActivationScope<ExternalVoiceProviderActivationApi> {
  if (input.declarations.length === 0) throw activationError('external_voice_provider_declaration_required');
  const declarations = input.declarations.map((declaration) => {
    const parsed = VoiceProviderContributionSchema.safeParse(declaration);
    if (!parsed.success || parsed.data.kind !== 'conversation') {
      throw activationError('invalid_external_voice_provider_declaration');
    }
    return parsed.data;
  });
  if (input.createInvocationUi && !input.generation) {
    throw activationError('external_voice_provider_invocation_identity_required');
  }
  if (Boolean(input.runtimeHost) !== Boolean(input.isRuntimeHostCurrent)) {
    throw activationError('external_voice_provider_runtime_host_authority_required');
  }
  const hostPlatform = input.hostPlatform;
  if (hostPlatform !== 'web' && hostPlatform !== 'ios' && hostPlatform !== 'android') {
    throw activationError('external_voice_provider_platform_unavailable');
  }
  if (declarations.some((declaration) => !declaration.platforms.includes(hostPlatform))) {
    throw activationError('external_voice_provider_platform_unavailable');
  }
  const clientTarget = declarations[0]!.client;
  const registrationScope = createPluginRegistrationScope({
    pluginId: input.pluginId,
    target: Object.freeze({
      realm: 'client' as const,
      artifactId: clientTarget.artifactId,
      modulePath: clientTarget.modulePath,
      exportName: clientTarget.exportName,
      platform: hostPlatform,
    }),
    rights: declarations.map((declaration) => Object.freeze({
      family: 'voiceProviders',
      localId: declaration.id,
      target: Object.freeze({
        realm: 'client' as const,
        artifactId: declaration.client.artifactId,
        modulePath: declaration.client.modulePath,
        exportName: declaration.client.exportName,
        platforms: declaration.platforms,
      }),
      voiceProviderDeclaration: declaration,
    })),
  });
  const token = Object.freeze({});
  let committedRuntimeCleanups: readonly CommittedVoiceRuntimeCleanupOwner[] = Object.freeze([]);
  let committedHost: BundledRealtimeProviderRuntimeHost | null = null;
  let committed = false;
  let unwound = false;
  let unsubscribeRuntimeGeneration: (() => void) | null = null;
  let disposalPromise: Promise<void> | null = null;
  const settingsOperationsRevocation = new AbortController();
  let nextSettingsActionInvocationId = 0;
  const readCurrentHost = (): BundledRealtimeProviderRuntimeHost | null => (
    input.runtimeHost && input.isRuntimeHostCurrent
      ? input.isRuntimeHostCurrent() ? input.runtimeHost : null
      : getCurrentBundledConversationRuntimeHost()
  );
  const isCurrent = () => (
    committed
    && !unwound
    && committedHost !== null
    && readCurrentHost() === committedHost
  );
  const disposeCommittedRuntimes = async (): Promise<void> => {
    settingsOperationsRevocation.abort();
    removeExternalVoiceProviderRegistration(token);
    unsubscribeRuntimeGeneration?.();
    unsubscribeRuntimeGeneration = null;
    if (disposalPromise) return await disposalPromise;
    const retiringCleanups = committedRuntimeCleanups;
    committedRuntimeCleanups = Object.freeze([]);
    disposalPromise = Promise.all(retiringCleanups.map(async (cleanup) => {
      try {
        await cleanup.dispose();
      } catch {
        // A plugin cleanup failure cannot retain registration authority.
      }
    })).then(() => undefined);
    await disposalPromise;
  };
  return Object.freeze({
    api: Object.freeze({
      voiceProviders: registrationScope.api.voiceProviders,
    }),
    isCurrent,
    /**
     * SYNCHRONY INVARIANT — do not insert an `await` before the registry
     * publish/withdrawal below.
     *
     * `createBundledConversationRuntimes` reads
     * `getExternalVoiceProviderRegistration(providerId)` SYNCHRONOUSLY right
     * after calling this, and only fire-and-forgets the returned promise. That
     * is safe solely because every rejection path here runs its withdrawal
     * (`disposeCommittedRuntimes`, whose first statements abort the settings
     * operations and remove the registration) inside this function's
     * synchronous prefix — so a failed leaf is already absent by the time the
     * caller looks.
     *
     * Deferring that teardown by even one microtask reintroduces a stale
     * runtime escaping to a consumer that believes the leaf is healthy. A
     * regression test in `bundledConversationRuntimes.test.ts` covers this by
     * rejecting a registration observer; it was verified to fail when the
     * teardown is deferred.
     */
    async commit() {
      if (unwound || committed) throw activationError('external_voice_provider_registration_closed');
      const host = readCurrentHost();
      if (!host) throw activationError('voice_runtime_host_unavailable');
      const committedById = new Map<string, Readonly<{
        runtime: ExternalVoiceProviderRuntimeRegistration;
        cleanup: CommittedVoiceRuntimeCleanupOwner;
      }>>();
      for (const registration of registrationScope.commit()) {
        if (registration.family !== 'voiceProviders' || registration.value.kind !== 'conversation') {
          throw activationError('invalid_external_voice_provider_leaf_registration');
        }
        committedById.set(registration.localId, Object.freeze({
          runtime: registration.value,
          cleanup: createCommittedVoiceRuntimeCleanupOwner(registration.value),
        }));
      }
      committedRuntimeCleanups = Object.freeze(
        [...committedById.values()].map((registration) => registration.cleanup),
      );
      committedHost = host;
      committed = true;
      const registrations: Array<Readonly<{
        declaration: VoiceConversationProviderContribution;
        providerId: string;
        providerSettings: ExternalVoiceProviderSettingsDescriptor;
        runtime: ExternalVoiceProviderRuntimeRegistration;
        contribution: BundledVoiceRuntimeContribution;
        adapter: VoiceAdapterController;
        createInvocationAccountOperations: ((
          signal: AbortSignal,
          conversationSessionId: string | null,
          phase: 'settings' | 'prepare' | 'connection',
        ) => VoiceAccountOperationService) | null;
      }>> = [];
      try {
        for (const declaration of declarations) {
          const committedRuntime = committedById.get(declaration.id);
          if (!committedRuntime) throw activationError('missing_voice_provider_registration');
          const { runtime } = committedRuntime;
          const hostBinding = input.hostBindingsByLocalId?.[declaration.id];
          const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
            pluginId: input.pluginId,
            localId: declaration.id,
          }));
          const providerSettings = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
          const recipientContract = hostBinding?.recipientContract
            ?? input.recipientContractsByLocalId?.[declaration.id]
            ?? null;
          const clientRuntimeIdentity = input.clientRuntimeIdentitiesByLocalId?.[declaration.id] ?? null;
          const createInvocationRawCredentials = clientRuntimeIdentity
            ? (phase: 'prepare' | 'connection', signal: AbortSignal) => createDeclaredVoiceClientRawCredentialAccess({
                declaration,
                pluginId: input.pluginId,
                identity: clientRuntimeIdentity,
                hostPlatform,
                phase,
                generation: input.generation ?? '',
                signal,
                isCurrent,
              })
            : null;
          const createInvocationAccountOperations = hostBinding?.createInvocationAccountOperations
            ? (
                signal: AbortSignal,
                conversationSessionId: string | null,
                phase: 'settings' | 'prepare' | 'connection',
              ) =>
                hostBinding.createInvocationAccountOperations!(
                  signal,
                  conversationSessionId,
                  isCurrent,
                  phase,
                )
            : recipientContract
            ? (
                signal: AbortSignal,
                _conversationSessionId: string | null,
                phase: 'settings' | 'prepare' | 'connection',
              ) => createAccountVoiceOperationService({
                providerId,
                contribution: {
                  pluginId: input.pluginId,
                  localId: declaration.id,
                },
                recipientContract,
                signal,
                isCurrent,
                materializeConnectedAccountHeaders:
                  createVoiceClientMediatedCredentialHeadersMaterializer({
                    contribution: {
                      pluginId: input.pluginId,
                      localId: declaration.id,
                    },
                    platform: hostPlatform,
                    phase,
                    isCurrent,
                  }),
              })
            : null;
          const contribution = createExternalVoiceProviderRuntimeContribution({
            host,
            platform: hostPlatform,
            providerId,
            providerRef: Object.freeze({
              pluginId: input.pluginId,
              localId: declaration.id,
            }),
            declaration,
            runtime,
            providerSettings,
            ...(createInvocationAccountOperations
              ? {
                  createInvocationAccountOperations,
                }
              : {}),
            ...(hostBinding?.createInvocationHostedConversation
              ? {
                  createInvocationHostedConversation: (signal) =>
                    hostBinding.createInvocationHostedConversation!(signal, isCurrent),
                }
              : {}),
            ...(createInvocationRawCredentials ? { createInvocationRawCredentials } : {}),
            ...(hostBinding?.resolveSurfaceCapabilities
              ? { resolveSurfaceCapabilities: hostBinding.resolveSurfaceCapabilities }
              : {}),
            ...(input.createInvocationUi && input.generation ? {
              createInvocationUi: (signal: AbortSignal) => input.createInvocationUi!({
                pluginId: input.pluginId,
                contributionId: declaration.id,
                generation: input.generation!,
                signal,
                isCurrent,
              }),
            } : {}),
          });
          // Every committed runtime starts scope-owned. Once construction
          // succeeds, transfer that exact owner to the composite contribution,
          // which cleans up both host resources and the captured runtime.
          committedRuntime.cleanup.transferToContribution(contribution);
          registrations.push(Object.freeze({
            declaration,
            providerId,
            providerSettings,
            runtime,
            contribution,
            adapter: projectExternalAdapter(contribution, declaration),
            createInvocationAccountOperations,
          }));
        }
        for (const registration of registrations) {
          const {
            declaration,
            providerId,
            providerSettings,
            runtime,
            adapter,
            createInvocationAccountOperations,
          } = registration;
          const hostBinding = input.hostBindingsByLocalId?.[declaration.id];
          const recipientContract = hostBinding?.recipientContract
            ?? input.recipientContractsByLocalId?.[declaration.id]
            ?? null;
          const accountCredentialSlot = projectExternalAccountCredentialSlot(declaration, recipientContract);
          const createSettingsCredentials = (signal: AbortSignal) => createVoiceCredentialAccess({
            declaration,
            phase: 'settings',
            ...(createInvocationAccountOperations
              ? {
                  createMediated: () => createInvocationAccountOperations(
                    signal,
                    null,
                    'settings',
                  ),
                }
              : {}),
            raw: input.clientRuntimeIdentitiesByLocalId?.[declaration.id]
              ? createDeclaredVoiceClientRawCredentialAccess({
                  declaration,
                  pluginId: input.pluginId,
                  identity: input.clientRuntimeIdentitiesByLocalId[declaration.id]!,
                  hostPlatform,
                  phase: 'settings',
                  generation: input.generation ?? '',
                  signal,
                  isCurrent,
                })
              : null,
          });
          const settingsOperations = runtime.settingsOperations
            ? bindVoiceProviderSettingsOperations({
                operations: runtime.settingsOperations,
                createCredentials: createSettingsCredentials,
                isCurrent,
                revocationSignal: settingsOperationsRevocation.signal,
              })
            : undefined;
          const settingsActions = runtime.settingsActions
            ? bindVoiceProviderSettingsActions({
                actions: runtime.settingsActions,
                declaredActions: declaration.settings?.actions ?? [],
                createCredentials: createSettingsCredentials,
                createInteractions: ({ signal, isCurrent: isInvocationCurrent }) => (
                  createAppShellTransientInteractions({
                    requester: Object.freeze({
                      pluginId: input.pluginId,
                      contributionId: declaration.id,
                      generationId: input.generation ?? 'bundled',
                      invocationId: `settings-${++nextSettingsActionInvocationId}`,
                    }),
                    signal,
                    isCurrent: isInvocationCurrent,
                  })
                ),
                getRealtimeClientToolDefinitions: () => host.getRealtimeClientToolDefinitions(),
                isCurrent,
                revocationSignal: settingsOperationsRevocation.signal,
              })
            : undefined;
          const requirements = projectVoiceProviderDeclarationRequirements(declaration);
          commitExternalVoiceProviderRegistration(Object.freeze({
            token,
            pluginId: input.pluginId,
            localId: declaration.id,
            providerId,
            descriptor: hostBinding?.descriptor === 'bundled' ? null : Object.freeze({
              pluginId: input.pluginId,
              providerId,
              settingsSectionId: providerId,
              kind: 'voice.conversation-provider.v1' as const,
              roles: declaration.roles,
              requirements,
              supportedPlatforms: declaration.platforms,
              selectionOptions: [Object.freeze({
                id: 'default', modeId: 'default', order: 10_000,
                titleKey: declarationTitle(declaration),
                subtitleKey: input.pluginId,
                configPatch: providerSettings.defaultConfig,
              })],
              projectSettings: (
                envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
              ) => projectExternalVoiceProviderSettings(envelope, providerSettings),
              providerSettings,
              declaration,
              ...(accountCredentialSlot ? { accountCredentialSlot } : {}),
              source: Object.freeze({
                kind: 'external' as const,
                pluginId: input.pluginId,
                localId: declaration.id,
              }),
            }),
            adapter,
            ...(settingsOperations ? { settingsOperations } : {}),
            ...(settingsActions ? { settingsActions } : {}),
          }));
        }
        unsubscribeRuntimeGeneration = subscribeBundledConversationRuntimeGeneration(() => {
          if (readCurrentHost() === host) return;
          // Authority is withdrawn synchronously; host-owned teardown may finish
          // asynchronously after the replacement generation becomes current.
          removeExternalVoiceProviderRegistration(token);
          void disposeCommittedRuntimes();
        });
        if (readCurrentHost() !== host) {
          await disposeCommittedRuntimes();
          throw activationError('voice_runtime_host_replaced');
        }
      } catch (error) {
        await disposeCommittedRuntimes();
        throw error;
      }
    },
    async unwind() {
      if (unwound) return;
      unwound = true;
      await disposeCommittedRuntimes();
      await registrationScope.dispose();
    },
  });
}
