import {
  PluginAgentAcpTransportSchema,
  type PluginAgentAcpTransport,
} from '@happier-dev/protocol';
import {
  AgentLaunchEnvironmentV1Schema,
  AgentRuntimeJsonValueV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionProviderCheckpointV1Schema,
} from '@happier-dev/protocol/runtime';
import type {
  AgentAcpCompletionEvidenceOutcome,
  AgentAcpModel,
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeOptions,
  AgentSessionCancelResult,
  AgentSessionConfigurationResult,
  AgentSessionConfigurationSnapshot,
  AgentSessionConfigurationUpdate,
  AgentSessionSendRequest,
  AgentSessionSendResult,
  AgentSessionOpenRequest,
  AgentSessionHostServices,
  AgentSessionModelsSnapshot,
  AgentSessionModelsSource,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { ContentBlock, PromptRequest } from '@agentclientprotocol/sdk';
import {
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/agents/runtime/session/preAdmissionBuffer';
import type { HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import { createHash, randomUUID } from 'node:crypto';
import { extname, isAbsolute, relative, sep } from 'node:path';

import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AcpBackend, AcpBackendOptions } from '@/agent/acp/AcpBackend';
import type { AcpPromptSubmissionResult } from '@/agent/acp/runtime/acpRuntimeBackendContract';
import type { SessionModel } from '@/agent/acp/sessionSettings/sessionSettingsState';
import {
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  type AcpExtensionRegistration,
} from '@/agent/acp/connection/types';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { DefaultTransport } from '@/agent/transport';
import { DEFAULT_IDLE_TIMEOUT_MS } from '@/agent/acp/sessionUpdateHandlers';
import { createAgentSessionRuntimeEventStream } from '@/agent/runtime/session/events/agentSessionRuntimeEventStream';
import type { McpServerConfig } from '@/agent/core/AgentTypes';
import type { AcpReplayHistorySessionClient } from '@/agent/acp/sessionClient';
import { createAcpTransportHandlerFromDefinition } from '@/agent/acp/runtime/definition/transport';
import { buildAcpToolNameResolverInput } from '@/agent/acp/toolCalls';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import {
  isNamespacedAcpExtensionMethod,
  requestAcpHistoryExtension,
} from '@/agent/acp/history/acpHistoryExtensionMethods';
import { logger } from '@/ui/logger';
import {
  applyAcpRuntimeSessionConfigOption,
  applyAcpRuntimeSessionMode,
  applyAcpRuntimeSessionModel,
} from '@/agent/acp/runtime/sessionControls/applySessionControls';
import {
  readSessionModelStateFromSessionResponseAwaitable,
} from '@/agent/acp/sessionSettings/sessionSettingsState';

import { createPublicAcpPermissionHandler } from './createPublicAcpPermissionHandler';
import {
  AcpPromptProjectionError,
  buildAcpPromptContentBlocks,
} from './buildAcpPromptContentBlocks';
import { createPublicAcpPreAcknowledgementBuffer } from './publicAcpPreAcknowledgementBuffer';
import { createAcpToolUpdatePolicy } from './acpToolUpdatePolicy';

type PublicAcpSystemToolGrant = Readonly<{
  toolId: string;
  launch: Readonly<{
    kind: string;
    executablePath: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>;
}>;

export type PublicAcpSystemTools = Readonly<{
  resolve(request: Readonly<{
    toolId: string;
    purpose: string;
    cwd: string;
    preferredPath?: string | null;
    signal?: AbortSignal;
  }>): Promise<PublicAcpSystemToolGrant>;
}>;

export type PublicAcpManagedDependencies = Readonly<{
  resolve(request: Readonly<{
    pluginId: string;
    dependencyId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    release(): void;
  }>>;
}>;

export type PublicAcpComposerDependencies = Readonly<{
  pluginId: string;
  agentId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  systemTools: PublicAcpSystemTools;
  managedDependencies?: PublicAcpManagedDependencies;
  interactions: PluginCurrentSessionInteractionsService;
  media: SessionMediaService;
  models: AgentSessionHostServices['models'];
  resumeHistorySession?: AcpReplayHistorySessionClient;
  mcpServers?: Record<string, McpServerConfig>;
  transformAgentChildLaunchEnvironment?: (
    environment: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;
  transformAgentRequest?: (
    payload: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal: AbortSignal }>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAcpContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image' || value.type === 'audio') {
    return typeof value.data === 'string' && typeof value.mimeType === 'string';
  }
  if (value.type === 'resource_link') {
    return typeof value.name === 'string' && typeof value.uri === 'string';
  }
  if (value.type !== 'resource' || !isRecord(value.resource)) return false;
  return typeof value.resource.uri === 'string'
    && (typeof value.resource.text === 'string' || typeof value.resource.blob === 'string');
}

function readAcpPromptRequest(value: unknown): PromptRequest | null {
  if (
    !isRecord(value)
    || typeof value.sessionId !== 'string'
    || value.sessionId.trim().length === 0
    || !Array.isArray(value.prompt)
    || !value.prompt.every(isAcpContentBlock)
  ) return null;
  const metadata = value._meta;
  if (metadata !== undefined && metadata !== null && !isRecord(metadata)) return null;
  return {
    sessionId: value.sessionId,
    prompt: [...value.prompt],
    ...(metadata === undefined ? {} : { _meta: metadata }),
  };
}

export type PublicAcpAwaitableAdapter = Readonly<{
  selectAuthMethod?: (
    context: Parameters<NonNullable<Extract<
      NonNullable<AgentAcpRuntimeDefinition['auth']>,
      { selectMethod: unknown }
    >['selectMethod']>>[0],
  ) => Promise<ReturnType<NonNullable<Extract<
    NonNullable<AgentAcpRuntimeDefinition['auth']>,
    { selectMethod: unknown }
  >['selectMethod']>>>;
  projectModel?: (
    rawModel: JsonValue,
    normalizedModel: AgentAcpModel,
  ) => Promise<AgentAcpModel>;
  projectUpdate?: (
    input: Parameters<NonNullable<
      NonNullable<AgentAcpRuntimeDefinition['models']>['projectUpdate']
    >>[0],
  ) => Promise<ReturnType<NonNullable<
    NonNullable<AgentAcpRuntimeDefinition['models']>['projectUpdate']
  >>>;
  projectSetModelResponse?: (
    input: Parameters<NonNullable<
      NonNullable<AgentAcpRuntimeDefinition['models']>['projectSetModelResponse']
    >>[0],
  ) => Promise<ReturnType<NonNullable<
    NonNullable<AgentAcpRuntimeDefinition['models']>['projectSetModelResponse']
  >>>;
  resolveToolName?: (
    input: Parameters<NonNullable<AgentAcpRuntimeDefinition['toolNameResolver']>>[0],
  ) => Promise<string | null>;
  sanitizeToolUpdate?: (
    update: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  projectGeneratedMedia?: (
    input: Parameters<NonNullable<
      NonNullable<AgentAcpRuntimeDefinition['generatedMedia']>['projectTerminalOutput']
    >>[0],
  ) => Promise<ReturnType<NonNullable<
    NonNullable<AgentAcpRuntimeDefinition['generatedMedia']>['projectTerminalOutput']
  >>>;
  projectUserMessageProviderCheckpoint?: (input: JsonValue) => Promise<JsonValue | null>;
  buildForkParams?: (
    input: Parameters<NonNullable<
      NonNullable<NonNullable<AgentAcpRuntimeDefinition['history']>['fork']>['buildParams']
    >>[0],
  ) => Promise<JsonValue>;
  readForkProviderSessionId?: (response: JsonValue) => Promise<string | null>;
}>;

type AgentAcpGeneratedMediaDescriptor = NonNullable<
  ReturnType<
    NonNullable<AgentAcpRuntimeDefinition['generatedMedia']>['projectTerminalOutput']
  >
>[number];

type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type PublicAcpTransportTimeouts = Readonly<{
  initializeMs?: number;
  idleMs?: number;
  toolCallMs?: number;
}>;
type PublicAcpLaunch = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  unsetEnv: readonly string[];
  timeouts: PublicAcpTransportTimeouts;
  release?: () => void;
}>;
type ActiveTurn = {
  turnId: string;
  inputIds: AgentSessionSendRequest['inputIds'];
  delivery: 'newTurn' | 'followUp';
  /** Immutable authority from the exact input that opened this turn. */
  causalPermissionAuthority?: AgentSessionSendRequest['causalPermissionAuthority'];
  cancelCause: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery' | null;
  submissionSettled: boolean;
  providerCheckpoint: JsonValue | null;
  providerCheckpointAmbiguous: boolean;
};
type WithoutEventBase<T> = T extends unknown
  ? Omit<T, 'sequence' | 'sessionId' | 'emittedAtMs'>
  : never;
type UnsequencedAgentSessionRuntimeEvent = WithoutEventBase<AgentSessionRuntimeEvent>;
export type PublicAcpSessionRuntime = AgentSessionRuntime & Readonly<{
  getProviderSessionId(): string | null;
  drainPendingPublications(): Promise<void>;
  requestExtension(
    method: string,
    params: JsonValue,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<JsonValue>;
}>;

const AUTH_METHOD_ID_MAX_CODE_UNITS = 256;
const MODEL_REQUEST_METADATA_MAX_CODE_UNITS = 16_384;
const COMPLETION_FAILURE_MESSAGE_MAX_CODE_UNITS = 1_024;
const GENERATED_MEDIA_DESCRIPTOR_LIMIT = 8;
const GENERATED_MEDIA_PATH_MAX_CODE_UNITS = 4_096;
const GENERATED_MEDIA_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

function isGeneratedMediaPathInsideRoot(rootPath: string, mediaPath: string): boolean {
  const relativePath = relative(rootPath, mediaPath);
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function validateGeneratedMediaDescriptors(
  value: readonly AgentAcpGeneratedMediaDescriptor[],
): readonly AgentAcpGeneratedMediaDescriptor[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > GENERATED_MEDIA_DESCRIPTOR_LIMIT
  ) {
    return null;
  }
  const descriptors: AgentAcpGeneratedMediaDescriptor[] = [];
  const fingerprints = new Set<string>();
  for (const descriptor of value) {
    if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) return null;
    const keys = Object.keys(descriptor).sort();
    if (keys.length !== 2 || keys[0] !== 'path' || keys[1] !== 'rootPath') return null;
    if (
      typeof descriptor.rootPath !== 'string'
      || descriptor.rootPath.trim().length === 0
      || descriptor.rootPath !== descriptor.rootPath.trim()
      || descriptor.rootPath.length > GENERATED_MEDIA_PATH_MAX_CODE_UNITS
      || descriptor.rootPath.includes('\0')
      || !isAbsolute(descriptor.rootPath)
      || typeof descriptor.path !== 'string'
      || descriptor.path.trim().length === 0
      || descriptor.path !== descriptor.path.trim()
      || descriptor.path.length > GENERATED_MEDIA_PATH_MAX_CODE_UNITS
      || descriptor.path.includes('\0')
      || !isAbsolute(descriptor.path)
      || !GENERATED_MEDIA_IMAGE_EXTENSIONS.has(extname(descriptor.path).toLowerCase())
      || !isGeneratedMediaPathInsideRoot(descriptor.rootPath, descriptor.path)
    ) {
      return null;
    }
    const fingerprint = JSON.stringify([descriptor.rootPath, descriptor.path]);
    if (fingerprints.has(fingerprint)) return null;
    fingerprints.add(fingerprint);
    descriptors.push(Object.freeze({
      rootPath: descriptor.rootPath,
      path: descriptor.path,
    }));
  }
  return Object.freeze(descriptors);
}

function diagnostic(code: string, message?: string) {
  return Object.freeze({
    code,
    severity: 'error' as const,
    ...(message ? { message } : {}),
  });
}

function assertComposerCurrent(dependencies: PublicAcpComposerDependencies): void {
  dependencies.signal.throwIfAborted();
  if (!dependencies.isCurrent()) {
    throw new Error(`ACP composer generation for '${dependencies.agentId}' is no longer current`);
  }
}

function readLocalExecutableId(
  executable: Extract<PluginAgentAcpTransport, { kind: 'stdio' }>['executable'],
  pluginId: string,
): string {
  if (typeof executable.id === 'string') return executable.id;
  if (executable.id.pluginId !== pluginId) {
    throw new Error(
      `Public ACP composition cannot launch another plugin's ${
        executable.kind === 'systemTool' ? 'system tool' : 'managed dependency'
      }`,
    );
  }
  return executable.id.localId;
}

class PublicAcpTransport extends DefaultTransport {
  constructor(
    agentName: string,
    private readonly timeouts: PublicAcpTransportTimeouts,
  ) {
    super(agentName);
  }

  override getInitTimeout(): number {
    return this.timeouts.initializeMs ?? super.getInitTimeout();
  }

  getIdleTimeout(): number {
    return this.timeouts.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  override getToolCallTimeout(toolCallId: string, toolKind?: string): number | null {
    return this.timeouts.toolCallMs ?? super.getToolCallTimeout(toolCallId, toolKind);
  }
}

function parseExtensionJson(value: unknown) {
  return AgentRuntimeJsonValueV1Schema.parse(value);
}

function assertExtensionMethod(method: string): void {
  if (!isNamespacedAcpExtensionMethod(method)) {
    throw new Error(`Invalid namespaced ACP extension method '${method}'`);
  }
}

function readAuthMethodId(options: AgentAcpRuntimeOptions): string | undefined {
  const auth = options.definition?.auth;
  if (!auth || !('methodId' in auth)) return undefined;
  const methodId = auth.methodId;
  if (
    typeof methodId !== 'string'
    || methodId.trim().length === 0
    || methodId.length > AUTH_METHOD_ID_MAX_CODE_UNITS
  ) {
    throw new Error('Public ACP auth methodId must be a nonblank bounded string');
  }
  return methodId;
}

function readAuthSelector(options: AgentAcpRuntimeOptions) {
  const auth = options.definition?.auth;
  return auth && 'selectMethod' in auth ? auth.selectMethod : undefined;
}

function readParameterizedModelPicker(
  options: AgentAcpRuntimeOptions,
): boolean | undefined {
  const parameterizedModelPicker = options.definition?.parameterizedModelPicker;
  return typeof parameterizedModelPicker === 'boolean'
    ? parameterizedModelPicker
    : undefined;
}

function validateCompletionEvidenceOutcome(
  outcome: AgentAcpCompletionEvidenceOutcome,
): Readonly<{ kind: 'completed' | 'cancelled' | 'failed'; message?: string }> | null {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  const keys = Object.keys(outcome);
  if (outcome.kind === 'completed' || outcome.kind === 'cancelled') {
    return keys.length === 1 ? { kind: outcome.kind } : null;
  }
  if (outcome.kind !== 'failed') return null;
  if (keys.some((key) => key !== 'kind' && key !== 'message')) return null;
  if (outcome.message === undefined) return { kind: 'failed' };
  if (typeof outcome.message !== 'string' || outcome.message.length > COMPLETION_FAILURE_MESSAGE_MAX_CODE_UNITS) {
    return null;
  }
  return { kind: 'failed', message: outcome.message };
}

function validateProjectedModelUpdate(
  value: Readonly<{
    modelId: string;
    requestMeta?: Readonly<Record<string, JsonValue>>;
  }> | null | undefined,
  expectedModelId: string,
): Readonly<{ modelId: string; requestMeta?: Readonly<Record<string, unknown>> }> | null {
  if (value === null || value === undefined) return null;
  if (value.modelId !== expectedModelId) {
    throw new Error('ACP model update projector changed the active model identity');
  }
  if (value.requestMeta === undefined) return { modelId: value.modelId };
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(value.requestMeta);
  if (
    !parsed.success
    || !parsed.data
    || typeof parsed.data !== 'object'
    || Array.isArray(parsed.data)
    || JSON.stringify(parsed.data).length > MODEL_REQUEST_METADATA_MAX_CODE_UNITS
  ) {
    throw new Error('ACP model update projector returned invalid request metadata');
  }
  return { modelId: value.modelId, requestMeta: Object.freeze({ ...parsed.data }) };
}

function createExtensionRegistrations(
  options: AgentAcpRuntimeOptions,
): ReadonlyArray<AcpExtensionRegistration> {
  const registrations: AcpExtensionRegistration[] = [];
  for (const [method, handler] of Object.entries(options.extensions?.requests ?? {})) {
    assertExtensionMethod(method);
    registrations.push(defineAcpExtensionRequest({
      method,
      params: { parse: parseExtensionJson },
      handler: async (params, context) => parseExtensionJson(await handler(params, context)),
    }));
  }
  for (const [method, handler] of Object.entries(options.extensions?.notifications ?? {})) {
    assertExtensionMethod(method);
    registrations.push(defineAcpExtensionNotification({
      method,
      params: { parse: parseExtensionJson },
      handler,
    }));
  }
  return Object.freeze(registrations);
}

async function resolveLaunch(
  transport: PluginAgentAcpTransport,
  request: AgentSessionOpenRequest,
  dependencies: PublicAcpComposerDependencies,
): Promise<PublicAcpLaunch> {
  if (transport.kind !== 'stdio') {
    throw new Error(`Public ACP ${transport.kind} transport is not available in this host`);
  }
  const executableId = readLocalExecutableId(transport.executable, dependencies.pluginId);
  const launchEnvironment = AgentLaunchEnvironmentV1Schema.parse(
    request.launchEnvironment ?? { values: {}, unset: [] },
  );
  let command: string;
  let args: readonly string[] | undefined;
  let env: Readonly<Record<string, string>> | undefined;
  let release: (() => void) | undefined;
  if (transport.executable.kind === 'systemTool') {
    const grant = await dependencies.systemTools.resolve({
      toolId: executableId,
      purpose: `agent-acp:${dependencies.agentId}`,
      cwd: request.cwd,
      preferredPath: transport.preferredPath,
      signal: dependencies.signal,
    });
    assertComposerCurrent(dependencies);
    if (grant.toolId !== executableId || grant.launch.kind !== 'binary') {
      throw new Error(`ACP system tool '${executableId}' did not resolve to its exact binary grant`);
    }
    command = grant.launch.executablePath;
    args = grant.launch.args;
    env = grant.launch.env;
  } else {
    if (transport.preferredPath !== undefined && transport.preferredPath !== null) {
      throw new Error('Managed-dependency ACP transports cannot override their resolved executable path');
    }
    if (!dependencies.managedDependencies) {
      throw new Error('Managed-dependency ACP resolution is unavailable in this host');
    }
    const resolved = await dependencies.managedDependencies.resolve({
      pluginId: dependencies.pluginId,
      dependencyId: executableId,
      signal: dependencies.signal,
    });
    try {
      assertComposerCurrent(dependencies);
      if (!isAbsolute(resolved.command)) {
        throw new Error(`ACP managed dependency '${executableId}' did not resolve to an absolute executable path`);
      }
    } catch (error) {
      resolved.release();
      throw error;
    }
    command = resolved.command;
    args = resolved.args;
    env = resolved.env;
    release = resolved.release;
  }
  const environment = {
    ...(env ?? {}),
    ...(transport.env ?? {}),
    ...launchEnvironment.values,
  };
  for (const key of launchEnvironment.unset) {
    delete environment[key];
  }
  return Object.freeze({
    command,
    args: Object.freeze([...(args ?? []), ...(transport.args ?? [])]),
    env: Object.freeze(environment),
    unsetEnv: launchEnvironment.unset,
    timeouts: transport.timeouts ?? Object.freeze({}),
    ...(release ? { release } : {}),
  });
}

function processExitMessage(exit: ProcessExit): string {
  if (exit.signal) return `ACP process exited with signal ${exit.signal}`;
  return `ACP process exited with code ${exit.code ?? 'unknown'}`;
}

function configurationFieldChanged<T>(
  current: Readonly<{ value: T; updatedAtMs: number }> | undefined,
  next: Readonly<{ value: T; updatedAtMs: number }>,
): boolean {
  return (current === undefined || next.updatedAtMs > current.updatedAtMs)
    && !Object.is(current?.value, next.value);
}

function mergeConfigurationSnapshot(
  current: AgentSessionConfigurationSnapshot | null,
  update: AgentSessionConfigurationSnapshot,
): AgentSessionConfigurationSnapshot {
  const selectNewer = <T>(
    previous: Readonly<{ value: T; updatedAtMs: number }> | undefined,
    candidate: Readonly<{ value: T; updatedAtMs: number }>,
  ): Readonly<{ value: T; updatedAtMs: number }> => (
    previous === undefined || candidate.updatedAtMs > previous.updatedAtMs
      ? candidate
      : previous
  );
  const mergedOptions = { ...(current?.options ?? {}) };
  for (const [id, candidate] of Object.entries(update.options)) {
    mergedOptions[id] = selectNewer(mergedOptions[id], candidate);
  }
  return Object.freeze({
    mode: selectNewer(current?.mode, update.mode),
    model: selectNewer(current?.model, update.model),
    permissionIntent: selectNewer(current?.permissionIntent, update.permissionIntent),
    options: Object.freeze(mergedOptions),
  });
}

export async function createPublicAcpSessionFromAwaitableAdapter(
  request: AgentSessionOpenRequest,
  options: AgentAcpRuntimeOptions,
  dependencies: PublicAcpComposerDependencies,
  awaitableAdapter: PublicAcpAwaitableAdapter,
): Promise<PublicAcpSessionRuntime> {
  assertComposerCurrent(dependencies);
  const transport = PluginAgentAcpTransportSchema.parse(options.transport);
  const launch = await resolveLaunch(transport, request, dependencies);
  let launchReleased = false;
  const releaseLaunch = (): void => {
    if (launchReleased) return;
    launchReleased = true;
    launch.release?.();
  };
  try {
  const extensions = createExtensionRegistrations(options);
  const transportHandler = options.definition
    ? createAcpTransportHandlerFromDefinition({
        backendId: dependencies.agentId,
        timeouts: {
          ...(launch.timeouts.initializeMs ? { initMs: launch.timeouts.initializeMs } : {}),
          ...(launch.timeouts.idleMs ? { idleMs: launch.timeouts.idleMs } : {}),
          ...(launch.timeouts.toolCallMs ? { toolCallMs: launch.timeouts.toolCallMs } : {}),
          ...(options.definition.timeouts ?? {}),
        },
        ...(options.definition.toolNameInference
          ? { toolNameInference: options.definition.toolNameInference }
          : {}),
        ...(options.definition.stderrRules ? { stderrRules: options.definition.stderrRules } : {}),
        ...(options.definition.toolNameResolver && !awaitableAdapter.resolveToolName
          ? { callbacks: { toolNameResolver: options.definition.toolNameResolver } }
          : {}),
        ...(options.definition.sanitizeToolUpdateContent && !awaitableAdapter.sanitizeToolUpdate
          ? { sanitizeToolUpdateContent: options.definition.sanitizeToolUpdateContent }
          : {}),
      })
    : new PublicAcpTransport(dependencies.agentId, launch.timeouts);
  const toolUpdatePolicy = options.definition?.toolUpdates
    ? createAcpToolUpdatePolicy(options.definition.toolUpdates)
    : null;
  let sequence = 0;
  let disposed = false;
  let runtimeEnded = false;
  let activeTurn: ActiveTurn | null = null;
  let bufferedMessages: AgentSessionPreAdmissionBuffer<AgentMessage> | null = null;
  let bufferedMessageFailure: Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }> | null = null;
  const readBufferedMessageFailure = () => bufferedMessageFailure;
  let emittedToolCallIds = new Set<string>();
  let pendingProcessExit: ProcessExit | null = null;
  let providerSessionId: string | null = null;
  let publishTail: Promise<void> = Promise.resolve();
  let disposePromise: Promise<void> | null = null;
  let publicationFailureDiagnostic: PluginDiagnosticData | null = null;
  let publicationFailureDisposePromise: Promise<void> | null = null;
  let configurationUpdateTail: Promise<void> = Promise.resolve();
  let generatedMediaPublishTail: Promise<void> = Promise.resolve();
  const initialConfiguration = request.configuration
    ? AgentSessionConfigurationSnapshotV1Schema.parse(request.configuration)
    : null;
  let currentConfiguration: AgentSessionConfigurationSnapshot | null = null;
  let backend: AcpBackend;
  let modelPublicationReady = false;
  let providerModelPublicationPending = false;
  let modelSnapshot: AgentSessionModelsSnapshot = Object.freeze({ models: null });
  const modelSubscribers = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
  const modelSource: AgentSessionModelsSource = Object.freeze({
    read: () => modelSnapshot,
    subscribe(handler) {
      modelSubscribers.add(handler);
      handler(modelSnapshot);
      return Object.freeze({
        dispose: () => { modelSubscribers.delete(handler); },
      });
    },
  });
  const publishProviderModels = (): void => {
    const state = backend.getSessionModelState();
    modelSnapshot = Object.freeze({
      models: state
        ? Object.freeze(state.availableModels.map((model) => Object.freeze({
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(model.modelOptions
              ? { modelOptions: Object.freeze(model.modelOptions.map((option) => Object.freeze({ ...option }))) }
              : {}),
          })))
        : null,
      ...(state ? { currentModelId: state.currentModelId } : {}),
    });
    for (const subscriber of modelSubscribers) subscriber(modelSnapshot);
  };

  const terminalizeForPublicationFailure = (
    failureDiagnostic: PluginDiagnosticData,
  ): void => {
    if (publicationFailureDiagnostic !== null || disposed) return;
    publicationFailureDiagnostic = failureDiagnostic;
    runtimeEnded = true;
    activeTurn = null;
    bufferedMessages?.dispose();
    bufferedMessages = null;
    bufferedMessageFailure = null;
    pendingProcessExit = null;
    publicationFailureDisposePromise ??= backend.dispose().catch(() => {
      // The stream failure remains the canonical public terminal diagnostic.
    });
  };
  const stream = createAgentSessionRuntimeEventStream({
    onFailure(failure) {
      terminalizeForPublicationFailure(failure.diagnostic);
    },
  });

  const publish = <Event extends UnsequencedAgentSessionRuntimeEvent>(event: Event): void => {
    if (disposed || runtimeEnded && event.kind !== 'runtime-ended') return;
    if (event.kind === 'runtime-ended') runtimeEnded = true;
    const normalized = {
      ...event,
      sequence: ++sequence,
      sessionId: request.sessionId,
      emittedAtMs: Date.now(),
    } as AgentSessionRuntimeEvent;
    publishTail = publishTail.then(async () => {
      const result = await stream.publish(normalized);
      if (result.status !== 'accepted' && !disposed) {
        terminalizeForPublicationFailure(result.diagnostic);
      }
    });
  };

  let backendMessageProjectionTail: Promise<void> = Promise.resolve();
  const emitBackendMessage = async (message: AgentMessage, turn: ActiveTurn): Promise<void> => {
    const turnId = turn.turnId;
    switch (message.type) {
      case 'model-output': {
        const text = message.textDelta ?? message.fullText ?? '';
        if (text) publish({ kind: 'message-delta', turnId, channel: 'assistant', text });
        return;
      }
      case 'tool-call': {
        if (emittedToolCallIds.has(message.callId)) return;
        const input = AgentRuntimeJsonValueV1Schema.safeParse(message.args);
        if (input.success) {
          const inferenceInput = buildAcpToolNameResolverInput(input.data, undefined);
          const toolName = awaitableAdapter.resolveToolName
            ? await awaitableAdapter.resolveToolName({
                toolName: message.toolName,
                toolCallId: message.callId,
                input: inferenceInput,
                context: {
                  toolCallCountSincePrompt: emittedToolCallIds.size + 1,
                },
              }) ?? message.toolName
            : transportHandler.determineToolName?.(
                message.toolName,
                message.callId,
                inferenceInput,
                {
                  recentPromptHadChangeTitle: false,
                  toolCallCountSincePrompt: emittedToolCallIds.size + 1,
                },
              ) ?? message.toolName;
          emittedToolCallIds.add(message.callId);
          publish({
            kind: 'tool-call',
            turnId,
            toolCallId: message.callId,
            toolName,
            input: input.data,
          });
        }
        return;
      }
      case 'tool-result': {
        const output = AgentRuntimeJsonValueV1Schema.safeParse(message.result);
        if (output.success) {
          publish({
            kind: 'tool-result',
            turnId,
            toolCallId: message.callId,
            output: output.data,
            ...(message.isError === undefined ? {} : { isError: message.isError }),
          });
        }
        return;
      }
      case 'fs-edit':
        if (message.path) {
          publish({
            kind: 'file-edit',
            turnId,
            editId: `acp-edit-${randomUUID()}`,
            path: message.path,
            description: message.description,
            ...(message.diff ? { diff: message.diff } : {}),
          });
        }
        return;
      case 'event': {
        if (
          message.name !== 'user_message_chunk'
          || !options.definition?.history
          || turn.providerCheckpointAmbiguous
        ) {
          return;
        }
        const payload = AgentRuntimeJsonValueV1Schema.safeParse(message.payload);
        if (!payload.success) return;
        let checkpoint: JsonValue | null;
        try {
          checkpoint = awaitableAdapter.projectUserMessageProviderCheckpoint
            ? await awaitableAdapter.projectUserMessageProviderCheckpoint(payload.data)
            : options.definition.history.projectUserMessageProviderCheckpoint(payload.data);
        } catch (error) {
          logger.debug(`[${dependencies.agentId}] Provider checkpoint projection failed closed`, error);
          return;
        }
        if (checkpoint === null) return;
        const parsedCheckpoint = AgentSessionProviderCheckpointV1Schema.safeParse(checkpoint);
        if (!parsedCheckpoint.success) {
          logger.debug(`[${dependencies.agentId}] Provider checkpoint projection returned invalid or oversized JSON`);
          return;
        }
        if (
          turn.providerCheckpoint !== null
          && JSON.stringify(turn.providerCheckpoint) !== JSON.stringify(parsedCheckpoint.data)
        ) {
          turn.providerCheckpoint = null;
          turn.providerCheckpointAmbiguous = true;
          return;
        }
        turn.providerCheckpoint = parsedCheckpoint.data;
        return;
      }
      default:
        return;
    }
  };

  const publishRuntimeEndedForProcessExit = (exit: ProcessExit): void => {
    publish({
      kind: 'runtime-ended',
      cause: 'processExited',
      retryable: true,
      diagnostic: diagnostic('acp_process_exited', processExitMessage(exit)),
    });
  };
  const observeProcessExit = (exit: ProcessExit): void => {
    if (disposed || runtimeEnded) return;
    const turn = activeTurn;
    if (turn?.submissionSettled && backend.getLastTurnOutcome() === null) {
      publish({
        kind: 'turn-failed',
        turnId: turn.turnId,
        diagnostic: diagnostic('acp_process_exited', processExitMessage(exit)),
      });
      activeTurn = null;
      bufferedMessages?.dispose();
      bufferedMessages = null;
      bufferedMessageFailure = null;
      publishRuntimeEndedForProcessExit(exit);
      return;
    }
    if (turn) {
      pendingProcessExit = exit;
      return;
    }
    publishRuntimeEndedForProcessExit(exit);
  };

  const authMethodId = readAuthMethodId(options);
  const authSelector = readAuthSelector(options);
  const parameterizedModelPicker = readParameterizedModelPicker(options);
  const permissionHandler = createPublicAcpPermissionHandler({
    interactions: dependencies.interactions,
    signal: dependencies.signal,
    resolveRequestId: (toolCallId) => activeTurn
      ? `acp:${JSON.stringify([activeTurn.turnId, toolCallId])}`
      : null,
    resolveTurnId: () => activeTurn?.turnId ?? null,
    resolveCausalPermissionAuthority: () => activeTurn?.causalPermissionAuthority ?? null,
  });
  const observePublishedTerminalToolResult: NonNullable<
    AcpBackendOptions['onPublishedTerminalToolResult']
  > = (result) => {
    const generatedMedia = options.definition?.generatedMedia;
    let scopeCurrent = false;
    try {
      scopeCurrent = !disposed
        && !runtimeEnded
        && !dependencies.signal.aborted
        && dependencies.isCurrent();
    } catch {
      scopeCurrent = false;
    }
    if (
      !generatedMedia
      || !scopeCurrent
      || providerSessionId === null
      || result.status !== 'completed'
      || !Object.prototype.hasOwnProperty.call(result, 'rawOutput')
    ) {
      return;
    }
    const rawOutput = AgentRuntimeJsonValueV1Schema.safeParse(result.rawOutput);
    if (!rawOutput.success) return;
    generatedMediaPublishTail = generatedMediaPublishTail.then(async () => {
      let projected: readonly AgentAcpGeneratedMediaDescriptor[] | null;
      try {
        projected = awaitableAdapter.projectGeneratedMedia
          ? await awaitableAdapter.projectGeneratedMedia({
              rawOutput: rawOutput.data,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
            })
          : generatedMedia.projectTerminalOutput({
              rawOutput: rawOutput.data,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
            });
      } catch (error) {
        logger.debug(`[${dependencies.agentId}] Generated-media projection failed closed`, error);
        return;
      }
      if (projected === null) return;
      const descriptors = validateGeneratedMediaDescriptors(projected);
      if (descriptors === null) {
        logger.debug(`[${dependencies.agentId}] Generated-media projection returned invalid descriptors`);
        return;
      }
      for (const descriptor of descriptors) {
      const fingerprint = JSON.stringify([result.localId, descriptor.rootPath, descriptor.path]);
      const mediaLocalId = `acp-generated-${createHash('sha256')
        .update(fingerprint)
        .digest('hex')
        .slice(0, 32)}`;
        let publicationCurrent = false;
        try {
          publicationCurrent = !disposed
            && !runtimeEnded
            && !dependencies.signal.aborted
            && dependencies.isCurrent();
        } catch {
          publicationCurrent = false;
        }
        if (!publicationCurrent) return;
        const sourceRoot = await dependencies.media.registerSourceRoot({
          rootPath: descriptor.rootPath,
        });
        try {
          let sourceCurrent = false;
          try {
            sourceCurrent = !disposed
              && !runtimeEnded
              && !dependencies.signal.aborted
              && dependencies.isCurrent();
          } catch {
            sourceCurrent = false;
          }
          if (!sourceCurrent) return;
          await sourceRoot.publishGenerated({
            localId: mediaLocalId,
            path: descriptor.path,
            toolCallId: result.toolCallId,
            createdAtMs: result.observedAtMs,
          });
        } finally {
          sourceRoot.dispose();
        }
      }
    }).catch((error) => {
      logger.debug(`[${dependencies.agentId}] Generated-media publication failed closed`, error);
    });
  };
  backend = createAcpBackend({
    agentName: dependencies.agentId,
    cwd: request.cwd,
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
    unsetEnv: launch.unsetEnv,
    ...(dependencies.transformAgentChildLaunchEnvironment
      ? {
          transformAgentChildLaunchEnvironment:
            dependencies.transformAgentChildLaunchEnvironment,
        }
      : {}),
    ...(dependencies.transformAgentRequest
      ? {
          transformPromptRequest: async (rawRequest, transformOptions) => {
            const priorPayload = Object.freeze({
              sessionId: request.sessionId,
              agentId: dependencies.agentId,
              runtimeFamily: 'acpSession' as const,
              method: 'session/prompt',
              request: rawRequest,
              timestampMs: Date.now(),
            });
            const transformed = await dependencies.transformAgentRequest!(
              priorPayload,
              transformOptions,
            );
            return readAcpPromptRequest(transformed.request) ?? rawRequest;
          },
        }
      : {}),
    ...(options.definition?.mcp.policy === 'pass_through' && dependencies.mcpServers
      ? { mcpServers: dependencies.mcpServers }
      : {}),
    transportHandler,
    permissionHandler,
    ...(authMethodId ? { authMethodId } : {}),
    ...(authSelector || awaitableAdapter.selectAuthMethod
      ? {
          authSelector: async (context: Parameters<NonNullable<AcpBackendOptions['authSelector']>>[0]) => (
            awaitableAdapter.selectAuthMethod
              ? await awaitableAdapter.selectAuthMethod({
                  advertisedMethodIds: context.advertisedMethodIds,
                  initializeMetadata: context.initializeMetadata
                    ? AgentRuntimeJsonValueV1Schema.parse(context.initializeMetadata) as Readonly<Record<string, JsonValue>>
                    : null,
                })
              : authSelector!({
            advertisedMethodIds: context.advertisedMethodIds,
            initializeMetadata: context.initializeMetadata
              ? AgentRuntimeJsonValueV1Schema.parse(context.initializeMetadata) as Readonly<Record<string, JsonValue>>
              : null,
                })
          ),
        }
      : {}),
    ...(typeof parameterizedModelPicker === 'boolean' ? { parameterizedModelPicker } : {}),
    ...(options.definition?.models?.projectModel && !awaitableAdapter.projectModel
      ? {
          projectModel: (
            rawModel: Readonly<Record<string, unknown>>,
            normalizedModel: SessionModel,
          ): SessionModel => {
            const projected = options.definition!.models!.projectModel(
              AgentRuntimeJsonValueV1Schema.parse(rawModel),
              normalizedModel,
            );
            return {
              id: projected.id,
              name: projected.name,
              ...(projected.description === undefined ? {} : { description: projected.description }),
              ...(projected.contextWindowTokens === undefined
                ? {}
                : { contextWindowTokens: projected.contextWindowTokens }),
              ...(projected.modelOptions
                ? { modelOptions: projected.modelOptions.map((modelOption) => ({
                    ...modelOption,
                    ...(modelOption.options ? { options: [...modelOption.options] } : {}),
                  })) }
                : {}),
            };
          },
        }
      : {}),
    ...(options.definition?.usage?.projectPromptUsage
      ? {
          projectPromptUsage: ({ usage, promptResponse }: Readonly<{
            usage: unknown;
            promptResponse: unknown;
          }>) => options.definition!.usage!.projectPromptUsage({
            usage: AgentRuntimeJsonValueV1Schema.parse(usage),
            promptResponse: AgentRuntimeJsonValueV1Schema.parse(promptResponse),
          }),
        }
      : {}),
    ...(awaitableAdapter.projectModel
      ? {
          prepareSessionModels: async (response: unknown) => (
            await readSessionModelStateFromSessionResponseAwaitable(
              response,
              async (rawModel, normalizedModel) => {
                const projected = await awaitableAdapter.projectModel!(
                  AgentRuntimeJsonValueV1Schema.parse(rawModel),
                  normalizedModel as AgentAcpModel,
                );
                return projected as SessionModel;
              },
            )
          ),
        }
      : {}),
    ...(options.definition?.models?.projectSetModelResponse && !awaitableAdapter.projectSetModelResponse
      ? {
          projectSetModelResponse: ({ response, requestedModelId, requestMeta, targetModel }) => {
            const parsedResponse = AgentRuntimeJsonValueV1Schema.safeParse(response);
            const parsedRequestMeta = requestMeta === null
              ? { success: true as const, data: null }
              : AgentRuntimeJsonValueV1Schema.safeParse(requestMeta);
            if (!parsedResponse.success || !parsedRequestMeta.success) return null;
            const projected = options.definition!.models!.projectSetModelResponse!({
              response: parsedResponse.data,
              requestedModelId,
              requestMeta: parsedRequestMeta.data as Readonly<Record<string, JsonValue>> | null,
              targetModel: targetModel as AgentAcpModel,
            });
            return projected
              ? {
                  id: projected.id,
                  name: projected.name,
                  ...(projected.description === undefined ? {} : { description: projected.description }),
                  ...(projected.contextWindowTokens === undefined
                    ? {}
                    : { contextWindowTokens: projected.contextWindowTokens }),
                  ...(projected.modelOptions
                    ? { modelOptions: projected.modelOptions.map((option) => ({
                        ...option,
                        ...(option.options ? { options: [...option.options] } : {}),
                      })) }
                    : {}),
                }
              : null;
          },
        }
      : {}),
    ...(awaitableAdapter.projectSetModelResponse
      ? {
          projectSetModelResponseAwaitable: async ({
            response,
            requestedModelId,
            requestMeta,
            targetModel,
          }: Parameters<NonNullable<AcpBackendOptions['projectSetModelResponseAwaitable']>>[0]) => (
            await awaitableAdapter.projectSetModelResponse!({
              response: AgentRuntimeJsonValueV1Schema.parse(response),
              requestedModelId,
              requestMeta: requestMeta === null
                ? null
                : AgentRuntimeJsonValueV1Schema.parse(requestMeta) as Readonly<Record<string, JsonValue>>,
              targetModel: targetModel as AgentAcpModel,
            }) as SessionModel | null
          ),
        }
      : {}),
    ...(toolUpdatePolicy || awaitableAdapter.sanitizeToolUpdate || awaitableAdapter.resolveToolName
      ? {
          prepareToolUpdate: async (
            update: Parameters<NonNullable<AcpBackendOptions['prepareToolUpdate']>>[0],
            context: Parameters<NonNullable<AcpBackendOptions['prepareToolUpdate']>>[1],
          ) => {
            const admitted = toolUpdatePolicy ? toolUpdatePolicy.prepare(update) : update;
            if (admitted === null) return null;
            const sanitized = awaitableAdapter.sanitizeToolUpdate
              ? await awaitableAdapter.sanitizeToolUpdate(
                  AgentRuntimeJsonValueV1Schema.parse(admitted) as Readonly<Record<string, unknown>>,
                )
              : admitted;
            if (!awaitableAdapter.resolveToolName) return sanitized;
            const toolCallId = typeof sanitized.toolCallId === 'string'
              ? sanitized.toolCallId
              : null;
            if (!toolCallId) return sanitized;
            const toolName = typeof sanitized.kind === 'string' ? sanitized.kind : 'other';
            const input = buildAcpToolNameResolverInput(
              Object.prototype.hasOwnProperty.call(sanitized, 'rawInput')
                ? sanitized.rawInput
                : undefined,
              typeof sanitized.title === 'string' ? sanitized.title : undefined,
            );
            const resolved = await awaitableAdapter.resolveToolName({
              toolName,
              toolCallId,
              input,
              context,
            });
            return resolved ? { ...sanitized, kind: resolved } : sanitized;
          },
        }
      : {}),
    ...(extensions.length > 0 ? { extensions } : {}),
    createExtensionContext: (method, sdkSignal, requestId) => Object.freeze({
      method,
      ...(requestId === undefined ? {} : { requestId: String(requestId) }),
      signal: AbortSignal.any([dependencies.signal, sdkSignal]),
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(providerSessionId && activeTurn
        ? {
            currentTurn: Object.freeze({
              turnId: activeTurn.turnId,
              submitCompletionEvidence(evidence: Readonly<{
                providerSessionId: string;
                promptId: string;
                outcome: AgentAcpCompletionEvidenceOutcome;
              }>): boolean {
                const turn = activeTurn;
                if (
                  disposed
                  || runtimeEnded
                  || dependencies.signal.aborted
                  || !dependencies.isCurrent()
                  || !turn
                  || turn.cancelCause !== null
                  || evidence.providerSessionId !== providerSessionId
                  || evidence.promptId !== turn.turnId
                ) {
                  return false;
                }
                const outcome = validateCompletionEvidenceOutcome(evidence.outcome);
                return outcome ? backend.submitCompletionEvidence(outcome) : false;
              },
            }),
          }
        : {}),
    }),
    onProcessExit: observeProcessExit,
    onPublishedTerminalToolResult: observePublishedTerminalToolResult,
  });
  const modelBinding = dependencies.models.bind(modelSource);

  backend.onMessage((message) => {
    if (
      message.type === 'event'
      && (message.name === 'session_models_state' || message.name === 'current_model_update')
    ) {
      if (modelPublicationReady) publishProviderModels();
      else providerModelPublicationPending = true;
    }
    const turn = activeTurn;
    if (!turn || disposed || runtimeEnded) return;
    if (turn.submissionSettled) {
      backendMessageProjectionTail = backendMessageProjectionTail.then(
        async () => await emitBackendMessage(message, turn),
      );
      return;
    }
    const result = bufferedMessages?.admit(message) ?? { status: 'disposed' as const };
    if (result.status === 'accepted' || bufferedMessageFailure !== null) return;
    bufferedMessageFailure = result;
    bufferedMessages?.dispose();
  });

  const disposeOnAbort = (): void => { void session.dispose(); };
  const conversationRollback = options.definition?.history?.createConversationRollback?.(
    Object.freeze({
      getProviderSessionId: () => providerSessionId,
      requestExtension: async (methods, params, requestOptions) => (
        AgentRuntimeJsonValueV1Schema.parse(
          await requestAcpHistoryExtension({
            methods,
            params,
            ...(requestOptions ? { options: requestOptions } : {}),
            requestExtension: (method, extensionParams, extensionOptions) => (
              backend.requestExtension(method, extensionParams, extensionOptions)
            ),
          }),
        )
      ),
    }),
  );
  const applyConfigurationControls = async (
    update: AgentSessionConfigurationSnapshot,
    previous: AgentSessionConfigurationSnapshot | null,
    applyOptions?: Readonly<{
      initial?: boolean;
      signal?: AbortSignal;
    }>,
  ): Promise<AgentSessionConfigurationResult> => {
    const changed: string[] = [];
    const modeChanged = configurationFieldChanged(previous?.mode, update.mode);
    const modelChanged = configurationFieldChanged(previous?.model, update.model);
    const permissionChanged = configurationFieldChanged(
      previous?.permissionIntent,
      update.permissionIntent,
    );
    const changedOptions = Object.entries(update.options).filter(([id, value]) => (
      configurationFieldChanged(previous?.options[id], value)
    ));

    if (permissionChanged && !applyOptions?.initial) {
      return {
        status: 'unsupported',
        diagnostic: diagnostic(
          'acp_permission_intent_update_requires_provider_restart',
          'The ACP provider applies permission intent when its process is launched.',
        ),
      };
    }
    if (!applyOptions?.initial && (
      (modeChanged && update.mode.value === null)
      || (modelChanged && update.model.value === null)
      || changedOptions.some(([, value]) => value.value === null)
    )) {
      return {
        status: 'unsupported',
        diagnostic: diagnostic('acp_configuration_clear_unsupported'),
      };
    }

    const controlContext = {
      provider: dependencies.agentId,
      getSessionId: () => providerSessionId,
      ensureBackend: async () => backend,
    };
    try {
      applyOptions?.signal?.throwIfAborted();
      if (modeChanged && update.mode.value !== null) {
        await applyAcpRuntimeSessionMode(controlContext, update.mode.value);
        changed.push('mode');
      }
      if (modelChanged && update.model.value !== null) {
        const modelConfigOptionId = options.definition?.modelConfigOptionId;
        if (modelConfigOptionId) {
          await applyAcpRuntimeSessionConfigOption(
            controlContext,
            modelConfigOptionId,
            update.model.value,
          );
        } else {
          await applyAcpRuntimeSessionModel(controlContext, update.model.value);
        }
        changed.push('model');
      }

      const applicableOptions = changedOptions.filter(([, value]) => value.value !== null);
      const modelState = backend.getSessionModelState();
      const targetModelId = modelState?.currentModelId
        ?? (modelChanged ? update.model.value : previous?.model.value)
        ?? null;
      const targetModel = targetModelId
        ? modelState?.availableModels.find((model) => model.id === targetModelId) ?? null
        : null;
      const projectedOptionUpdates = [];
      for (const [id, value] of applicableOptions) {
        if (
          (!options.definition?.models?.projectUpdate
            && !awaitableAdapter.projectUpdate)
          || !targetModel
        ) {
          continue;
        }
        const projectionInput = {
          configId: id,
          value: value.value,
          currentModel: targetModel as AgentAcpModel,
        };
        const projected = awaitableAdapter.projectUpdate
          ? await awaitableAdapter.projectUpdate(projectionInput)
          : options.definition!.models!.projectUpdate!(projectionInput);
        const validated = validateProjectedModelUpdate(projected, targetModel.id);
        if (validated) projectedOptionUpdates.push({ id, update: validated });
      }
      if (projectedOptionUpdates.length > 1) {
        throw new Error('ACP model update projector handled more than one option at once');
      }
      const projectedModelUpdate = projectedOptionUpdates[0]?.update;
      if (projectedModelUpdate) {
        await applyAcpRuntimeSessionModel(
          controlContext,
          projectedModelUpdate.modelId,
          projectedModelUpdate.requestMeta,
        );
      }
      for (const [id, value] of applicableOptions) {
        applyOptions?.signal?.throwIfAborted();
        if (!projectedOptionUpdates.some((entry) => entry.id === id)) {
          await applyAcpRuntimeSessionConfigOption(controlContext, id, value.value);
        }
        changed.push(`options.${id}`);
      }
    } catch (error) {
      return {
        status: applyOptions?.signal?.aborted ? 'unavailable' : 'rejected',
        diagnostic: diagnostic(
          applyOptions?.signal?.aborted
            ? 'acp_configuration_update_aborted'
            : 'acp_configuration_update_failed',
          error instanceof Error ? error.message : undefined,
        ),
      };
    }
    return { status: 'applied', changed: Object.freeze(changed) };
  };
  const session: PublicAcpSessionRuntime = Object.freeze({
    ...(conversationRollback ? { conversationRollback } : {}),
    runtimeCapabilities: {
      localControl: null,
      sessionCapabilities: {
        sessionListing: 'supported',
        sessionFork: {
          conversation: 'supported',
          fromMessage: options.definition?.history?.fork ? 'supported' : 'unsupported',
          protocol: 'acp',
        },
        sessionRollback: {
          conversation: conversationRollback ? 'supported' : 'unsupported',
        },
      },
    } as const,
    getProviderSessionId(): string | null {
      return providerSessionId;
    },
    async drainPendingPublications(): Promise<void> {
      while (true) {
        const projection = backendMessageProjectionTail;
        await projection;
        const publication = publishTail;
        await publication;
        if (
          projection === backendMessageProjectionTail
          && publication === publishTail
        ) {
          break;
        }
      }
      if (publicationFailureDiagnostic) {
        const error = new Error(
          publicationFailureDiagnostic.message
            ?? publicationFailureDiagnostic.code,
        ) as Error & { code: string };
        error.code = publicationFailureDiagnostic.code;
        throw error;
      }
    },
    async requestExtension(
      method: string,
      params: JsonValue,
      extensionOptions?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
    ): Promise<JsonValue> {
      assertExtensionMethod(method);
      const parsedParams = AgentRuntimeJsonValueV1Schema.parse(params);
      const response = await backend.requestExtension(method, parsedParams, extensionOptions);
      return AgentRuntimeJsonValueV1Schema.parse(response);
    },
    async send(sendRequest: AgentSessionSendRequest): Promise<AgentSessionSendResult> {
      if (disposed || runtimeEnded || dependencies.signal.aborted || !dependencies.isCurrent()) {
        return {
          status: 'unavailable' as const,
          diagnostic: publicationFailureDiagnostic ?? diagnostic('acp_runtime_unavailable'),
          retryable: false,
        };
      }
      if (sendRequest.delivery.kind === 'steer') {
        const turn = activeTurn;
        if (!turn || turn.turnId !== sendRequest.delivery.turnId || !providerSessionId) {
          return {
            status: 'rejected' as const,
            diagnostic: diagnostic('acp_steer_requires_active_turn'),
            retryable: true,
          };
        }
        // A steer is a new admitted input. Install its exact carrier before the
        // transport call, because ACP may request permission while that call is
        // still awaiting its prompt acknowledgement. Earlier requests already
        // hold their own copied context at the permission owner.
        turn.causalPermissionAuthority = sendRequest.causalPermissionAuthority;
        try {
          const providerSteer = options.definition?.delivery?.steer;
          if (providerSteer) {
            const extensionParams = AgentRuntimeJsonValueV1Schema.parse(providerSteer.buildParams({
              providerSessionId,
              inputIds: sendRequest.inputIds,
              input: sendRequest.input,
            }));
            const response = AgentRuntimeJsonValueV1Schema.parse(
              await backend.requestExtension(providerSteer.method, extensionParams),
            );
            if (!providerSteer.isAccepted(response)) {
              throw new Error('ACP provider steer extension did not accept input');
            }
          } else {
            await backend.sendSteerPrompt(providerSessionId, sendRequest.input.text);
          }
        } catch (error) {
          publish({
            kind: 'input-custody-unknown',
            inputIds: sendRequest.inputIds,
            issue: diagnostic(
              'acp_steer_custody_unknown',
              error instanceof Error ? error.message : undefined,
            ),
          });
          return { status: 'admitted' as const };
        }
        publish({
          kind: 'input-accepted',
          inputIds: sendRequest.inputIds,
          delivery: sendRequest.delivery,
        });
        return { status: 'admitted' as const };
      }
      if (activeTurn) {
        return {
          status: 'rejected' as const,
          diagnostic: diagnostic('acp_turn_already_active'),
          retryable: true,
        };
      }
      let promptContent;
      try {
        promptContent = await buildAcpPromptContentBlocks({
          cwd: request.cwd,
          text: sendRequest.input.text,
          ...(sendRequest.input.structuredInput === undefined
            ? {}
            : { structuredInput: sendRequest.input.structuredInput }),
          acceptsImageInput: backend.supportsImagePrompts()
            || options.definition?.acceptsVerifiedImageInput === true,
        });
      } catch (error) {
        if (error instanceof AcpPromptProjectionError) {
          return {
            status: error.code === 'acp_image_input_unsupported' ? 'unsupported' : 'rejected',
            diagnostic: diagnostic(error.code, error.message),
            retryable: false,
          };
        }
        throw error;
      }
      const turn: ActiveTurn = {
        turnId: sendRequest.delivery.turnId,
        inputIds: sendRequest.inputIds,
        delivery: sendRequest.delivery.kind,
        ...(sendRequest.causalPermissionAuthority
          ? { causalPermissionAuthority: sendRequest.causalPermissionAuthority }
          : {}),
        cancelCause: null,
        submissionSettled: false,
        providerCheckpoint: null,
        providerCheckpointAmbiguous: false,
      };
      activeTurn = turn;
      bufferedMessages?.dispose();
      bufferedMessages = createPublicAcpPreAcknowledgementBuffer();
      bufferedMessageFailure = null;
      emittedToolCallIds = new Set();
      let submissionResult: AcpPromptSubmissionResult;
      try {
        submissionResult = await backend.sendPrompt(providerSessionId!, promptContent, {
          metadata: { promptId: turn.turnId },
        });
      } catch (error) {
        if (activeTurn === turn) activeTurn = null;
        const admissionFailure = readBufferedMessageFailure();
        bufferedMessages?.dispose();
        bufferedMessages = null;
        bufferedMessageFailure = null;
        publish({
          kind: 'input-custody-unknown',
          inputIds: turn.inputIds,
          issue: diagnostic(
            admissionFailure ? 'acp_pre_admission_buffer_failed' : 'acp_input_custody_unknown',
            admissionFailure
              ? `ACP pre-admission buffer rejected a provider message (${admissionFailure.status}${admissionFailure.status === 'overflow' ? `:${admissionFailure.reason}` : ''})`
              : error instanceof Error ? error.message : 'ACP prompt admission failed',
          ),
        });
        if (pendingProcessExit) {
          const exit = pendingProcessExit;
          pendingProcessExit = null;
          observeProcessExit(exit);
        }
        return { status: 'admitted' as const };
      }
      const admissionFailure = readBufferedMessageFailure();
      if (admissionFailure !== null) {
        if (activeTurn === turn) activeTurn = null;
        bufferedMessages?.dispose();
        bufferedMessages = null;
        bufferedMessageFailure = null;
        publish({
          kind: 'input-custody-unknown',
          inputIds: turn.inputIds,
          issue: diagnostic(
            'acp_pre_admission_buffer_failed',
            `ACP pre-admission buffer rejected a provider message (${admissionFailure.status}${admissionFailure.status === 'overflow' ? `:${admissionFailure.reason}` : ''})`,
          ),
        });
        if (pendingProcessExit) {
          const exit = pendingProcessExit;
          pendingProcessExit = null;
          observeProcessExit(exit);
        }
        return { status: 'admitted' as const };
      }
      if (activeTurn !== turn || disposed || runtimeEnded) return { status: 'admitted' as const };
      if (submissionResult.kind === 'rejected_before_effect') {
        activeTurn = null;
        bufferedMessages?.dispose();
        bufferedMessages = null;
        bufferedMessageFailure = null;
        publish({
          kind: 'input-rejected',
          inputIds: turn.inputIds,
          diagnostic: diagnostic(
            'acp_input_rejected_before_effect',
            submissionResult.error.message,
          ),
          retryable: true,
        });
        if (pendingProcessExit) {
          const exit = pendingProcessExit;
          pendingProcessExit = null;
          observeProcessExit(exit);
        }
        return { status: 'admitted' as const };
      }

      turn.submissionSettled = true;
      if (submissionResult.kind === 'effect_may_have_occurred') {
        publish({
          kind: 'input-custody-unknown',
          inputIds: turn.inputIds,
          issue: diagnostic(
            'acp_input_custody_unknown',
            submissionResult.error.message,
          ),
        });
      } else {
        publish({
          kind: 'input-accepted',
          inputIds: turn.inputIds,
          delivery: sendRequest.delivery.kind === 'followUp'
            ? { kind: 'followUp', turnId: turn.turnId }
            : sendRequest.delivery,
        });
      }
      publish({
        kind: 'turn-start',
        turnId: turn.turnId,
        startedBy: 'host',
        ...(sendRequest.delivery.kind === 'followUp'
          ? { causedByTurnId: sendRequest.delivery.afterTurnId }
          : {}),
      });
      const admittedMessages = bufferedMessages?.drain() ?? [];
      bufferedMessages?.dispose();
      bufferedMessages = null;
      for (const message of admittedMessages) {
        backendMessageProjectionTail = backendMessageProjectionTail.then(
          async () => await emitBackendMessage(message, turn),
        );
      }
      void backend.waitForResponseComplete().then(async () => {
        await backendMessageProjectionTail;
        const outcome = backend.getLastTurnOutcome();
        const current = activeTurn;
        if (!current || current.turnId !== turn.turnId || disposed || runtimeEnded) return;
        if (outcome?.kind === 'aborted') {
          publish({
            kind: 'turn-cancelled',
            turnId: turn.turnId,
            cause: current.cancelCause ?? 'providerCancelled',
          });
        } else if (outcome?.kind === 'refused') {
          publish({
            kind: 'turn-failed',
            turnId: turn.turnId,
            diagnostic: diagnostic('acp_turn_refused'),
          });
        } else if (outcome?.kind === 'failed' || outcome?.kind === 'timed_out') {
          publish({
            kind: 'turn-failed',
            turnId: turn.turnId,
            diagnostic: diagnostic(
              outcome.kind === 'timed_out' ? 'acp_turn_timed_out' : 'acp_turn_failed',
              outcome.kind === 'failed' ? outcome.error.message : undefined,
            ),
          });
        } else {
          if (current.providerCheckpoint !== null && !current.providerCheckpointAmbiguous) {
            publish({
              kind: 'turn-rollback-boundary',
              turnId: turn.turnId,
              providerCheckpoint: current.providerCheckpoint,
            });
          }
          publish({ kind: 'turn-complete', turnId: turn.turnId });
        }
        activeTurn = null;
        if (pendingProcessExit) {
          const exit = pendingProcessExit;
          pendingProcessExit = null;
          observeProcessExit(exit);
        }
      }).catch(async (error) => {
        await backendMessageProjectionTail;
        const current = activeTurn;
        if (!current || current.turnId !== turn.turnId || disposed || runtimeEnded) return;
        publish({
          kind: current.cancelCause ? 'turn-cancelled' : 'turn-failed',
          turnId: turn.turnId,
          ...(current.cancelCause
            ? { cause: current.cancelCause }
            : { diagnostic: diagnostic('acp_turn_failed', error instanceof Error ? error.message : undefined) }),
        } as UnsequencedAgentSessionRuntimeEvent);
        activeTurn = null;
        if (pendingProcessExit) {
          const exit = pendingProcessExit;
          pendingProcessExit = null;
          observeProcessExit(exit);
        }
      });
      return { status: 'admitted' as const };
    },
    async cancel(cancelRequest: Parameters<NonNullable<AgentSessionRuntime['cancel']>>[0]): Promise<AgentSessionCancelResult> {
      if (disposed || runtimeEnded || dependencies.signal.aborted || !dependencies.isCurrent()) {
        return {
          status: 'unavailable' as const,
          diagnostic: publicationFailureDiagnostic ?? diagnostic('acp_runtime_unavailable'),
        };
      }
      const turn = activeTurn;
      if (!turn || turn.turnId !== cancelRequest.turnId) {
        return { status: 'notRunning' as const };
      }
      turn.cancelCause = cancelRequest.reason;
      await backend.cancel(providerSessionId ?? request.sessionId);
      return { status: 'requested' as const, turnId: cancelRequest.turnId };
    },
    async updateConfiguration(
      configurationRequest: AgentSessionConfigurationUpdate,
      updateOptions?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionConfigurationResult> {
      const applyUpdate = async (): Promise<AgentSessionConfigurationResult> => {
        if (disposed || runtimeEnded || dependencies.signal.aborted || !dependencies.isCurrent()) {
          return {
            status: 'unavailable',
            diagnostic: publicationFailureDiagnostic ?? diagnostic('acp_runtime_unavailable'),
          };
        }
        if (updateOptions?.signal?.aborted) {
          return {
            status: 'unavailable',
            diagnostic: diagnostic('acp_configuration_update_aborted'),
          };
        }
        const parsed = AgentSessionConfigurationSnapshotV1Schema.safeParse(configurationRequest);
        if (!parsed.success) {
          return {
            status: 'rejected',
            diagnostic: diagnostic('acp_configuration_update_invalid'),
          };
        }
        const update = parsed.data;
        const result = await applyConfigurationControls(
          update,
          currentConfiguration,
          { signal: updateOptions?.signal },
        );
        if (result.status !== 'applied') return result;
        currentConfiguration = mergeConfigurationSnapshot(currentConfiguration, update);
        return result;
      };
      const result = configurationUpdateTail.then(applyUpdate);
      configurationUpdateTail = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    },
    watch(listener: Parameters<AgentSessionRuntime['watch']>[0]) {
      return stream.watch(listener);
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        // Lifecycle listeners are downstream observers. Closing admission is
        // synchronous, but joining the listener drain here can deadlock when a
        // listener is itself waiting for this session retirement to complete.
        void stream.dispose();
        activeTurn = null;
        bufferedMessages?.dispose();
        bufferedMessages = null;
        bufferedMessageFailure = null;
        pendingProcessExit = null;
        modelSubscribers.clear();
        await modelBinding.dispose();
        dependencies.signal.removeEventListener('abort', disposeOnAbort);
        try {
          await backend.dispose();
        } finally {
          releaseLaunch();
        }
        await publicationFailureDisposePromise;
        await backendMessageProjectionTail;
        await generatedMediaPublishTail;
      })();
      return disposePromise;
    },
  });

  try {
    let replay: ReadonlyArray<unknown> | null = null;
    const openFork = async (): Promise<Readonly<{ sessionId: string }>> => {
      if (request.kind !== 'fork') {
        throw new Error('ACP fork opener requires a fork request');
      }
      const fork = options.definition?.history?.fork;
      if (!fork) {
        if (request.source.target) {
          throw new Error('This ACP Agent cannot fork from an exact turn');
        }
        return await backend.forkSession({
          sessionId: request.source.providerSessionId,
          cwd: request.cwd,
        });
      }
      const forkInput = {
        sourceProviderSessionId: request.source.providerSessionId,
        sourceCwd: request.source.cwd,
        newCwd: request.cwd,
        ...(request.source.target
          ? { providerCheckpoint: request.source.target.providerCheckpoint }
          : {}),
      };
      const params = AgentRuntimeJsonValueV1Schema.parse(
        awaitableAdapter.buildForkParams
          ? await awaitableAdapter.buildForkParams(forkInput)
          : fork.buildParams(forkInput),
      );
      const response = AgentRuntimeJsonValueV1Schema.parse(
        await requestAcpHistoryExtension({
          methods: fork.methods,
          params,
          options: { signal: dependencies.signal },
          assertCurrent: () => assertComposerCurrent(dependencies),
          requestExtension: (method, extensionParams, extensionOptions) => (
            backend.requestExtension(method, extensionParams, extensionOptions)
          ),
        }),
      );
      const forkedProviderSessionId = awaitableAdapter.readForkProviderSessionId
        ? await awaitableAdapter.readForkProviderSessionId(response)
        : fork.readProviderSessionId(response);
      if (!forkedProviderSessionId || forkedProviderSessionId !== forkedProviderSessionId.trim()) {
        throw new Error('ACP history fork response did not include a valid provider session id');
      }
      return await backend.loadExtensionForkSession(forkedProviderSessionId, response);
    };
    const opened = request.kind === 'create'
      ? await backend.startSession()
      : request.kind === 'resume'
        ? dependencies.resumeHistorySession
          ? await backend.loadSessionWithReplayCapture(request.providerSessionId).then((loaded) => {
              replay = loaded.replay;
              return loaded;
            })
          : await backend.loadSession(request.providerSessionId)
        : await openFork();
    assertComposerCurrent(dependencies);
    providerSessionId = opened.sessionId;
    if (request.kind === 'resume' && dependencies.resumeHistorySession && replay) {
      try {
        await importAcpReplayHistoryV1({
          session: dependencies.resumeHistorySession,
          provider: dependencies.agentId,
          remoteSessionId: request.providerSessionId,
          replay,
          permissionHandler,
        });
      } catch (error) {
        logger.debug(`[${dependencies.agentId}] Failed to import replay history (non-fatal)`, error);
      }
    }
    if (initialConfiguration) {
      const result = await applyConfigurationControls(
        initialConfiguration,
        null,
        { initial: true, signal: dependencies.signal },
      );
      if (result.status !== 'applied') {
        const failure = 'diagnostic' in result
          ? result.diagnostic
          : diagnostic('acp_initial_configuration_not_applied');
        throw new Error(failure.message ?? failure.code);
      }
      currentConfiguration = mergeConfigurationSnapshot(null, initialConfiguration);
    }
    modelPublicationReady = true;
    if (providerModelPublicationPending || backend.getSessionModelState()) publishProviderModels();
    publish({ kind: 'provider-session-id', providerSessionId: opened.sessionId });
    if (dependencies.signal.aborted) await session.dispose();
    else dependencies.signal.addEventListener('abort', disposeOnAbort, { once: true });
    return session;
  } catch (error) {
    disposed = true;
    await modelBinding.dispose();
    try {
      await backend.dispose();
    } finally {
      releaseLaunch();
    }
    await stream.dispose();
    throw error;
  }
  } catch (error) {
    releaseLaunch();
    throw error;
  }
}

export async function createPublicAcpSession(
  request: AgentSessionOpenRequest,
  options: AgentAcpRuntimeOptions,
  dependencies: PublicAcpComposerDependencies,
): Promise<PublicAcpSessionRuntime> {
  return await createPublicAcpSessionFromAwaitableAdapter(
    request,
    options,
    dependencies,
    Object.freeze({}),
  );
}
