import {
  type AgentExecutionRunConversationRuntimeV1,
  type AgentExecutionRunConversationSendOptionsV1,
  type AgentExecutionRunConversationEventV1,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntimeContextV1,
  AgentRuntimeJsonValueSchema,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeRuntime as ExperimentalAgentSessionRealtimeRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue, PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import { AGENT_DEFINITION } from '../../definition.js';
import { isDeepStrictEqual } from 'node:util';
import type { SessionAuthService } from '@happier-dev/plugin-sdk/sessions';
import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type {
  CodexAppServerEvent,
  CodexAppServerSendResult,
  CodexAppServerSession,
} from './core.js';
import { forkCodexNativeAppServerConversation } from '../../surfaces/sessions/fork/native.js';
import { OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL } from '../../auth/services/quota/rateLimitResetCreditsClient.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';
import { createCodexNativeAppServerClient } from './client.js';
import { CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY } from '../../cli/supportedRuntime.js';
import {
  createCodexAppServerRuntime,
  startCodexAppServerRuntime,
  buildCodexAppServerSafeErrorIdentity,
  type CodexAppServerRuntimeHost,
} from './runtime.js';
import {
  isCodexAppServerRejectedStartModelEntitlementError,
  sanitizeCodexAppServerRuntimeAuthClassification,
} from './turns/failure.js';
import { parseCodexProviderBindingEngineConfigV1 } from '../../providerBinding/runtimeConfig.js';
import { reconcileCodexResumeRolloutPath } from '../../auth/services/state/sharing/reconcileResumeRolloutPath.js';
import type { CodexGoalProjection } from './work/goalProjection.js';
import type { CodexSessionCatalogBinder } from '../controls.js';
import {
  buildCodexAgentRuntimeDescriptorV1,
  readCanonicalCodexAgentRuntimeDescriptorV1,
  readExactCodexProviderSessionId,
} from '../../../protocol/runtimeDescriptorV1.js';
import {
  createCodexSharedAppServer,
  readCodexNativeTransportStartupFailure,
  readCodexSharedAppServerStartupFailure,
  type CodexSharedAppServerStartupFailure,
} from './sharedServer.js';
import { buildCodexExecutionRunBaseEnv } from '../../executionRuns/environment.js';
import { assignInjectedServerKeys, buildCodexAppServerConfigOverrides, listCodexAppServerMcpServerNames } from './config/overrides.js';
import {
  AGENT_STARTUP_FAILURE_PREVIEWS,
  readAgentStartupFailureCode,
  type AgentStartupFailureCode,
} from '@happier-dev/plugin-sdk/agents/runtime';

type CodexSharedAppServer = NonNullable<Awaited<ReturnType<typeof createCodexSharedAppServer>>>;

type NativeSessionEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type NativeExecutionRunConversationEvent = AgentExecutionRunConversationEventV1;

type NativeConversationRuntimeCore = Omit<
  AgentSessionRuntime & Partial<ExperimentalAgentSessionRealtimeRuntime>,
  'watch'
> & Readonly<{
  watch(
    listener: (event: AgentSessionRuntimeEvent | NativeExecutionRunConversationEvent) => void,
  ): { dispose(): void };
}>;

type NativeCurrentSession = NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>;
type NativeMediaSourceRoot = Awaited<ReturnType<
  NativeCurrentSession['media']['registerSourceRoot']
>>;

type CodexAccountUsageService =
  AgentSessionRuntimeContext['session']['services']['accountUsage'];
type CodexAccountUsageSourceContext = Awaited<
  ReturnType<CodexAccountUsageService['resolveSourceContext']>
>;

type CodexAppServerLaunchRequest = AgentSessionOpenRequest | AgentExecutionRunOpenRequest;

function readLaunchEnvironment(request: CodexAppServerLaunchRequest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(buildCodexExecutionRunBaseEnv({
    processEnv: process.env,
    isolationEnv: request.launchEnvironment?.values,
  }) ?? {})) {
    if (typeof value === 'string') values[key] = value;
  }
  const unsetNames = new Set((request.launchEnvironment?.unset ?? []).map((name) => name.toUpperCase()));
  for (const key of Object.keys(values)) {
    if (unsetNames.has(key.toUpperCase())) delete values[key];
  }
  return values;
}

function readPermissionMode(request: CodexAppServerLaunchRequest): string {
  return request.configuration?.permissionIntent.value ?? 'default';
}

function readInitialModelId(request: CodexAppServerLaunchRequest): string | null {
  const providerModelId = request.providerBinding?.model.id.trim();
  if (providerModelId) return providerModelId;
  const modelId = request.configuration?.model.value?.trim();
  return modelId && modelId !== 'default' ? modelId : null;
}

async function applyCodexConfigurationOptions(
  updateConfig: NonNullable<CodexAppServerSession['updateConfig']>,
  options: NonNullable<AgentSessionOpenRequest['configuration']>['options'],
): Promise<string[]> {
  const changed: string[] = [];
  for (const [id, option] of Object.entries(options)) {
    const value = typeof option.value === 'string' ? option.value.trim() : '';
    if (!value) continue;
    await updateConfig({ configOption: { id, value } });
    changed.push(`options.${id}`);
  }
  return changed;
}

function createNativeRuntimeAuthRefresh(params: Readonly<{
  auth: SessionAuthService;
  signal: AbortSignal;
}>): NonNullable<CodexAppServerRuntimeHost['refreshRuntimeAuth']> {
  return async (request) => {
    const refreshed = await params.auth.services.refreshRuntimeAuth(request, { signal: params.signal });
    if (refreshed.status !== 'refreshed') return refreshed;
    const proof = refreshed.result;
    const credentialRevision = proof && typeof proof === 'object' && !Array.isArray(proof)
      && 'credentialRevision' in proof
      && typeof proof.credentialRevision === 'string' ? proof.credentialRevision : null;
    if (!credentialRevision) {
      return { status: 'failed', reason: 'runtime_auth_credential_revision_unavailable' };
    }
    // The daemon returns the exact settled revision's access material. The
    // launch-scoped native home may still belong to a previous selected account.
    const accessToken = proof && typeof proof === 'object' && !Array.isArray(proof)
      && 'accessToken' in proof && typeof proof.accessToken === 'string'
      ? proof.accessToken.trim() : null;
    const providerAccountId = proof && typeof proof === 'object' && !Array.isArray(proof)
      && 'providerAccountId' in proof && typeof proof.providerAccountId === 'string'
      ? proof.providerAccountId.trim() : null;
    params.signal.throwIfAborted();
    if (!accessToken || !providerAccountId) {
      return { status: 'failed', reason: 'runtime_auth_current_access_material_unavailable' };
    }
    return { status: 'refreshed', result: {
      accessToken,
      chatgptAccountId: providerAccountId,
      // The request hint describes the rejected token, not its replacement.
      // Native Codex derives the replacement's plan from its own token claims.
      chatgptPlanType: null,
      credentialRevision,
    } };
  };
}

