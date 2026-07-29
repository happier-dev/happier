import type {
  BundledRealtimeProviderRuntimeConfig,
  BundledRealtimeProviderRuntimeHost,
  BundledVoiceRuntimeContribution,
  VoiceRealtimeConnection,
  VoiceRealtimeProtocolAdapter,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  buildQualifiedPluginContributionKey,
  ConnectedServiceBindingsV1Schema,
  createRecipientContractDigestV1,
  createPluginContributionIdentity,
  normalizeRecipientContractV1,
  PluginVoiceProviderContributionV1Schema,
  listVoiceToolActionSpecs,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
  type PluginVoiceProviderContributionV1,
  type RecipientContractV1,
} from '@happier-dev/protocol';
import type {
  PluginVoiceAccountOperationService,
  PluginVoiceHostedConversationService,
  PluginVoiceProviderSettingsOperations,
  PluginVoiceProviderRuntimeRegistration,
  PluginVoiceRuntimePlatform,
} from '@happier-dev/plugin-sdk/runtime';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

import type { PluginUiExecutableActivationScope } from '@/components/plugins/reactNative/executableModuleHost';
import {
  readVoiceSettingsInput,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import type { VoiceAdapterController } from '@/voice/session/types';
import {
  createExternalVoiceProviderSettingsDescriptor,
  projectExternalVoiceProviderSettings,
  type ExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';
import { bindVoiceClientToolsToAttempt } from './attemptVoiceClientTools';

import {
  getCurrentBundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { subscribeBundledConversationRuntimeGeneration } from './bundledConversationRuntimeGeneration';
import { createBundledRealtimeProviderRuntime } from './createBundledRealtimeProviderRuntime';
import type { VoiceProviderRegistryEntry } from './providerRegistry';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
} from './externalVoiceProviderRegistrations';
import { getProviderConversationServiceFactory } from './providerConversationService';

type ExternalVoiceProviderProtocolLeaf = PluginVoiceProviderRuntimeRegistration['protocol'];
export type PluginVoiceConversationProviderContributionV1 = Extract<
  PluginVoiceProviderContributionV1,
  Readonly<{ kind: 'conversation' }>
>;

/**
 * Internal experimental UI-module ABI. External providers contribute only
 * provider-native protocol and connection leaves; the app host retains voice
 * lifecycle, mic, transcript, tools, privacy, cancellation, and persistence.
 */
export type ExternalVoiceProviderRuntimeRegistration = PluginVoiceProviderRuntimeRegistration;

type BoundVoiceProviderSettingsOperations = NonNullable<
  import('./externalVoiceProviderRegistrations').ExternalVoiceProviderRegistration['settingsOperations']
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

const VOICE_ACTION_IDS: ReadonlySet<string> = new Set(
  listVoiceToolActionSpecs().map((spec) => spec.id),
);
const MAX_VOICE_PROMPT_BLOCKS = 16;
const MAX_VOICE_PROMPT_BLOCK_BYTES = 16_384;
const MAX_VOICE_PROMPT_BLOCKS_TOTAL_BYTES = 65_536;
const MAX_VOICE_PROVIDER_CATALOG_ITEMS = 1_000;
const MAX_VOICE_PROVIDER_CATALOG_BYTES = 1_048_576;
const MAX_VOICE_PROVIDER_PREVIEW_URL_LENGTH = 16_384;

function settingsOperationContextInvalid(): Error {
  return Object.assign(new Error('voice_provider_settings_context_invalid'), {
    code: 'voice_provider_settings_context_invalid',
  });
}

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

export function projectVoiceProviderProvisioningContext(input: Readonly<{
  disabledActionIds: readonly string[];
  extraSystemAppendBlocks: readonly string[];
}>): Readonly<{
  disabledActionIds: readonly string[];
  extraSystemAppendBlocks: readonly string[];
}> {
  if (input.disabledActionIds.length > VOICE_ACTION_IDS.size
    || input.extraSystemAppendBlocks.length > MAX_VOICE_PROMPT_BLOCKS) {
    throw settingsOperationContextInvalid();
  }
  const disabledActionIds: string[] = [];
  const seen = new Set<string>();
  for (const id of input.disabledActionIds) {
    if (!VOICE_ACTION_IDS.has(id)) throw settingsOperationContextInvalid();
    if (!seen.has(id)) disabledActionIds.push(id);
    seen.add(id);
  }
  const encoder = new TextEncoder();
  const extraSystemAppendBlocks: string[] = [];
  let totalBytes = 0;
  for (const raw of input.extraSystemAppendBlocks) {
    if (typeof raw !== 'string') throw settingsOperationContextInvalid();
    const block = raw.trim();
    if (!block) continue;
    const byteLength = encoder.encode(block).byteLength;
    totalBytes += byteLength;
    if (byteLength > MAX_VOICE_PROMPT_BLOCK_BYTES
      || totalBytes > MAX_VOICE_PROMPT_BLOCKS_TOTAL_BYTES) {
      throw settingsOperationContextInvalid();
    }
    extraSystemAppendBlocks.push(block);
  }
  return Object.freeze({
    disabledActionIds: Object.freeze(disabledActionIds),
    extraSystemAppendBlocks: Object.freeze(extraSystemAppendBlocks),
  });
}

async function withSettingsInvocationSignal<T>(input: Readonly<{
  callerSignal: AbortSignal;
  revocationSignal: AbortSignal;
  run(signal: AbortSignal): Promise<T>;
}>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (input.callerSignal.aborted || input.revocationSignal.aborted) abort();
  input.callerSignal.addEventListener('abort', abort, { once: true });
  input.revocationSignal.addEventListener('abort', abort, { once: true });
  try {
    return await input.run(controller.signal);
  } finally {
    input.callerSignal.removeEventListener('abort', abort);
    input.revocationSignal.removeEventListener('abort', abort);
  }
}

/**
 * Project a provider-owned settings leaf through the host-owned account and
 * activation lifecycle boundary. One host-composed AbortSignal is shared by
 * the provider leaf and every account request in the invocation.
 */
export function bindVoiceProviderSettingsOperations(input: Readonly<{
  operations: PluginVoiceProviderSettingsOperations;
  createAccountOperations(signal: AbortSignal): PluginVoiceAccountOperationService;
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
        return await withSettingsInvocationSignal({
          callerSignal: request.signal,
          revocationSignal,
          async run(signal) {
            assertSettingsOperationCurrent(signal, input.isCurrent);
            let result: readonly VoiceRealtimeJsonValue[];
            try {
              result = await operations.listCatalog!({
                ...request,
                signal,
                accountOperations: input.createAccountOperations(signal),
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
    ...(operations.provision ? {
      async provision(
        request: Parameters<NonNullable<BoundVoiceProviderSettingsOperations['provision']>>[0],
      ) {
        const context = projectVoiceProviderProvisioningContext(request);
        return await withSettingsInvocationSignal({
          callerSignal: request.signal,
          revocationSignal,
          async run(signal) {
            assertSettingsOperationCurrent(signal, input.isCurrent);
            let result: VoiceRealtimeJsonValue;
            try {
              result = await operations.provision!({
                ...request,
                ...context,
                signal,
                accountOperations: input.createAccountOperations(signal),
              });
            } catch (error) {
              if (revocationSignal.aborted || !input.isCurrent()) throw settingsOperationCancelled();
              throw error;
            }
            assertSettingsOperationCurrent(signal, input.isCurrent);
            return VoiceRealtimeJsonValueSchema.parse(result);
          },
        });
      },
    } : {}),
  });
}

export type ExternalVoiceProviderActivationApi = Readonly<{
  voiceProviders: Readonly<{
    register(localId: string, runtime: ExternalVoiceProviderRuntimeRegistration): void;
  }>;
}>;

export type VoiceProviderActivationHostBinding = Readonly<{
  providerId: string;
  recipientContract?: RecipientContractV1 | null;
  inspectInvocationAccountOperations?(
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<void>;
  createInvocationAccountOperations?(
    signal: AbortSignal,
    conversationSessionId: string | null,
    isCurrent: () => boolean,
  ): PluginVoiceAccountOperationService;
  createInvocationHostedConversation?(
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): PluginVoiceHostedConversationService;
  resolveSurfaceCapabilities?: BundledRealtimeProviderRuntimeConfig['resolveSurfaceCapabilities'];
  descriptor: 'external' | 'bundled';
}>;

const REGISTRATION_KEYS = new Set([
  'protocol',
  'settingsOperations',
  'createConnection',
  'encodeToolResults',
  'encodeToolContinuation',
  'beforeToolContinuation',
  'beforeInterrupt',
  'forgetProviderConversation',
  'dispose',
  'encodePostCancelControls',
  'encodePostBargeInControls',
  'requiresMicForConnection',
  'setInputMuted',
  'encodeContextUpdate',
  'encodeTextTurn',
  'outputLevelMeter',
]);

const SETTINGS_OPERATION_KEYS = new Set(['listCatalog', 'provision']);

const PROTOCOL_KEYS = new Set([
  'preflight',
  'prepare',
  'decodeControl',
  'encodeTurnControl',
  'refreshAuth',
  'releasePrepared',
]);

const OPTIONAL_REGISTRATION_FUNCTIONS = [
  'beforeToolContinuation',
  'beforeInterrupt',
  'forgetProviderConversation',
  'dispose',
  'encodePostCancelControls',
  'encodePostBargeInControls',
  'setInputMuted',
] as const;

const OPTIONAL_PROTOCOL_FUNCTIONS = [
  'preflight',
  'refreshAuth',
  'releasePrepared',
] as const;

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function hasValidOptionalFunctions(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'function');
}

export function isVoiceProviderRuntimeRegistration(value: unknown): value is ExternalVoiceProviderRuntimeRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const runtime = value as Readonly<Record<string, unknown>>;
  if (!hasOnlyKeys(runtime, REGISTRATION_KEYS)) return false;
  if (runtime.settingsOperations !== undefined) {
    if (!runtime.settingsOperations
      || typeof runtime.settingsOperations !== 'object'
      || Array.isArray(runtime.settingsOperations)) return false;
    const settingsOperations = runtime.settingsOperations as Readonly<Record<string, unknown>>;
    if (!hasOnlyKeys(settingsOperations, SETTINGS_OPERATION_KEYS)
      || !hasValidOptionalFunctions(settingsOperations, ['listCatalog', 'provision'])
      || (settingsOperations.listCatalog === undefined && settingsOperations.provision === undefined)) return false;
  }
  if (!runtime.protocol || typeof runtime.protocol !== 'object' || Array.isArray(runtime.protocol)) return false;
  const protocol = runtime.protocol as Readonly<Record<string, unknown>>;
  return hasOnlyKeys(protocol, PROTOCOL_KEYS)
    && protocol.id === undefined
    && protocol.turnControls === undefined
    && typeof protocol.prepare === 'function'
    && typeof protocol.decodeControl === 'function'
    && typeof protocol.encodeTurnControl === 'function'
    && hasValidOptionalFunctions(protocol, OPTIONAL_PROTOCOL_FUNCTIONS)
    && typeof runtime.createConnection === 'function'
    && typeof runtime.encodeToolResults === 'function'
    && typeof runtime.encodeToolContinuation === 'function'
    && typeof runtime.encodeContextUpdate === 'function'
    && typeof runtime.encodeTextTurn === 'function'
    && hasValidOptionalFunctions(runtime, OPTIONAL_REGISTRATION_FUNCTIONS)
    && (runtime.requiresMicForConnection === undefined || typeof runtime.requiresMicForConnection === 'boolean')
    && (runtime.outputLevelMeter === undefined
      || runtime.outputLevelMeter === 'measured'
      || runtime.outputLevelMeter === 'unavailable');
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
    version: () => Object.freeze({ apiVersion: '1.0.0', wireVersion: 1, methods: Object.freeze([]) }),
    context: async () => unavailable(),
    watchContext: unavailable,
    executeAction: async () => unavailable(),
    readResource: async () => unavailable(),
    watchResource: unavailable,
    openSurface: async () => unavailable(),
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

function createUnavailableAccountOperations(): PluginVoiceAccountOperationService {
  return Object.freeze({
    async request(): Promise<never> {
      throw activationError('voice_account_operation_unavailable');
    },
  });
}

function declarationTitle(declaration: PluginVoiceProviderContributionV1): string {
  return typeof declaration.title === 'string' ? declaration.title : declaration.title.fallback;
}

function projectExternalAccountCredentialSlot(
  declaration: PluginVoiceConversationProviderContributionV1,
  recipientContract: RecipientContractV1 | null,
): NonNullable<VoiceProviderRegistryEntry['accountCredentialSlot']> | null {
  if (declaration.capabilities.readiness.requirements.length !== 1
    || declaration.capabilities.readiness.requirements[0] !== 'credential') return null;
  const mediation = declaration.accountMediation;
  if (!mediation || mediation.credentialSlots.length !== 1 || !recipientContract) return null;
  const slot = mediation.credentialSlots[0]!;
  const normalizedRecipientContract = normalizeRecipientContractV1(recipientContract);
  if (slot.scope !== 'account'
    || mediation.operations.some((operation) => operation.credentialSlotId !== slot.id)
    || normalizedRecipientContract.credentialSlot.id !== slot.id) return null;
  return Object.freeze({
    id: slot.id,
    scope: 'account' as const,
    kind: 'apiKey' as const,
    recipientContract: normalizedRecipientContract,
    recipientContractDigest: createRecipientContractDigestV1(normalizedRecipientContract),
  });
}

export function createExternalProtocol(
  host: BundledRealtimeProviderRuntimeHost,
  providerId: string,
  platform: PluginVoiceRuntimePlatform,
  declaration: PluginVoiceConversationProviderContributionV1,
  leaf: ExternalVoiceProviderProtocolLeaf,
  createInvocationAccountOperations?: (
    signal: AbortSignal,
    conversationSessionId: string | null,
  ) => PluginVoiceAccountOperationService,
  createInvocationHostedConversation?: (signal: AbortSignal) => PluginVoiceHostedConversationService,
  inspectInvocationAccountOperations?: (signal: AbortSignal) => Promise<void>,
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
        await inspectInvocationAccountOperations?.(preflightInput.signal);
        return result;
      } catch (error) {
        providerConfigByAttemptId.delete(preflightInput.attemptId);
        throw error;
      }
    },
    async prepare(prepareInput) {
      const providerConfig = prepareInput.reason === 'initial'
        ? providerConfigByAttemptId.get(prepareInput.attemptId) ?? readProviderConfig()
        : readProviderConfig();
      providerConfigByAttemptId.delete(prepareInput.attemptId);
      if (providerConfig === null) return { kind: 'declined', code: 'invalid_provider_settings' };
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
        accountOperations: createInvocationAccountOperations?.(
          prepareInput.signal,
          conversationSessionId,
        )
          ?? createUnavailableAccountOperations(),
        providerConversation: conversationSessionId
          && providerConversationFactory
          && providerConversationPersistenceAvailable
          ? providerConversationFactory.createAttempt(conversationSessionId)
          : null,
        hostedConversation: createInvocationHostedConversation?.(prepareInput.signal) ?? null,
      }));
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
  platform: PluginVoiceRuntimePlatform;
  providerId: string;
  providerRef?: Readonly<{ pluginId: string; localId: string }>;
  declaration: PluginVoiceConversationProviderContributionV1;
  runtime: ExternalVoiceProviderRuntimeRegistration;
  providerSettings?: ExternalVoiceProviderSettingsDescriptor;
  createInvocationAccountOperations?(
    signal: AbortSignal,
    conversationSessionId: string | null,
  ): PluginVoiceAccountOperationService;
  inspectInvocationAccountOperations?(signal: AbortSignal): Promise<void>;
  createInvocationHostedConversation?(signal: AbortSignal): PluginVoiceHostedConversationService;
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
        if (!connectedServicesBinding) {
          throw activationError('voice_agent_realtime_connected_services_binding_required');
        }
        const bindingAgent = typeof connectedServicesBinding.agent === 'string'
          ? Object.freeze({
              pluginId: provider.pluginId,
              localId: connectedServicesBinding.agent,
            })
          : connectedServicesBinding.agent;
        if (bindingAgent.pluginId !== agent.pluginId || bindingAgent.localId !== agent.localId) {
          throw activationError('voice_agent_realtime_binding_agent_mismatch');
        }
        return Object.freeze({
          kind: 'experimental_agent_session_realtime' as const,
          provider,
          agent,
          connectedServicesBinding,
        });
      })()
    : null;
  const supportsProviderConversationForget = declaration.capabilities.turn.resumption === 'resume';
  if (supportsProviderConversationForget !== (runtime.forgetProviderConversation !== undefined)) {
    throw activationError('voice_provider_resumption_registration_mismatch');
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
      input.inspectInvocationAccountOperations,
    ),
    async createConnection(connectionInput) {
      const {
        controlSessionId,
        ...providerConnectionInput
      } = connectionInput;
      const baseUi =
        input.createInvocationUi?.(connectionInput.signal) ?? createUnavailableInvocationUi();
      const connection = await runtime.createConnection(Object.freeze({
        ...providerConnectionInput,
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
    encodeToolResults: (results) => runtime.encodeToolResults(results),
    encodeToolContinuation: (responseId) => runtime.encodeToolContinuation(responseId),
    ...(runtime.beforeToolContinuation
      ? { beforeToolContinuation: (responseId: string, signal: AbortSignal) => runtime.beforeToolContinuation!(responseId, signal) }
      : {}),
    ...(runtime.forgetProviderConversation
      ? { runtimeActions: Object.freeze({ forget_provider_conversation: () => runtime.forgetProviderConversation!() }) }
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
    ...(runtime.requiresMicForConnection !== undefined
      ? { requiresMicForConnection: runtime.requiresMicForConnection }
      : {}),
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
  declaration: PluginVoiceConversationProviderContributionV1,
): VoiceAdapterController {
  if (declaration.capabilities.turn.bargeIn) return contribution.adapter;
  const { bargeIn: _bargeIn, ...adapter } = contribution.adapter;
  return Object.freeze(adapter);
}

export function createExternalVoiceProviderActivationScope(input: Readonly<{
  pluginId: string;
  generation?: string;
  declarations: readonly PluginVoiceConversationProviderContributionV1[];
  hostPlatform: string;
  runtimeHost?: BundledRealtimeProviderRuntimeHost;
  isRuntimeHostCurrent?(): boolean;
  recipientContractsByLocalId?: Readonly<Record<string, RecipientContractV1>>;
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
    const parsed = PluginVoiceProviderContributionV1Schema.safeParse(declaration);
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
  const declarationsById = new Map(declarations.map((declaration) => [declaration.id, declaration] as const));
  if (declarationsById.size !== declarations.length) {
    throw activationError('duplicate_voice_provider_declaration');
  }
  const token = Object.freeze({});
  const stagedById = new Map<string, ExternalVoiceProviderRuntimeRegistration>();
  let committedRuntimes: readonly BundledVoiceRuntimeContribution[] = Object.freeze([]);
  let committedHost: BundledRealtimeProviderRuntimeHost | null = null;
  let committed = false;
  let unwound = false;
  let unsubscribeRuntimeGeneration: (() => void) | null = null;
  let disposalPromise: Promise<void> | null = null;
  const settingsOperationsRevocation = new AbortController();
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
    const retiringRuntimes = committedRuntimes;
    committedRuntimes = Object.freeze([]);
    disposalPromise = Promise.all(retiringRuntimes.map(async (runtime) => {
      try {
        await runtime.dispose?.();
      } catch {
        // A plugin cleanup failure cannot retain registration authority.
      }
    })).then(() => undefined);
    await disposalPromise;
  };
  return Object.freeze({
    api: Object.freeze({
      voiceProviders: Object.freeze({
        register(localId: string, runtime: ExternalVoiceProviderRuntimeRegistration) {
          if (unwound || committed) throw activationError('external_voice_provider_registration_closed');
          if (!declarationsById.has(localId)) throw activationError('undeclared_voice_provider_registration');
          if (stagedById.has(localId)) throw activationError('duplicate_voice_provider_registration');
          if (!isVoiceProviderRuntimeRegistration(runtime)) {
            throw activationError('invalid_external_voice_provider_leaf_registration');
          }
          stagedById.set(localId, runtime);
        },
      }),
    }),
    isCurrent,
    async commit() {
      if (unwound || committed) throw activationError('external_voice_provider_registration_closed');
      if (stagedById.size !== declarationsById.size) throw activationError('missing_voice_provider_registration');
      const host = readCurrentHost();
      if (!host) throw activationError('voice_runtime_host_unavailable');
      committedHost = host;
      committed = true;
      const registrations: Array<Readonly<{
        declaration: PluginVoiceConversationProviderContributionV1;
        providerId: string;
        providerSettings: ExternalVoiceProviderSettingsDescriptor;
        runtime: ExternalVoiceProviderRuntimeRegistration;
        contribution: BundledVoiceRuntimeContribution;
        adapter: VoiceAdapterController;
      }>> = [];
      try {
        for (const declaration of declarations) {
          const runtime = stagedById.get(declaration.id);
          if (!runtime) throw activationError('missing_voice_provider_registration');
          const hostBinding = input.hostBindingsByLocalId?.[declaration.id];
          const providerId = hostBinding?.providerId
            ?? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
              pluginId: input.pluginId,
              localId: declaration.id,
            }));
          const providerSettings = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
          const recipientContract = hostBinding?.recipientContract
            ?? input.recipientContractsByLocalId?.[declaration.id]
            ?? null;
          if (runtime.settingsOperations && !recipientContract) {
            throw activationError('voice_provider_settings_account_operations_unavailable');
          }
          const createInvocationAccountOperations = hostBinding?.createInvocationAccountOperations
            ? (signal: AbortSignal, conversationSessionId: string | null) =>
                hostBinding.createInvocationAccountOperations!(
                  signal,
                  conversationSessionId,
                  isCurrent,
                )
            : recipientContract
            ? (signal: AbortSignal) => createAccountVoiceOperationService({
                providerId,
                recipientContract,
                signal,
                isCurrent,
                requireRecipientApproval: true,
              })
            : null;
          const inspectInvocationAccountOperations =
            hostBinding?.inspectInvocationAccountOperations
              ? (signal: AbortSignal) =>
                  hostBinding.inspectInvocationAccountOperations!(signal, isCurrent)
              : recipientContract
                ? async (signal: AbortSignal) => {
                    await createAccountVoiceOperationService({
                      providerId,
                      recipientContract,
                      signal,
                      isCurrent,
                      requireRecipientApproval: true,
                    }).inspectAvailability();
                  }
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
            ...(inspectInvocationAccountOperations
              ? { inspectInvocationAccountOperations }
              : {}),
            ...(hostBinding?.createInvocationHostedConversation
              ? {
                  createInvocationHostedConversation: (signal) =>
                    hostBinding.createInvocationHostedConversation!(signal, isCurrent),
                }
              : {}),
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
          registrations.push(Object.freeze({
            declaration,
            providerId,
            providerSettings,
            runtime,
            contribution,
            adapter: projectExternalAdapter(contribution, declaration),
          }));
          // Construction allocates host-owned resources synchronously. Transfer
          // ownership immediately so a later declaration failure can dispose all
          // already-created contributions.
          committedRuntimes = Object.freeze(registrations.map((registration) => registration.contribution));
        }
        for (const registration of registrations) {
          const {
            declaration,
            providerId,
            providerSettings,
            runtime,
            adapter,
          } = registration;
          const hostBinding = input.hostBindingsByLocalId?.[declaration.id];
          const recipientContract = hostBinding?.recipientContract
            ?? input.recipientContractsByLocalId?.[declaration.id]
            ?? null;
          const accountCredentialSlot = projectExternalAccountCredentialSlot(declaration, recipientContract);
          const settingsOperations = runtime.settingsOperations && recipientContract
            ? bindVoiceProviderSettingsOperations({
                operations: runtime.settingsOperations,
                createAccountOperations: hostBinding?.createInvocationAccountOperations
                  ? (signal) => hostBinding.createInvocationAccountOperations!(
                      signal,
                      null,
                      isCurrent,
                    )
                  : (signal) => createAccountVoiceOperationService({
                      providerId,
                      recipientContract,
                      signal,
                      isCurrent,
                      requireRecipientApproval: true,
                    }),
                isCurrent,
                revocationSignal: settingsOperationsRevocation.signal,
              })
            : undefined;
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
              requirements: declaration.capabilities.readiness.requirements,
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
              ...(accountCredentialSlot ? { accountCredentialSlot } : {}),
              source: Object.freeze({
                kind: 'external' as const,
                pluginId: input.pluginId,
                localId: declaration.id,
              }),
            }),
            adapter,
            ...(settingsOperations ? { settingsOperations } : {}),
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
      stagedById.clear();
    },
  });
}