export function createCodexNativeAppServerRuntimeHost(params: Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  processEnv: Readonly<Record<string, string>>;
  sharedAppServer?: CodexSharedAppServer | null;
  appServerTransport?: 'daemonProxy' | null;
}>): CodexAppServerRuntimeHost {
  const accountUsage: CodexAccountUsageService = {
    resolveSourceContext: async (input, options) =>
      await params.context.session.services.accountUsage.resolveSourceContext(input, options),
    recordSnapshot: async (input, options) =>
      await params.context.session.services.accountUsage.recordSnapshot(input, options),
    adoptProvisionalRecord: async (input, options) =>
      await params.context.session.services.accountUsage.adoptProvisionalRecord(input, options),
  };
  const currentSession = params.context.services.sessions.current;
  const mediaSourceRoots = new Map<string, Promise<NativeMediaSourceRoot>>();
  let mediaDisposed = false;
  const acquireMediaSourceRoot = (
    session: NativeCurrentSession,
    rootPath: string,
  ): Promise<NativeMediaSourceRoot> => {
    const existing = mediaSourceRoots.get(rootPath);
    if (existing) return existing;
    const created = session.media.registerSourceRoot({ rootPath });
    mediaSourceRoots.set(rootPath, created);
    void created.catch(() => {
      if (mediaSourceRoots.get(rootPath) === created) mediaSourceRoots.delete(rootPath);
    });
    return created;
  };
  return {
    baseProcessEnv: params.processEnv,
    ...(params.context.session.services.inputFiles ? { inputFiles: params.context.session.services.inputFiles } : {}),
    ...(params.context.session.services.nativeHome
      ? { nativeHome: params.context.session.services.nativeHome }
      : {}),
    logger: params.context.services.logger,
    ui: params.context.services.interactions,
    ...(params.context.services.sessions.current?.mcp
      ? { mcp: params.context.services.sessions.current.mcp }
      : {}),
    createClient: async (clientRequest) => params.sharedAppServer
      ? await params.sharedAppServer.createClient(clientRequest)
      : await createCodexNativeAppServerClient({
          exec: params.context.services.exec,
          logger: params.context.services.logger,
          nativeLaunch: params.context.session.services.nativeLaunch,
          cwd: clientRequest.cwd,
          processEnv: clientRequest.processEnv,
          configOverrides: clientRequest.configOverrides,
          disableUserMcpServers: clientRequest.disableUserMcpServers,
          toolRestrictionRequired: clientRequest.toolRestrictionRequired,
          toolRestrictionAllowedMcpServerKeys: clientRequest.toolRestrictionAllowedMcpServerKeys,
          signal: params.context.signal,
          ...(params.appServerTransport === 'daemonProxy'
            ? { transport: { kind: 'daemonProxy' as const } }
            : {}),
        }),
    fetchRateLimitResetCredits: async ({ accessToken, accountId }) => {
      const response = await params.context.services.http.request({
        url: OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
          Accept: 'application/json',
        },
        redirect: 'error',
      }, { signal: params.context.signal });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`OpenAI reset-credit fetch failed (${response.status})`);
      }
      return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    },
    accountUsage,
    models: params.context.session.services.models,
    subagents: params.context.session.services.subagents,
    ...(currentSession ? {
      setTitle: async (title) => {
        await currentSession.setDisplayTitle(title, { signal: params.context.signal });
      },
      sendUserMessage: async (message) => {
        const result = await currentSession.send({
          kind: 'userText',
          text: message.text,
          idempotencyKey: message.idempotencyKey,
          toolAnswerDelivery: { toolCallId: message.toolCallId },
        }, { signal: params.context.signal });
        if (result.status !== 'accepted' && result.status !== 'alreadyAccepted') {
          throw new Error(`Codex async question reply was not accepted (${result.status})`);
        }
      },
    } : {}),
    refreshRuntimeAuth: async (request) => {
      const auth = params.context.session.services.auth;
      if (!auth) throw new Error('Codex native runtime authentication is unavailable.');
      return await createNativeRuntimeAuthRefresh({
        auth, signal: params.context.signal,
      })(request);
    },
    ...(currentSession ? { publishGeneratedMedia: async (candidate) => {
      if (mediaDisposed) throw new Error('Codex generated-media publication is disposed.');
      const source = await acquireMediaSourceRoot(currentSession, candidate.source.restrictedRoot);
      if (mediaDisposed) throw new Error('Codex generated-media publication is disposed.');
      await source.publishGenerated({
        localId: candidate.itemId,
        path: candidate.source.path,
        description: 'Generated by Codex',
        toolCallId: candidate.itemId,
      });
    } } : {}),
    dispose: async () => {
      if (mediaDisposed) return;
      mediaDisposed = true;
      const sources = await Promise.allSettled(mediaSourceRoots.values());
      mediaSourceRoots.clear();
      for (const source of sources) {
        if (source.status === 'fulfilled') source.value.dispose();
      }
      await params.sharedAppServer?.dispose();
    },
  };
}

export function createCodexNativeAppServerExecutionRunRuntimeHost(params: Readonly<{
  context: AgentExecutionRunRuntimeContextV1;
  processEnv: Readonly<Record<string, string>>;
  sharedAppServer?: CodexSharedAppServer | null;
}>): CodexAppServerRuntimeHost {
  const auth = params.context.executionRun.services.auth;
  const refreshRuntimeAuth: CodexAppServerRuntimeHost['refreshRuntimeAuth'] = auth
    ? createNativeRuntimeAuthRefresh({
        auth, signal: params.context.signal,
      })
    : undefined;
  return {
    baseProcessEnv: params.processEnv,
    ...(params.context.executionRun.services.nativeHome
      ? { nativeHome: params.context.executionRun.services.nativeHome }
      : {}),
    ...(refreshRuntimeAuth ? { refreshRuntimeAuth } : {}),
    logger: params.context.services.logger,
    ui: params.context.services.interactions,
    createClient: async (clientRequest) => params.sharedAppServer
      ? await params.sharedAppServer.createClient(clientRequest)
      : await createCodexNativeAppServerClient({
          exec: params.context.services.exec,
          logger: params.context.services.logger,
          nativeLaunch: params.context.executionRun.services.nativeLaunch,
          cwd: clientRequest.cwd,
          processEnv: clientRequest.processEnv,
          configOverrides: clientRequest.configOverrides,
          disableUserMcpServers: clientRequest.disableUserMcpServers,
          toolRestrictionRequired: clientRequest.toolRestrictionRequired,
          toolRestrictionAllowedMcpServerKeys: clientRequest.toolRestrictionAllowedMcpServerKeys,
          signal: params.context.signal,
        }),
    dispose: async () => {
      await params.sharedAppServer?.dispose();
    },
  };
}

function diagnostic(
  code: string,
  message: string,
  details?: PluginDiagnosticData['details'],
): PluginDiagnosticData {
  return {
    code,
    severity: 'error',
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function toJsonValue(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : { unavailable: true };
}

function readBoundedRuntimeAuthDiagnosticDetails(
  error: unknown,
): PluginDiagnosticData['details'] | undefined {
  if (!(error instanceof Error)) return undefined;
  const classification = sanitizeCodexAppServerRuntimeAuthClassification(
    (error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification,
  );
  if (!classification) return undefined;
  return toJsonValue({ runtimeAuthClassification: classification });
}

class CodexAppServerStartupError extends Error {
  constructor(readonly code: AgentStartupFailureCode, readonly startupFailure?: CodexSharedAppServerStartupFailure) {
    // Keep the closed code in the message as well: runner loggers may render
    // only Error's name/message/stack, rather than its own data properties.
    super(`${code}: ${AGENT_STARTUP_FAILURE_PREVIEWS[code]}.${startupFailure ? ` ${JSON.stringify(startupFailure)}` : ''}`);
    this.name = 'CodexAppServerStartupError';
  }
}

function createSanitizedNativeStartupError(error: unknown): Error {
  if (error instanceof PluginError && (
    error.code === 'codex_tool_restriction_unsupported_runtime'
    || error.code === 'codex_tool_restriction_unsupported_model'
    || error.code === 'codex_tool_restriction_unsupported_auth'
    || error.code === 'codex_tool_restriction_catalog_unavailable'
  )) {
    // These are closed eligibility reasons authored by this adapter. Do not
    // carry native messages, config, process output or arbitrary error details.
    const message = error.code === 'codex_tool_restriction_unsupported_runtime'
      ? CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY
      : 'Codex cannot enforce the requested native tool policy for this configuration.';
    return new PluginError({ code: error.code, message: `${error.code}: ${message}` });
  }
  const startupCause = error instanceof AggregateError ? error.errors[0] : error;
  const descriptor = startupCause instanceof Error ? Object.getOwnPropertyDescriptor(startupCause, 'code') : undefined;
  const errorCode: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const nativeTransportFailure = readCodexNativeTransportStartupFailure(startupCause);
  const code = readAgentStartupFailureCode(errorCode)
    ?? (error instanceof TypeError ? 'agent_startup_invalid_state'
      : error instanceof Error && error.name === 'JsonRpcApplicationError' && typeof errorCode === 'number'
        ? 'agent_startup_rpc_rejected'
      : nativeTransportFailure
        ? 'agent_startup_transport_failed'
        : 'agent_startup_failed');
  // Shared startup cleanup can aggregate the original failure. Preserve that
  // owner's closed diagnostic, or a closed Node system-error identity, without
  // copying either exception's raw cause, paths, addresses or values.
  const startupFailure = readCodexSharedAppServerStartupFailure(
    startupCause && typeof startupCause === 'object'
      ? (startupCause as Readonly<{ startupFailure?: unknown }>).startupFailure
      : undefined,
  ) ?? nativeTransportFailure;
  const sanitized = new CodexAppServerStartupError(code,
    startupFailure ?? undefined);
  const classification = error instanceof Error
    ? sanitizeCodexAppServerRuntimeAuthClassification(
        (error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification,
      )
    : null;
  if (classification) {
    Object.assign(sanitized, { runtimeAuthClassification: classification });
  }
  if (
    typeof error === 'object'
    && error !== null
    && (error as Readonly<{ happierNativeResumeIdentityMismatch?: unknown }>)
      .happierNativeResumeIdentityMismatch === true
  ) {
    Object.assign(sanitized, { happierNativeResumeIdentityMismatch: true });
  }
  return sanitized;
}

function readTextDelta(delta: unknown): Readonly<{
  text: string;
  channel: 'assistant' | 'reasoning';
}> | null {
  if (typeof delta === 'string') return { text: delta, channel: 'assistant' };
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return null;
  const record = delta as Readonly<Record<string, unknown>>;
  if (typeof record.text !== 'string') return null;
  return {
    text: record.text,
    channel: record.thinking === true ? 'reasoning' : 'assistant',
  };
}

function readCommittedMessage(
  event: Extract<CodexAppServerEvent, { kind: 'transcript-agent-message-committed' }>,
): Readonly<{ text: string; role: 'assistant' | 'reasoning' }> | null {
  if (!event.body || typeof event.body !== 'object' || Array.isArray(event.body)) return null;
  const body = event.body as Readonly<Record<string, unknown>>;
  const text = typeof body.message === 'string'
    ? body.message
    : typeof body.text === 'string'
      ? body.text
      : null;
  if (text === null) return null;
  return {
    text,
    role: body.thinking === true || body.type === 'reasoning' || body.type === 'thinking'
      ? 'reasoning'
      : 'assistant',
  };
}

function mapCodexAppServerEvent(event: CodexAppServerEvent): NativeSessionEventInput | null {
  switch (event.kind) {
    case 'context-compaction':
      {
        const { sessionId: _sessionId, executionRunId: _executionRunId, emittedAtMs: _emittedAtMs, ...compaction } = event;
        return compaction;
      }
    case 'turn-start':
      return {
        kind: 'turn-start',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        startedBy: event.startedBy === 'provider' ? 'provider' : 'host',
      };
    case 'turn-progress':
      return {
        kind: 'turn-progress',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
      };
    case 'turn-agent-id-observed':
      return { kind: 'turn-agent-id-observed', turnId: event.turnId, agentTurnId: event.agentTurnId };
    case 'skill-usage':
      return { kind: event.kind, turnId: event.turnId, skills: event.skills,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}) };
    case 'turn-complete':
      return {
        kind: 'turn-complete',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
      };
    case 'turn-failed':
      return {
        kind: 'turn-failed',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        diagnostic: diagnostic(
          event.issue.code,
          event.issue.sanitizedPreview ?? event.issue.code,
          { v: 1, source: event.issue.source,
            ...(event.runtimeAuthClassification ? { runtimeAuthClassification: toJsonValue(event.runtimeAuthClassification) } : {}) },
        ),
      };
    case 'turn-cancelled':
      return {
        kind: 'turn-cancelled',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        cause: 'providerCancelled',
        ...(event.reason ? { diagnostic: diagnostic('codex_turn_cancelled', event.reason) } : {}),
      };
    case 'message-delta': {
      const delta = readTextDelta(event.delta);
      return delta
        ? { kind: 'message-delta', ...(event.turnId ? { turnId: event.turnId } : {}), ...(event.messageId ? { messageId: event.messageId } : {}), channel: delta.channel, text: delta.text, ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}) }
        : null;
    }
    case 'tool-call':
      return {
        kind: 'tool-call',
        ...(event.turnId ? { turnId: event.turnId } : {}),
        toolCallId: event.toolCallId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
        toolName: event.toolName,
        input: toJsonValue(event.toolInput),
      };
    case 'tool-progress':
      return {
        kind: 'tool-progress',
        ...(event.turnId ? { turnId: event.turnId } : {}),
        toolCallId: event.toolCallId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
        progress: toJsonValue(event.progress),
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        ...(event.turnId ? { turnId: event.turnId } : {}),
        toolCallId: event.toolCallId,
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
        output: toJsonValue(event.output),
        ...(event.isError === true ? { isError: true } : {}),
      };
    case 'session-id-publish': {
      // Codex minted this id; publish its exact bytes.
      const providerSessionId = readExactCodexProviderSessionId(event.publishedSessionId);
      return providerSessionId ? { kind: 'provider-session-id', providerSessionId } : null;
    }
    case 'transcript-agent-message-committed': {
      const message = readCommittedMessage(event);
      return message
        ? {
            kind: 'transcript-message-committed',
            messageId: event.localId,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
            role: message.role,
            text: message.text,
          }
        : null;
    }
    case 'transcript-user-message-committed':
      return {
        kind: 'transcript-message-committed',
        messageId: event.localId,
        role: 'user',
        text: event.text,
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    case 'usage-observed':
      return {
        kind: event.kind,
        observationId: event.observationId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        source: event.source,
        scope: event.scope,
        ...(event.accounting ? { accounting: event.accounting } : {}),
        ...(event.attribution ? { attribution: event.attribution } : {}),
        ...(event.modelId ? { modelId: event.modelId } : {}),
        ...(event.tokens ? { tokens: event.tokens } : {}),
        ...(event.cost ? { cost: event.cost } : {}),
        ...(event.context ? { context: event.context } : {}),
        ...(event.promptCache ? { promptCache: event.promptCache } : {}),
      };
    case 'turn-rollback-boundary-observed':
      return {
        kind: 'turn-rollback-boundary',
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        ...(typeof event.agentRollbackOrdinal === 'number'
          ? { agentRollbackOrdinal: event.agentRollbackOrdinal }
          : {}),
        ...(event.providerCheckpoint !== undefined
          ? { providerCheckpoint: event.providerCheckpoint }
          : {}),
      };
    case 'session-ended':
      return {
        kind: 'runtime-ended',
        cause: 'providerEnded',
        retryable: false,
        ...(event.reason ? { diagnostic: diagnostic('codex_runtime_ended', event.reason) } : {}),
      };
    case 'backend-error':
      return {
        kind: 'runtime-ended',
        cause: 'protocolError',
        retryable: false,
        diagnostic: diagnostic(event.error.code ?? 'codex_backend_error', event.error.message),
      };
    default:
      return null;
  }
}

function toNativeSendFailure(
  status: 'rejected' | 'unavailable' | 'unsupported',
  message?: string,
  refusal?: Pick<CodexAppServerSendResult, 'diagnosticCode' | 'retryable'>,
): Exclude<Awaited<ReturnType<AgentSessionRuntime['send']>>, { status: 'admitted' }> {
  return {
    status,
    retryable: refusal?.retryable ?? status === 'unavailable',
    diagnostic: diagnostic(refusal?.diagnosticCode ?? `codex_send_${status}`, message ?? `Codex input was ${status}.`),
  };
}

export function createCodexNativeAppServerSessionRuntime(
  appServer: CodexAppServerSession,
  sessionId: string,
  realtimeConversation?: AgentSessionRealtimeConversation,
  onDispose?: () => void | Promise<void>,
  initialMcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'],
): AgentSessionRuntime {
  return {
    ...createCodexNativeAppServerConversationRuntime(
      appServer,
      { kind: 'session', sessionId },
      realtimeConversation,
      onDispose,
      initialMcpToolPolicy,
    ) as AgentSessionRuntime,
    runtimeCapabilities: {
      sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
    },
  };
}

export function createCodexNativeAppServerExecutionRunConversationRuntime(
  appServer: CodexAppServerSession,
  executionRunId: string,
  onDispose?: () => void | Promise<void>,
): AgentExecutionRunConversationRuntimeV1 {
  return createCodexNativeAppServerConversationRuntime(
    appServer,
    { kind: 'execution_run', executionRunId },
    undefined,
    onDispose,
  ) as AgentExecutionRunConversationRuntimeV1;
}

function createCodexNativeAppServerConversationRuntime(
  appServer: CodexAppServerSession,
  scope:
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'execution_run'; executionRunId: string }>,
  realtimeConversation?: AgentSessionRealtimeConversation,
  onDispose?: () => void | Promise<void>,
  initialMcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'],
): AgentSessionRuntime | AgentExecutionRunConversationRuntimeV1 {
  const listeners = new Set<(
    event: AgentSessionRuntimeEvent | NativeExecutionRunConversationEvent,
  ) => void>();
  let sequence = 0;
  let disposed = false;
  let bufferedEvents: AgentSessionPreAdmissionBuffer<Readonly<{
    event: NativeSessionEventInput;
    emittedAtMs: number;
  }>> | null = null;
  let bufferedEventFailure: Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }> | null = null;
  const readBufferedEventFailure = () => bufferedEventFailure;
  let pendingProviderIdentity: Readonly<{
    event: Extract<NativeSessionEventInput, { kind: 'provider-session-id' }>;
    emittedAtMs: number;
  }> | null = null;

  const emit = (event: NativeSessionEventInput, emittedAtMs = Date.now()): void => {
    const published = scope.kind === 'session'
      ? Object.freeze({
          ...event,
          sequence: ++sequence,
          sessionId: scope.sessionId,
          emittedAtMs,
        }) as AgentSessionRuntimeEvent
      : Object.freeze({ ...event, emittedAtMs }) as NativeExecutionRunConversationEvent;
    for (const listener of listeners) listener(published);
  };

  const subscription = appServer.events.subscribe((event) => {
    const mapped = mapCodexAppServerEvent(event);
    if (!mapped) return;
    if (mapped.kind === 'provider-session-id' && listeners.size === 0) {
      pendingProviderIdentity = { event: mapped, emittedAtMs: event.emittedAtMs };
      return;
    }
    if (bufferedEvents) {
      const admission = bufferedEvents.admit({ event: mapped, emittedAtMs: event.emittedAtMs });
      if (admission.status !== 'accepted' && bufferedEventFailure === null) {
        bufferedEventFailure = admission;
        bufferedEvents.dispose();
      }
      return;
    }
    emit(mapped, event.emittedAtMs);
  });

  const initialProviderSessionId = readExactCodexProviderSessionId(
    appServer.identity.read().providerSessionId,
  ) ?? undefined;
  if (initialProviderSessionId) {
    pendingProviderIdentity = {
      event: { kind: 'provider-session-id', providerSessionId: initialProviderSessionId },
      emittedAtMs: Date.now(),
    };
  }

  const nativeRuntime: NativeConversationRuntimeCore = {
    ...(realtimeConversation ? { realtimeConversation } : {}),
    ...(appServer.runtimeAuth ? { runtimeAuth: appServer.runtimeAuth } : {}),
    async compact(request) {
      if (disposed) return { status: 'unavailable', retryable: false,
        diagnostic: diagnostic('codex_runtime_disposed', 'Codex runtime is disposed.') };
      return await appServer.compact(request);
    },
    conversationRollback: {
      async rollback(request) {
        return await appServer.rollbackNativeConversation(request);
      },
      async reconcile(request) {
        return await appServer.reconcileNativeConversationRollback(request);
      },
    },
    async send(request, options) {
      if (disposed) {
        return {
          status: 'unavailable',
          retryable: false,
          diagnostic: diagnostic('codex_runtime_disposed', 'Codex runtime is disposed.'),
        };
      }
      const structuredInput = request.input.structuredInput === undefined
        ? null
        : AgentRuntimeJsonValueSchema.safeParse(request.input.structuredInput);
      if (structuredInput && !structuredInput.success) {
        const failure = toNativeSendFailure(
          'rejected',
          'Codex structured input did not match the supported input contract.',
        );
        emit({
          kind: 'input-rejected',
          inputIds: request.inputIds,
          diagnostic: failure.diagnostic,
          retryable: failure.retryable,
        });
        return failure;
      }
      const appServerInput = {
        text: request.input.text,
        ...(structuredInput?.success ? { structuredInput: structuredInput.data } : {}),
      };
      bufferedEvents = createAgentSessionPreAdmissionBuffer();
      bufferedEventFailure = null;
      let result: CodexAppServerSendResult;
      try {
        result = await appServer.send(appServerInput, {
          signal: options?.signal,
          turnId: request.delivery.turnId,
          localInputIds: request.inputIds,
          ...(request.delivery.kind === 'newTurn' ? {} : { deliverAs: request.delivery.kind }),
        });
      } catch (error) {
        const admissionFailure = readBufferedEventFailure();
        const queued = bufferedEvents?.drain() ?? [];
        bufferedEvents?.dispose();
        bufferedEvents = null;
        bufferedEventFailure = null;
        // The app-server emits attempted host lifecycle before turn/start replies.
        // Only those synthetic events may be discarded for a proven rejection.
        const onlyAttemptedLifecycle = queued.every(({ event }) => (
          (event.kind === 'turn-start' && !event.agentTurnId && event.startedBy === 'host')
          || (event.kind === 'turn-failed' && !event.agentTurnId)
          || (event.kind === 'runtime-ended' && event.cause === 'protocolError'
            && event.diagnostic?.code === 'codex_app_server_turn_failed')
        ));
        if (request.delivery.kind === 'newTurn' && admissionFailure === null
          && onlyAttemptedLifecycle && isCodexAppServerRejectedStartModelEntitlementError(error)) {
          const failure = diagnostic(
            'connected_service_model_start_rejected',
            'The connected account cannot start the requested model.',
            readBoundedRuntimeAuthDiagnosticDetails(error),
          );
          emit({ kind: 'input-rejected', inputIds: request.inputIds, retryable: false, diagnostic: failure });
          return { status: 'rejected', retryable: false, diagnostic: failure };
        }
        const failure = diagnostic(
          'codex_send_outcome_unknown',
          'Codex send outcome is unknown.',
          readBoundedRuntimeAuthDiagnosticDetails(error),
        );
        emit({
          kind: 'input-custody-unknown',
          inputIds: request.inputIds,
          issue: failure,
        });
        for (const queuedEvent of queued) emit(queuedEvent.event, queuedEvent.emittedAtMs);
        return {
          status: 'unavailable',
          retryable: true,
          diagnostic: failure,
        };
      }
      const admissionFailure = readBufferedEventFailure();
      if (admissionFailure !== null) {
        bufferedEvents?.dispose();
        bufferedEvents = null;
        bufferedEventFailure = null;
        const failure = diagnostic(
          'codex_send_outcome_unknown',
          `Codex pre-admission event buffer rejected an event (${admissionFailure.status}${admissionFailure.status === 'overflow' ? `:${admissionFailure.reason}` : ''}).`,
        );
        emit({ kind: 'input-custody-unknown', inputIds: request.inputIds, issue: failure });
        return { status: 'unavailable', retryable: true, diagnostic: failure };
      }
      const queued = bufferedEvents?.drain() ?? [];
      bufferedEvents?.dispose();
      bufferedEvents = null;
      if (result.status === 'accepted') {
        emit({
          kind: 'input-accepted',
          inputIds: request.inputIds,
          delivery: request.delivery.kind === 'followUp'
            ? { kind: 'followUp', turnId: request.delivery.turnId }
            : request.delivery,
        });
        for (const queuedEvent of queued) emit(queuedEvent.event, queuedEvent.emittedAtMs);
        return { status: 'admitted' };
      }
      const failure = toNativeSendFailure(result.status, result.diagnostic, result);
      emit({
        kind: 'input-rejected',
        inputIds: request.inputIds,
        diagnostic: failure.diagnostic,
        retryable: failure.retryable,
      });
      for (const queuedEvent of queued) emit(queuedEvent.event, queuedEvent.emittedAtMs);
      return failure;
    },
    async cancel(request) {
      if (!appServer.cancel) return { status: 'unsupported' };
      const result = await appServer.cancel(request.turnId);
      if (result.status === 'cancelled') return { status: 'requested', turnId: request.turnId };
      if (result.status === 'not_running') return { status: 'notRunning' };
      return {
        status: result.status,
        ...(result.diagnostic
          ? { diagnostic: diagnostic(`codex_cancel_${result.status}`, result.diagnostic) }
          : {}),
      };
    },
    async updateConfiguration(request) {
      if (request.mcpToolPolicy !== undefined && !isDeepStrictEqual(request.mcpToolPolicy, initialMcpToolPolicy ?? {})) {
        return { status: 'unsupported', diagnostic: diagnostic('codex_mcp_tool_policy_restart_required',
          'Codex MCP tool filters require an app-server restart.') };
      }
      if (!appServer.updateConfig) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic('codex_configuration_unsupported', 'Codex configuration updates are unavailable.'),
        };
      }
      const changed: string[] = [];
      try {
        const collaborationModeId = request.mode.value?.trim();
        const permissionMode = request.permissionIntent.value;
        const modelId = request.model.value?.trim();
        if (collaborationModeId) {
          await appServer.updateConfig({ collaborationModeId });
          changed.push('mode');
        }
        if (permissionMode !== null || modelId || request.workspaceWrites !== undefined) {
          await appServer.updateConfig({
            ...(permissionMode !== null ? { permissionMode } : {}),
            ...(request.workspaceWrites !== undefined ? { workspaceWrites: request.workspaceWrites } : {}),
            ...(modelId ? { modelId } : {}),
          });
          if (permissionMode !== null) changed.push('permissionIntent');
          if (request.workspaceWrites !== undefined) changed.push('workspaceWrites');
          if (modelId) changed.push('model');
        }
        changed.push(...await applyCodexConfigurationOptions(appServer.updateConfig, request.options));
      } catch (error) {
        if (error && typeof error === 'object'
          && (error as Readonly<{ code?: unknown }>).code === 'role_policy_restart_required') {
          return { status: 'rejected', diagnostic: diagnostic('role_policy_restart_required', 'The active Codex turn cannot change its sandbox.') };
        }
        if (
          error
          && typeof error === 'object'
          && (error as Readonly<{ code?: unknown }>).code === 'codex_collaboration_mode_unavailable'
        ) {
          return {
            status: 'rejected',
            diagnostic: diagnostic(
              'codex_collaboration_mode_unavailable',
              'The selected Codex collaboration mode is unavailable.',
            ),
          };
        }
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'codex_configuration_update_failed',
            'Codex did not apply the requested configuration update.',
          ),
        };
      }
      return { status: 'applied', changed };
    },
    watch(listener: (
      event: AgentSessionRuntimeEvent | NativeExecutionRunConversationEvent,
    ) => void) {
      listeners.add(listener);
      if (pendingProviderIdentity) {
        const pending = pendingProviderIdentity;
        pendingProviderIdentity = null;
        emit(pending.event, pending.emittedAtMs);
      }
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      bufferedEvents?.dispose();
      bufferedEvents = null;
      bufferedEventFailure = null;
      try {
        await onDispose?.();
        await appServer.dispose('session_closed');
      } finally {
        subscription();
        listeners.clear();
      }
    },
  };
  if (scope.kind === 'session') {
    return {
      ...nativeRuntime,
      get skillsDelivered() { return appServer.skillsDelivered; },
      ...(appServer.refreshSkills ? { refreshSkills: appServer.refreshSkills } : {}),
      watch(listener) {
        return nativeRuntime.watch((event) => listener(event as AgentSessionRuntimeEvent));
      },
    } satisfies AgentSessionRuntime & Partial<ExperimentalAgentSessionRealtimeRuntime>;
  }
  return {
    async send(request, options?: AgentExecutionRunConversationSendOptionsV1) {
      if (options?.permissionIntent !== undefined) {
        if (!appServer.updateConfig) {
          return { status: 'unsupported', diagnostic: diagnostic('execution_run_permission_intent_unsupported',
            'Codex cannot apply the admitted input permission policy.') };
        }
        try {
          await appServer.updateConfig({ permissionMode: options.permissionIntent });
        } catch {
          return { status: 'rejected', diagnostic: diagnostic('execution_run_permission_intent_rejected',
            'Codex could not apply the admitted input permission policy.') };
        }
      }
      return await nativeRuntime.send(request, options);
    },
    cancel: nativeRuntime.cancel,
    watch(listener) {
      return nativeRuntime.watch((event) => listener(event as NativeExecutionRunConversationEvent));
    },
    dispose: nativeRuntime.dispose,
  } satisfies AgentExecutionRunConversationRuntimeV1;
}

export async function openCodexNativeAppServerSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
  goalProjection?: CodexGoalProjection,
  bindSessionCatalog?: CodexSessionCatalogBinder,
): Promise<AgentSessionRuntime> {
  const initialProviderBinding = parseCodexProviderBindingEngineConfigV1(
    Object.prototype.hasOwnProperty.call(request, 'providerBinding')
      ? (request as unknown as Readonly<Record<string, unknown>>).providerBinding
      : null,
  );
  const processEnv = readLaunchEnvironment(request);
  const runtimeDescriptor = request.runtimeDescriptorV1
    ? readCanonicalCodexAgentRuntimeDescriptorV1(request.runtimeDescriptorV1)
    : null;
  const appServerTransport = request.kind === 'resume'
    && runtimeDescriptor?.backendMode === 'appServer'
    && runtimeDescriptor.providerSessionId === request.providerSessionId
    && runtimeDescriptor.appServerTransport === 'daemonProxy'
    ? 'daemonProxy' as const
    : null;
  if (appServerTransport === 'daemonProxy' && request.configuration?.unlistedTools === 'deny') {
    throw new PluginError({
      code: 'codex_tool_restriction_unsupported_transport',
      message: 'Codex daemon proxy cannot apply tool confinement to its already-running server.',
    });
  }
  let providerSessionId = request.kind === 'resume' ? request.providerSessionId : null;
  const continuationProviderSessionId = request.kind === 'resume'
    ? request.providerSessionId
    : request.kind === 'fork'
      ? request.source.providerSessionId
      : null;
  if (
    continuationProviderSessionId
    && appServerTransport !== 'daemonProxy'
    && !await reconcileCodexResumeRolloutPath({
      processEnv,
      cwd: request.cwd,
      vendorResumeId: continuationProviderSessionId,
    })
  ) {
    throw new Error('Codex resume index reconciliation failed.');
  }
  if (request.kind === 'fork') {
    const forkClient = await createCodexNativeAppServerClient({
      exec: context.services.exec,
      logger: context.services.logger,
      nativeLaunch: context.session.services.nativeLaunch,
      cwd: request.cwd,
      processEnv,
      signal: context.signal,
      configOverrides: buildCodexAppServerConfigOverrides(request.mcpServers ?? {}, { ...request.configuration, skills: request.skills, mcpToolPolicy: request.mcpToolPolicy }),
      disableUserMcpServers: request.configuration?.unlistedTools === 'deny',
      toolRestrictionRequired: request.configuration?.unlistedTools === 'deny',
      toolRestrictionAllowedMcpServerKeys: [...assignInjectedServerKeys(listCodexAppServerMcpServerNames(request.mcpServers ?? {}, request.configuration)).values()],
      // This Session action owns cancellation. Let a slow-but-live Codex initialize instead of
      // converting the generic startup budget into a false native-fork failure.
      initializeRequestOptions: { signal: context.signal, timeoutMs: null },
    });
    try {
      const forked = await forkCodexNativeAppServerConversation({
        client: forkClient,
        parentCodexSessionId: request.source.providerSessionId,
        signal: context.signal,
      });
      if (!forked) throw new Error('Codex app-server could not fork the requested provider session.');
      providerSessionId = forked.providerSessionId;
    } finally {
      await forkClient.dispose().catch(() => undefined);
    }
  }

  const sharedAppServer = appServerTransport === 'daemonProxy'
    ? null
    : await createCodexSharedAppServer({
        exec: context.services.exec,
        logger: context.services.logger,
        nativeLaunch: context.session.services.nativeLaunch,
        processEnv,
        signal: context.signal,
      });

  const runtime = createCodexAppServerRuntime({
    host: createCodexNativeAppServerRuntimeHost({
      request,
      context,
      processEnv,
      sharedAppServer,
      appServerTransport,
    }),
    directory: request.cwd,
    happierSessionId: request.sessionId,
    initialProviderSessionId: providerSessionId,
    appServerEndpoint: sharedAppServer?.endpoint,
    appServerTransport,
    initialModelId: readInitialModelId(request),
    initialProviderModel: request.providerBinding?.model,
    connectedAccountService: request.connectedAccounts?.find(selection => selection.account.service.pluginId === 'happier.agent.codex'
      && selection.account.service.localId === 'openai-codex')?.account.service,
    initialCollaborationModeId: request.configuration?.mode.value,
    initialWorkspaceWrites: request.configuration?.workspaceWrites,
    initialPermissionMode: readPermissionMode(request),
    toolRestriction: request.configuration,
    ...(initialProviderBinding ? { initialProviderBinding } : {}),
    processEnv,
    ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
    ...(request.mcpToolPolicy ? { mcpToolPolicy: request.mcpToolPolicy } : {}),
    ...(request.skills ? { skills: request.skills } : {}),
    resolveCurrentPolicy: () => resolveCodexTerminalPermissionPolicy(readPermissionMode(request), request.configuration?.workspaceWrites, request.configuration?.unlistedTools),
    ...(goalProjection
      ? {
          goalProjection,
          observeGoal: (() => {
            const goalSource = context.workState.publisher('goals');
            return async (payload: Parameters<CodexGoalProjection['publish']>[0]): Promise<void> => {
              await goalProjection.publish(payload, goalSource);
            };
          })(),
        }
      : {}),
  });
  let startupStage: 'configuration' | 'skills' | 'native_session' = 'configuration';
  try {
    await applyCodexConfigurationOptions(runtime.updateConfig, request.configuration?.options ?? {});
    if (request.skills && appServerTransport !== 'daemonProxy') {
      startupStage = 'skills';
      await runtime.prepareSkillDelivery();
    }
    startupStage = 'native_session';
    await startCodexAppServerRuntime(runtime, {
      ...(providerSessionId ? { resumeId: providerSessionId } : {}),
      preserveRequestedThreadId: Boolean(providerSessionId),
      ...(request.kind === 'resume' && request.strictNativeResumeIdentity === true
        ? { strictNativeResumeIdentity: true }
        : {}),
      ...(request.kind !== 'fork' && request.startupInstructions
        ? { developerInstructions: request.startupInstructions.instructions }
        : {}),
    });
    if (request.kind === 'create') {
      // Persist the zero-turn thread for attachment and later inactive controls.
      await runtime.prepareProviderCliAttach();
    }
  } catch (error) {
    const sanitized = createSanitizedNativeStartupError(error);
    if (sanitized instanceof CodexAppServerStartupError && sanitized.startupFailure) {
      context.services.logger.warn('Codex native startup failed', {
        stage: startupStage, ...buildCodexAppServerSafeErrorIdentity(sanitized), startupFailure: sanitized.startupFailure,
      });
    } else {
      context.services.logger.debug('Codex native startup failed', {
        stage: startupStage, ...buildCodexAppServerSafeErrorIdentity(error),
      });
    }
    await sharedAppServer?.dispose();
    throw sanitized;
  }
  const sessionRuntime = createCodexNativeAppServerSessionRuntime(
    runtime,
    request.sessionId,
    runtime.realtimeConversation,
    bindSessionCatalog?.(request.sessionId, runtime.readCatalog),
    request.mcpToolPolicy,
  );
  return {
    ...sessionRuntime,
    goals: runtime.goals,
    usageLimitRecovery: runtime.usageLimitRecovery,
    get skillsDelivered() { return runtime.skillsDelivered; },
    ...(sharedAppServer
      ? {
          async prepareTerminalPresentation() {
            const liveProviderSessionId = await runtime.prepareProviderCliAttach();
            return {
              kind: 'provider_attach' as const,
              metadata: {
                path: request.cwd,
                runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
                  backendMode: 'appServer',
                  providerSessionId: liveProviderSessionId,
                  appServerEndpoint: sharedAppServer.endpoint,
                }),
              },
            };
          },
        }
      : {}),
    runtimeDescriptorV1: buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      providerSessionId: providerSessionId ?? runtime.identity.read().providerSessionId,
      home: runtimeDescriptor?.home,
      homePath: runtimeDescriptor?.homePath,
      connectedServiceId: runtimeDescriptor?.connectedServiceId,
      connectedServiceProfileId: runtimeDescriptor?.connectedServiceProfileId,
      connectedServiceGroupId: runtimeDescriptor?.connectedServiceGroupId,
    }),
    runtimeCapabilities: {
      ...sessionRuntime.runtimeCapabilities,
      localControl: sharedAppServer
        ? {
            supported: true,
            topology: 'shared',
            attachStrategy: 'provider_attach',
            remoteWritable: true,
          }
        : null,
    },
  };
}

export async function openCodexNativeAppServerExecutionRunConversation(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunConversationRuntimeV1> {
  const initialProviderBinding = parseCodexProviderBindingEngineConfigV1(
    Object.prototype.hasOwnProperty.call(request, 'providerBinding')
      ? (request as unknown as Readonly<Record<string, unknown>>).providerBinding
      : null,
  );
  const processEnv = readLaunchEnvironment(request);
  let providerSessionId = request.kind === 'resume' ? request.checkpointId : null;
  if (request.kind === 'fork') {
    const sourceProviderSessionId = readExactCodexProviderSessionId(request.checkpointId);
    if (!sourceProviderSessionId) {
      throw new Error('Codex detached fork requires an exact provider checkpoint.');
    }
    const forkClient = await createCodexNativeAppServerClient({
      exec: context.services.exec,
      logger: context.services.logger,
      cwd: request.cwd,
      processEnv,
      signal: context.signal,
      configOverrides: buildCodexAppServerConfigOverrides(request.mcpServers ?? {}, { ...request.configuration, skills: request.skills, mcpToolPolicy: request.mcpToolPolicy }),
      disableUserMcpServers: request.configuration?.unlistedTools === 'deny',
      initializeRequestOptions: { signal: context.signal, timeoutMs: null },
      toolRestrictionRequired: request.configuration?.unlistedTools === 'deny',
      toolRestrictionAllowedMcpServerKeys: [...assignInjectedServerKeys(listCodexAppServerMcpServerNames(request.mcpServers ?? {}, request.configuration)).values()],
    });
    try {
      const forked = await forkCodexNativeAppServerConversation({
        client: forkClient,
        parentCodexSessionId: sourceProviderSessionId,
        signal: context.signal,
      });
      if (!forked) throw new Error('Codex app-server could not fork the requested provider checkpoint.');
      providerSessionId = forked.providerSessionId;
    } finally {
      await forkClient.dispose().catch(() => undefined);
    }
  }

  const sharedAppServer = await createCodexSharedAppServer({
    nativeLaunch: context.executionRun.services.nativeLaunch,
    exec: context.services.exec,
    logger: context.services.logger,
    processEnv,
    signal: context.signal,
  });
  const runtime = createCodexAppServerRuntime({
    host: createCodexNativeAppServerExecutionRunRuntimeHost({ context, processEnv, sharedAppServer }),
    directory: request.cwd,
    executionRunId: request.runId,
    initialProviderSessionId: providerSessionId,
    appServerEndpoint: sharedAppServer?.endpoint,
    initialModelId: readInitialModelId(request),
    initialProviderModel: request.providerBinding?.model,
    initialCollaborationModeId: request.configuration?.mode.value,
    initialWorkspaceWrites: request.configuration?.workspaceWrites,
    initialPermissionMode: readPermissionMode(request),
    toolRestriction: request.configuration,
    ...(initialProviderBinding ? { initialProviderBinding } : {}),
    processEnv,
    ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
    ...(request.mcpToolPolicy ? { mcpToolPolicy: request.mcpToolPolicy } : {}),
    ...(request.skills ? { skills: request.skills } : {}),
    resolveCurrentPolicy: () => resolveCodexTerminalPermissionPolicy(readPermissionMode(request), request.configuration?.workspaceWrites, request.configuration?.unlistedTools),
  });
  let startupStage: 'configuration' | 'skills' | 'native_session' = 'configuration';
  try {
    await applyCodexConfigurationOptions(runtime.updateConfig, request.configuration?.options ?? {});
    if (request.skills) {
      startupStage = 'skills';
      await runtime.prepareSkillDelivery();
    }
    if (providerSessionId) {
      startupStage = 'native_session';
      await startCodexAppServerRuntime(runtime, {
        resumeId: providerSessionId,
        preserveRequestedThreadId: true,
      });
    }
  } catch (error) {
    const sanitized = createSanitizedNativeStartupError(error);
    if (sanitized instanceof CodexAppServerStartupError && sanitized.startupFailure) {
      context.services.logger.warn('Codex native startup failed', {
        stage: startupStage, ...buildCodexAppServerSafeErrorIdentity(sanitized), startupFailure: sanitized.startupFailure,
      });
    } else {
      context.services.logger.debug('Codex native startup failed', {
        stage: startupStage, ...buildCodexAppServerSafeErrorIdentity(error),
      });
    }
    await sharedAppServer?.dispose();
    throw sanitized;
  }
  return createCodexNativeAppServerExecutionRunConversationRuntime(runtime, request.runId);
}
