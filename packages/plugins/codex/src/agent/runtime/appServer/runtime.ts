import { createHash, randomUUID } from 'node:crypto';
import { createCodexCompactionOperation, type CodexCompactionOperation } from './compaction.js';
import { resolveCodexPromptCacheTtlMs } from './promptCache.js';
import type {
  AgentSessionConversationRollbackRequest,
  AgentSessionConversationRollbackResult,
  AgentSessionConversationRollbackReconciliationResult,
  AgentSessionRuntimeAuthApplyRequest,
  AgentSessionRuntimeAuthApplyResult,
  AgentSessionRuntimeAuthControl,
  AgentSessionRuntimeAuthIdentityRequest,
  AgentSessionRuntimeAuthIdentityResult,
  AgentSessionRuntimeContext,
  AgentSessionConfigurationSnapshot,
  AgentSessionOpenRequest,
  AgentSessionSkillDelivery,
  AgentSessionRuntime,
  AgentSessionModelsSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionAuthService } from '@happier-dev/plugin-sdk/sessions';
import { readProviderReasoningEffortOption } from '@happier-dev/plugin-sdk/providers';
import {
  AgentRuntimeJsonValueSchema,
  canPublishSessionResumeIdentity,
  buildAgentAccountUsageRecordId,
  resolvePromptCacheLastUseAtMs,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { isChangeTitleToolNameAlias, readPendingLocalId } from '@happier-dev/plugin-sdk/sessions';
import type {
  AgentSessionRealtimeConversation,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type {
  CodexAppServerCancelResult,
  CodexAppServerEvent,
  CodexAppServerEventInput,
  CodexAppServerInput,
  CodexAppServerRuntimeIssue,
  CodexAppServerSendOptions,
  CodexAppServerSendResult,
  CodexAppServerSession,
} from './core.js';

import {
  applyCodexConnectedServiceAuthGeneration,
  applyCodexExternalAuthTokens,
  type CodexConnectedServiceRefreshSelection,
} from '../../auth/services/runtime/auth/application.js';
import {
  normalizeCodexConnectedServiceAuthGenerationRequest,
  resolveCodexAppliedGeneration,
  resolveCodexAppliedGroupId,
  resolveCodexAppliedProfileId,
  resolveCodexConnectedServiceRefreshSelectionFromEnv,
  type CodexConnectedServiceAuthGenerationRequest,
} from '../../auth/services/runtime/auth/generationRequest.js';
import {
  readCodexActiveProviderAccount,
  readCodexAuthStoreProviderAccountIdFromJson,
  type CodexActiveProviderAccount,
} from '../../auth/services/runtime/auth/accountId.js';
import { readCodexAuthTokensFromNativeHome } from '../../cli/auth/environment.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../auth/services/quota/runtimeRateLimits.js';
import { readCodexSessionCatalog, type CodexSessionCatalogReader } from './catalog/index.js';
import { createCodexGoalControl, createCodexUsageLimitRecoveryControl } from '../controls.js';
import { createCodexGoalProjection, readCodexGoalPayload, type CodexGoalProjection } from './work/goalProjection.js';
import { CODEX_ACCOUNT_USAGE_PROVIDER_ID, resolveCodexUsageSubjectRef } from '../../auth/services/usage/identity.js';
import {
  mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot,
} from '../../auth/services/usage/snapshot.js';
import {
  buildCodexAgentRuntimeDescriptorV1,
  readExactCodexProviderSessionId,
} from '../../../protocol/runtimeDescriptorV1.js';
import {
  assertCodexToolRestrictionModelSupported,
  isCodexAppServerOversizedJsonFrameError,
  resolveCodexHome,
  type CodexAppServerRequestOptions,
  type DisposableCodexAppServerClient,
} from './client.js';
import {
  isCodexAppServerDefinitiveMethodNotFoundError,
  isCodexAppServerApplicationRejectionForMethod,
  isCodexAppServerInvalidParamsError,
  isCodexAppServerNoActiveTurnToInterruptError,
} from './compatibility.js';
import {
  readCodexAppServerRealtimeStartTimeoutMs,
  readCodexAppServerResumeRecoveryTimeoutMs,
  readCodexAppServerRpcTimeoutMs,
} from './client/timeout.js';
import { assignInjectedServerKeys, buildCodexAppServerConfigOverrides, listCodexAppServerMcpServerNames } from './config/overrides.js';
import {
  CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID,
  CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID,
  normalizeCodexAppServerConfigOptionId,
} from './state/configOptionIds.js';
import {
  buildCodexAppServerLegacyPermissionParams,
  buildCodexAppServerPermissionParams,
  shouldRetryWithoutCodexAppServerPermissionProfile,
  type CodexAppServerPermissionSupport,
  type CodexAppServerPermissionTarget,
} from './permissionProfile.js';
import {
  buildCodexAppServerTurnInput,
  CodexBrowserImageUnavailableError,
  resolveCodexBrowserImageStructuredInput,
  type CodexAppServerTurnInputItem,
} from './turnInput.js';
import {
  buildCodexLiveAccountRuntimeIdentity,
  computeCodexAccessTokenFingerprint,
  resolveCodexInitialConnectedServiceRuntimeIdentity,
  type CodexConnectedServiceRuntimeIdentity,
} from './connectedServiceRuntimeIdentity.js';
import {
  createCodexAppServerTurnFailure,
  readCodexAppServerTurnFailureDiagnostic,
  sanitizeCodexAppServerRuntimeAuthClassification,
  isCodexAppServerRejectedStartModelEntitlementError,
  isCodexAppServerContextWindowExhaustedError,
  isCodexAppServerWorkspaceRoutingUnauthorizedError,
} from './turns/failure.js';
import { createCodexAppServerAssistantReasoningProjector } from './projection/assistantReasoning.js';
import {
  hasCodexAppServerCollaborationMode,
  readCodexAppServerSessionControls,
  resolveCodexAppServerCollaborationModeSelection,
} from './state/controls.js';
import { createCodexNativeChildObserver, type NativeChildProjectionContext } from './nativeChildren.js';
import { createCodexAppServerToolEventProjector } from './projection/toolEvents.js';
import {
  extractCodexGeneratedMediaCandidate,
  type CodexGeneratedMediaCandidate,
} from './media/generatedMedia.js';
import {
  buildThreadConfigOverrideParams,
  buildThreadServiceTierParams,
  readNormalizedProviderEventItemType,
  readProviderEventItemId,
  readProviderEventItemRecord,
  readProviderEventText,
  readProviderUserMessageText,
  readCodexTerminalOutcome,
  readModelId,
  readProviderEventTurnId,
  readServiceTier,
  readThreadId,
  readTurnId,
  trimStringValue,
} from './wire/fields.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';
import { handleTokenUsageNotification, type CodexTokenUsageRuntimeObservation } from '../../usage/handleTokenUsageNotification.js';
import { buildCodexAppServerTokenCountObservationInput } from '../../usage/tokenCountMessage.js';
import { isCodexRequestUsageIdentityContradicted, resolveCodexRequestUsageAttribution } from './requestUsageAttribution.js';
import type { CodexProviderBindingEngineConfigV1 } from '../../providerBinding/runtimeConfig.js';
import { createCodexAppServerRealtimeConversation } from './realtime.js';
import { registerCodexAppServerInteractionHandlers } from './interactions.js';

export type CodexAppServerPolicy = Readonly<{
  approvalPolicy?: unknown;
  approvalsReviewer?: string;
  sandboxPolicy?: unknown;
  sandbox?: unknown;
}>;

function stringifyPolicyField(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

function serializeCodexAppServerPolicy(policy: CodexAppServerPolicy | null): string | null {
  if (!policy) return null;
  return [
    stringifyPolicyField(policy.approvalPolicy),
    stringifyPolicyField(policy.approvalsReviewer),
    stringifyPolicyField(policy.sandbox),
    stringifyPolicyField(policy.sandboxPolicy),
  ].join('\u0000');
}

type CodexAppServerMcpServerConfig = Readonly<{
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

export type CodexAppServerStartOrLoadOptions = Readonly<{
  resumeId?: string | null;
  existingSessionId?: string | null;
  importHistory?: boolean;
  /** An exact machine-local native return requires the provider's same id. */
  strictNativeResumeIdentity?: boolean;
  preserveRequestedThreadId?: boolean;
  developerInstructions?: string;
}>;

/**
 * The app-server explicitly named a different native thread for a strict
 * native return. The host uses this provider-owned fact to retire only the
 * matching machine-local return record; ordinary transport errors are not an
 * identity decision.
 */
export class CodexAppServerResumeIdentityMismatchError extends Error {
  readonly code = 'codex_app_server_resume_identity_mismatch';
  readonly happierNativeResumeIdentityMismatch = true;

  constructor(
    readonly requestedThreadId: string,
    readonly observedThreadId: string,
  ) {
    super('Codex resumed a different provider thread than requested.');
    this.name = 'CodexAppServerResumeIdentityMismatchError';
  }
}

type CodexAppServerStartSession = (
  options?: CodexAppServerStartOrLoadOptions,
) => Promise<string>;

const codexAppServerRuntimeStarters = new WeakMap<object, CodexAppServerStartSession>();
const codexAppServerRuntimeCompletionWaiters = new WeakMap<object, () => Promise<void>>();

export type CodexAppServerRuntime = CodexAppServerSession & Readonly<{
  updateConfig: NonNullable<CodexAppServerSession['updateConfig']>;
  realtimeConversation: AgentSessionRealtimeConversation;
  prepareProviderCliAttach(): Promise<string>;
  prepareSkillDelivery(): Promise<void>;
  readCatalog: CodexSessionCatalogReader;
  goals: NonNullable<AgentSessionRuntime['goals']>;
  usageLimitRecovery: NonNullable<AgentSessionRuntime['usageLimitRecovery']>;
  refreshSkills: NonNullable<AgentSessionRuntime['refreshSkills']>;
  supportsInFlightSteer(): boolean;
  isTurnInFlight(): boolean;
  canSteerPrompt(): boolean;
  steerPrompt(prompt: string, options?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }>): Promise<void>;
  runtimeAuth: AgentSessionRuntimeAuthControl;
  rollbackNativeConversation(
    request: AgentSessionConversationRollbackRequest,
  ): Promise<AgentSessionConversationRollbackResult>;
  reconcileNativeConversationRollback(
    request: AgentSessionConversationRollbackRequest,
  ): Promise<AgentSessionConversationRollbackReconciliationResult>;
  probeTurnLiveness(): Readonly<{
    active: boolean;
    lastActivityAtMs: number | null;
    diagnostics: Readonly<Record<string, unknown>>;
  }>;
}>;

type CodexAppServerAccountUsageService =
  AgentSessionRuntimeContext['session']['services']['accountUsage'];

type PendingTurn = {
  compaction?: CodexCompactionOperation;
  promptCache?: Parameters<typeof resolvePromptCacheLastUseAtMs>[0];
  threadId: string;
  sessionTurnId: string;
  agentTurnId: string | null;
  agentTurnIdObservation: Readonly<{
    promise: Promise<string | null>;
    settle: (agentTurnId: string | null) => void;
  }>;
  providerStartAcknowledged: boolean;
  nativePermissionPolicyKey: string | null;
  deferredTerminalNotification: Readonly<{
    method: 'turn/completed' | 'turn/interrupted';
    params: unknown;
  }> | null;
  providerPrompt: PendingProviderPrompt | null;
  startUserMessageSeq: number | null;
  userMessageSeqs: number[];
  reportedSkillNames?: Set<string>;
  interruptWhenProviderTurnIdArrives: boolean;
  providerOperationIdentity: CodexConnectedServiceRuntimeIdentity | null;
  providerAccountScope: CodexActiveProviderAccount['accountScope'];
  failureSettling?: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingProviderAcceptance = {
  promise: Promise<void>;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingProviderPrompt = Readonly<{
  text: string;
  localInputIds: readonly string[];
  hostTurnId: string | null;
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
  providerAcceptance: PendingProviderAcceptance | null;
}>;

type BufferedTranscriptSegment = {
  kind: 'assistant' | 'reasoning';
  text: string;
  sidechainId: string | null;
  needsCommittedReconciliation: boolean;
};

type CodexAppServerRuntimeTarget =
  | Readonly<{ happierSessionId: string; executionRunId?: never }>
  | Readonly<{ happierSessionId?: never; executionRunId: string }>;

type CodexAppServerRuntimeParams = CodexAppServerRuntimeTarget & Readonly<{
  host: CodexAppServerRuntimeHost;
  directory: string;
  initialProviderSessionId?: string | null;
  appServerEndpoint?: string | null;
  appServerTransport?: 'daemonProxy' | null;
  initialModelId?: string | null;
  initialCollaborationModeId?: string | null;
  initialWorkspaceWrites?: 'allow' | 'deny';
  initialPermissionMode?: string;
  initialProviderBinding?: CodexProviderBindingEngineConfigV1 | null;
  initialProviderModel?: NonNullable<AgentSessionOpenRequest['providerBinding']>['model'];
  connectedAccountService?: Readonly<{ pluginId: string; localId: string }>;
  processEnv?: Readonly<Record<string, string | undefined>>;
  mcpServers?: unknown;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  skills?: AgentSessionSkillDelivery;
  toolRestriction?: Pick<AgentSessionConfigurationSnapshot, 'allowedTools' | 'unlistedTools'>;
  resolveCurrentPolicy?: () => CodexAppServerPolicy | null;
  observeGoal?: (payload: Readonly<{ kind: 'present'; goal: Readonly<Record<string, unknown>> }> | Readonly<{ kind: 'absent' }>) => void | Promise<void>;
  goalProjection?: CodexGoalProjection;
}>;

export type CodexAppServerRuntimeHost = Readonly<{
  baseProcessEnv: Readonly<Record<string, string | undefined>>;
  models?: AgentSessionRuntimeContext['session']['services']['models'];
  inputFiles?: AgentSessionRuntimeContext['session']['services']['inputFiles'];
  nativeHome?: NonNullable<AgentSessionRuntimeContext['session']['services']['nativeHome']>;
  logger: Readonly<{
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  }>;
  createClient(params: Readonly<{
    cwd: string;
    processEnv: Readonly<Record<string, string | undefined>>;
    configOverrides: readonly string[];
    disableUserMcpServers: boolean;
    toolRestrictionRequired?: boolean;
    toolRestrictionAllowedMcpServerKeys?: readonly string[];
  }>): Promise<DisposableCodexAppServerClient>;
  fetchRateLimitResetCredits?(params: Readonly<{
    accessToken: string;
    accountId: string | null;
  }>): Promise<unknown>;
  accountUsage?: CodexAppServerAccountUsageService;
  subagents?: AgentSessionRuntimeContext['session']['services']['subagents'];
  ui?: Pick<AgentSessionRuntimeContext['services']['interactions'], 'requestApproval' | 'askQuestions'>;
  sendUserMessage?(request: Readonly<{ idempotencyKey: string; text: string; toolCallId: string }>): Promise<void>;
  mcp?: Pick<
    NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>['mcp'],
    'elicit'
  >;
  setTitle?(title: string): Promise<void>;
  refreshRuntimeAuth?: SessionAuthService['services']['refreshRuntimeAuth'];
  publishGeneratedMedia?(candidate: CodexGeneratedMediaCandidate): Promise<void>;
  dispose?(): Promise<void>;
}>;

const CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS_ENV_KEY = 'HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS';
const DEFAULT_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS = 25;
const MAX_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS = 5_000;
const CODEX_APP_SERVER_TURN_FAILURE_CODE = 'codex_app_server_turn_failed';
const CODEX_APP_SERVER_TURN_FAILURE_PREVIEW = 'Codex app-server turn failed.';
const CODEX_APP_SERVER_WORKSPACE_ROUTING_AUTH_PREVIEW = 'Codex authentication failed (HTTP 401).';
const CODEX_APP_SERVER_WORKSPACE_ROUTING_ERROR_SUMMARY = 'Codex workspace routing unauthorized (HTTP 401)';
const CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_WINDOW_MS = 1_000;
const CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_INTERVAL_MS = 50;
const CODEX_APP_SERVER_STATE_RUNTIME_RETRY_INITIAL_DELAY_MS = 250;
const CODEX_APP_SERVER_STATE_RUNTIME_RETRY_MAX_DELAY_MS = 10_000;

function isCodexAppServerStateRuntimeInitializationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('Codex app-server exited before completing the request')
    && error.message.includes('failed to initialize sqlite state runtime');
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonRecord(value: unknown): Readonly<Record<string, JsonValue>> | null {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success && isJsonRecord(parsed.data)
    ? parsed.data
    : null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPromiseSettlementWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function requestCodexTurnInterruptWithStartupRetry(params: Readonly<{
  client: DisposableCodexAppServerClient;
  threadId: string;
  turnId: string;
  waitForProviderTerminal?: (waitKind: 'startup_gap' | 'ambiguous_request') => Promise<boolean>;
}>): Promise<'requested' | 'providerTerminal'> {
  const startedAtMs = Date.now();
  for (;;) {
    try {
      await params.client.request('turn/interrupt', {
        threadId: params.threadId,
        turnId: params.turnId,
      });
      return 'requested';
    } catch (error) {
      const startupGap = isCodexAppServerNoActiveTurnToInterruptError(error);
      const providerTerminalObserved = params.waitForProviderTerminal
        ? await params.waitForProviderTerminal(startupGap ? 'startup_gap' : 'ambiguous_request')
        : false;
      if (providerTerminalObserved) return 'providerTerminal';
      if (!startupGap) throw error;
      if (!params.waitForProviderTerminal) {
        await delay(CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_INTERVAL_MS);
      }
      if (Date.now() - startedAtMs >= CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_WINDOW_MS) {
        throw error;
      }
    }
  }
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = readRecord(value);
  if (!record) return {};
  const output: Record<string, string> = {};
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') output[key] = child;
  }
  return output;
}

function readHappierTitleToolTitle(input: unknown): string | null {
  return trimStringValue(readRecord(input)?.title);
}

function readMcpContentTextPayloads(record: Readonly<Record<string, unknown>>): unknown[] {
  const content = Array.isArray(record.content) ? record.content : [];
  const parsed: unknown[] = [];
  for (const entry of content) {
    const entryRecord = readRecord(entry);
    const text = entryRecord ? trimStringValue(entryRecord.text) : null;
    if (!text) continue;
    try {
      parsed.push(JSON.parse(text));
    } catch {
      // Ignore non-JSON MCP text payloads.
    }
  }
  return parsed;
}

function readJsonPayloadCandidatesFromString(value: string): unknown[] {
  const candidates = [value.trim()];
  const outputMatch = value.match(/(?:^|\r?\n)Output:\r?\n([\s\S]*)$/);
  const outputText = outputMatch?.[1]?.trim();
  if (outputText) candidates.push(outputText);

  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Ignore non-JSON tool output framing.
    }
  }
  return parsed;
}

function didHappierTitleToolSucceed(output: unknown, depth = 0): boolean {
  if (depth > 2) return false;
  if (typeof output === 'string') {
    return readJsonPayloadCandidatesFromString(output).some((payload) => didHappierTitleToolSucceed(payload, depth + 1));
  }
  if (Array.isArray(output)) {
    return output.some((entry) => {
      const entryRecord = readRecord(entry);
      const text = entryRecord ? trimStringValue(entryRecord.text) : null;
      if (text) {
        return readJsonPayloadCandidatesFromString(text).some((payload) => didHappierTitleToolSucceed(payload, depth + 1));
      }
      return didHappierTitleToolSucceed(entry, depth + 1);
    });
  }
  const record = readRecord(output);
  if (!record) return false;
  if (record.isError === true) return false;
  if (record.success === false || record.ok === false) return false;
  if (record.success === true || record.ok === true) return true;
  if ('Err' in record) return false;
  if ('Ok' in record) return didHappierTitleToolSucceed(record.Ok, depth + 1);
  return readMcpContentTextPayloads(record).some((payload) => didHappierTitleToolSucceed(payload, depth + 1));
}

function readCodexAppServerTurnCompletionSettleMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = Number.parseInt(String(env[CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS_ENV_KEY] ?? ''), 10);
  if (!Number.isFinite(raw)) return DEFAULT_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS;
  return Math.max(0, Math.min(MAX_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS, Math.trunc(raw)));
}

function readRuntimeInputText(input: CodexAppServerInput): string | null {
  return trimStringValue(input.text);
}

function createCodexAppServerTurnId(): string {
  return `codex-turn-${randomUUID()}`;
}

function readRuntimeTurnId(options: CodexAppServerSendOptions | undefined): string | null {
  return trimStringValue(options?.turnId);
}

function readRuntimeUserMessageSeq(options: CodexAppServerSendOptions | undefined): number | null {
  return typeof options?.userMessageSeq === 'number' && Number.isFinite(options.userMessageSeq)
    ? Math.trunc(options.userMessageSeq)
    : null;
}

function readRuntimeLocalInputIds(options: CodexAppServerSendOptions | undefined): string[] {
  const localIds: string[] = [];
  const append = (value: unknown) => {
    const localId = readPendingLocalId(value);
    if (localId === null || localIds.includes(localId)) return;
    localIds.push(localId);
  };
  append(options?.localInputId);
  for (const localId of options?.localInputIds ?? []) {
    append(localId);
  }
  return localIds;
}

function readRuntimeUserMessageSeqs(options: CodexAppServerSendOptions | undefined): number[] {
  const seqs: number[] = [];
  const append = (value: unknown) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return;
    if (seqs.includes(value as number)) return;
    seqs.push(value as number);
  };
  append(options?.userMessageSeq);
  for (const seq of options?.userMessageSeqs ?? []) {
    append(seq);
  }
  return seqs;
}

function acceptedSendResult(): CodexAppServerSendResult {
  return { status: 'accepted' };
}

function cancelledResult(status: CodexAppServerCancelResult['status']): CodexAppServerCancelResult {
  return { status };
}

function appendRollbackUserMessageSeq(turn: PendingTurn, seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0 || turn.userMessageSeqs.includes(seq)) return;
  turn.userMessageSeqs.push(seq);
}

type CodexProviderAccountUsageSourceContext = Awaited<
  ReturnType<CodexAppServerAccountUsageService['resolveSourceContext']>
>;

type RecordProviderAccountUsageSnapshotOptions = Readonly<{
  operationIdentity: CodexConnectedServiceRuntimeIdentity | null;
  includeLiveAccountIdentity?: boolean;
  policyDisposition?: 'evidence_only';
}>;

function readCodexChatGptAuthTokensPlanType(value: unknown): string | null {
  const record = readRecord(value);
  return trimStringValue(record?.chatgptPlanType)
    ?? trimStringValue(record?.planType)
    ?? trimStringValue(record?.plan_type);
}

function readCodexChatGptAuthTokensRefreshResult(value: unknown): Readonly<{
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
  credentialRevision: string;
}> | null {
  const record = readRecord(value);
  const result = readRecord(record?.result) ?? record;
  const accessToken = trimStringValue(result?.accessToken);
  const chatgptAccountId = trimStringValue(result?.chatgptAccountId);
  const credentialRevision = trimStringValue(result?.credentialRevision);
  if (!accessToken || !chatgptAccountId || !credentialRevision) return null;
  const chatgptPlanType = trimStringValue(result?.chatgptPlanType);
  return {
    accessToken,
    chatgptAccountId,
    credentialRevision,
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
  };
}

function isCodexChatGptAuthTokensRefreshPending(value: unknown, refreshAttemptId: string): boolean {
  const record = readRecord(value);
  return record?.status === 'pending' && record.refreshAttemptId === refreshAttemptId;
}

function buildCodexProviderAccountUsageProvisionalDiscriminator(input: Readonly<{
  sourceContext: CodexProviderAccountUsageSourceContext;
  happierSessionId: string;
  codexHome: string;
}>): string {
  if (input.sourceContext?.bindingKind === 'group_member' && input.sourceContext.groupId) {
    return `connected-service-group:${input.sourceContext.serviceId}:${input.sourceContext.groupId}:${input.sourceContext.profileId}`;
  }
  if (input.sourceContext?.bindingKind === 'profile') {
    return `connected-service-profile:${input.sourceContext.serviceId}:${input.sourceContext.profileId}`;
  }
  return `${input.happierSessionId}:${input.codexHome}`;
}

function isCodexRuntimeAuthQuotaFailure(error: Error): boolean {
  const classification = readRecord((error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification);
  const kind = trimStringValue(classification?.kind);
  return kind === 'usage_limit' || kind === 'rate_limit';
}

function resolveCodexRuntimeIssueSource(error: Error): CodexAppServerRuntimeIssue['source'] {
  const classification = readRecord((error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification);
  const kind = trimStringValue(classification?.kind);
  switch (kind) {
    case 'usage_limit':
    case 'rate_limit':
      return 'usage_limit';
    case 'auth_expired':
    case 'account_changed':
    case 'refresh_failed':
      return 'auth_error';
    case 'temporary_throttle':
    case 'permission_denied':
      return 'agent_status_error';
    default:
      return 'agent_session_error';
  }
}

function buildCodexAppServerBackgroundCompletionFailureDiagnostics(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const classification = readRecord((error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification);
  const runtimeAuthKind = trimStringValue(classification?.kind);
  const runtimeAuthSource = trimStringValue(classification?.source);
  const runtimeAuthLimitCategory = trimStringValue(classification?.limitCategory);
  const runtimeAuthRetryAfterMs = typeof classification?.retryAfterMs === 'number'
    && Number.isFinite(classification.retryAfterMs)
    ? Math.trunc(classification.retryAfterMs)
    : null;
  const runtimeAuthResetsAtMs = typeof classification?.resetsAtMs === 'number'
    && Number.isFinite(classification.resetsAtMs)
    ? Math.trunc(classification.resetsAtMs)
    : null;
  return {
    ...buildCodexAppServerSafeErrorIdentity(error),
    runtimeIssueSource: resolveCodexRuntimeIssueSource(error),
    ...(runtimeAuthKind ? { runtimeAuthKind } : {}),
    ...(runtimeAuthSource ? { runtimeAuthSource } : {}),
    ...(runtimeAuthLimitCategory ? { runtimeAuthLimitCategory } : {}),
    ...(runtimeAuthRetryAfterMs === null ? {} : { runtimeAuthRetryAfterMs }),
    ...(runtimeAuthResetsAtMs === null ? {} : { runtimeAuthResetsAtMs }),
  };
}

export function buildCodexAppServerSafeErrorIdentity(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const safeName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
    ? error.name
    : 'Error';
  const errorRecord = readRecord(error);
  const rawCode = trimStringValue(errorRecord?.code);
  const safeCode = rawCode && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(rawCode)
    ? rawCode
    : null;
  const safeReason = safeCode === 'codex_refresh_free_auth_unsupported'
    && (errorRecord?.reason === 'refresh_bridge_unavailable'
      || errorRecord?.reason === 'provider_account_identity_unavailable'
      || errorRecord?.reason === 'experimental_api_unavailable'
      || errorRecord?.reason === 'workspace_incompatible'
      || errorRecord?.reason === 'credential_family_mismatch'
      || errorRecord?.reason === 'live_hot_auth_failed')
    ? errorRecord.reason
    : null;
  return {
    errorName: safeName,
    ...(safeCode ? { errorCode: safeCode } : {}),
    ...(safeReason ? { errorReason: safeReason } : {}),
  };
}

function buildCodexAppServerTurnFailureIssue(
  error: Error,
  activeTurn: PendingTurn,
): CodexAppServerRuntimeIssue {
  const modelUnavailable = readCodexAppServerTurnFailureDiagnostic(error).providerErrorCode === 'model_not_found';
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: modelUnavailable ? 'provider_model_not_found'
      : isCodexAppServerContextWindowExhaustedError(error, { structuredOnly: true })
      ? 'agent_context_window_exceeded'
      : CODEX_APP_SERVER_TURN_FAILURE_CODE,
    source: resolveCodexRuntimeIssueSource(error),
    occurredAt: Date.now(),
    agentId: 'codex',
    ...(activeTurn.agentTurnId ? { agentTurnId: activeTurn.agentTurnId } : {}),
    sanitizedPreview: modelUnavailable ? 'The selected model is unavailable. Choose another model.'
      : isCodexAppServerWorkspaceRoutingUnauthorizedError(error)
      ? CODEX_APP_SERVER_WORKSPACE_ROUTING_AUTH_PREVIEW
      : CODEX_APP_SERVER_TURN_FAILURE_PREVIEW,
  };
}

function normalizeMcpServers(value: unknown): Readonly<Record<string, CodexAppServerMcpServerConfig>> {
  const record = readRecord(value);
  if (!record) return {};
  const output: Record<string, CodexAppServerMcpServerConfig> = {};
  for (const [name, rawConfig] of Object.entries(record)) {
    const config = readRecord(rawConfig);
    const command = trimStringValue(config?.command);
    if (!command) continue;
    output[name] = {
      command,
      args: Array.isArray(config?.args)
        ? config.args.filter((arg): arg is string => typeof arg === 'string')
        : [],
      env: readStringRecord(config?.env),
      ...(Array.isArray(config?.enabledTools)
        ? { enabledTools: config.enabledTools.filter((tool): tool is string => typeof tool === 'string') }
        : {}),
    };
  }
  return output;
}

function readResumeId(options: Readonly<Record<string, unknown>> | undefined): string | null {
  return trimStringValue(options?.resumeId)
    ?? trimStringValue(options?.resumeSessionId)
    ?? trimStringValue(options?.sessionId);
}

function createPendingTurn(
  threadId: string,
  sessionTurnId: string,
  providerPrompt: PendingProviderPrompt | null,
  providerOperationIdentity: CodexConnectedServiceRuntimeIdentity | null,
): PendingTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  let settleAgentTurnId!: (agentTurnId: string | null) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const agentTurnIdPromise = new Promise<string | null>((resolvePromise) => {
    settleAgentTurnId = resolvePromise;
  });
  const startUserMessageSeq = providerPrompt?.userMessageSeq ?? providerPrompt?.userMessageSeqs[0] ?? null;
  const userMessageSeqs = providerPrompt
    ? Array.from(new Set(providerPrompt.userMessageSeqs))
    : [];
  if (startUserMessageSeq !== null && !userMessageSeqs.includes(startUserMessageSeq)) {
    userMessageSeqs.unshift(startUserMessageSeq);
  }
  return {
    threadId,
    sessionTurnId,
    agentTurnId: null,
    agentTurnIdObservation: {
      promise: agentTurnIdPromise,
      settle: settleAgentTurnId,
    },
    providerStartAcknowledged: false,
    nativePermissionPolicyKey: null,
    deferredTerminalNotification: null,
    providerPrompt,
    startUserMessageSeq,
    userMessageSeqs,
    interruptWhenProviderTurnIdArrives: false,
    providerOperationIdentity,
    providerAccountScope: undefined,
    promise,
    resolve,
    reject,
  };
}

function recordPendingTurnAgentTurnId(activeTurn: PendingTurn, agentTurnId: string): boolean {
  if (activeTurn.agentTurnId === agentTurnId) return false;
  activeTurn.agentTurnId = agentTurnId;
  return true;
}

function observePendingTurnAgentTurnId(activeTurn: PendingTurn, agentTurnId: string): boolean {
  const changed = recordPendingTurnAgentTurnId(activeTurn, agentTurnId);
  activeTurn.agentTurnIdObservation.settle(agentTurnId);
  return changed;
}

function settlePendingTurnAgentTurnIdObservation(activeTurn: PendingTurn): void {
  // A turn id first revealed by a terminal notification is useful transcript identity, but it
  // is no longer an actionable steer target. Release any waiter without dispatching a stale steer.
  activeTurn.agentTurnIdObservation.settle(null);
}

function pendingProviderPromptHasDeliveryIdentity(
  pending: PendingProviderPrompt,
): boolean {
  return pending.localInputIds.length > 0
    || pending.userMessageSeq !== null
    || pending.userMessageSeqs.length > 0;
}

function createErrorFromAppServerNotification(
  value: unknown,
  sourceAccountIdentity: CodexConnectedServiceRuntimeIdentity | null,
): Error {
  return createCodexAppServerTurnFailure({
    value,
    sourceAccountIdentity: sourceAccountIdentity
      ? {
          providerAccountId: sourceAccountIdentity.providerAccountId,
          accountLabel: sourceAccountIdentity.accountLabel,
          profileId: sourceAccountIdentity.profileId,
          groupId: sourceAccountIdentity.groupId,
          generation: sourceAccountIdentity.generation,
          credentialRevision: sourceAccountIdentity.credentialRevision,
          credentialFingerprint: sourceAccountIdentity.credentialFingerprint,
        }
      : null,
  });
}

function createCodexRuntimeEvent(
  target: CodexAppServerRuntimeTarget,
  event: CodexAppServerEventInput,
): CodexAppServerEvent {
  return {
    ...event,
    ...(target.happierSessionId !== undefined
      ? { sessionId: target.happierSessionId }
      : { executionRunId: target.executionRunId }),
    emittedAtMs: Date.now(),
  } as CodexAppServerEvent;
}

export function createCodexAppServerRuntime(
  params: CodexAppServerRuntimeParams,
): CodexAppServerRuntime {
  if (params.appServerTransport === 'daemonProxy' && Object.keys(params.mcpToolPolicy ?? {}).length > 0) {
    throw new PluginError({ code: 'codex_mcp_tool_policy_unsupported_transport',
      message: 'Codex daemon proxy cannot apply MCP tool filters to its already-running server.' });
  }
  const mcpServers = normalizeMcpServers(params.mcpServers);
  const mcpServerKeys = assignInjectedServerKeys(listCodexAppServerMcpServerNames(mcpServers, params.toolRestriction));
  const runtimeTargetId = params.happierSessionId !== undefined
    ? params.happierSessionId
    : params.executionRunId;
  const nativeAttachmentThreadName = `Happier session ${runtimeTargetId}`;
  const readRuntimeProcessEnv = (): Readonly<Record<string, string | undefined>> =>
    params.processEnv ?? params.host.baseProcessEnv;
  let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;
  let client: DisposableCodexAppServerClient | null = null;
  let currentSkills = params.skills;
  let skillsDelivered = params.appServerTransport === 'daemonProxy' || params.skills ? false : undefined;
  let handleAsyncQuestionNotification: ((raw: unknown) => boolean) | null = null;
  let threadId: string | null = readExactCodexProviderSessionId(params.initialProviderSessionId);
  let goalObservationState: 'reading' | 'unobserved' | 'observed' = 'reading';
  const readAndPublishGoalSnapshot = async (goalClient: DisposableCodexAppServerClient, observedThreadId: string): Promise<void> => {
    goalObservationState = 'reading';
    // Requested launch scope is distinct from this plugin process's scope; the host
    // Exec boundary can still apply its admitted environment. Keep Goal and
    // credential contents out of this local diagnostic.
    const goalReadScope = {
      threadId: observedThreadId,
      initialThreadId: readExactCodexProviderSessionId(params.initialProviderSessionId),
      requestedCodexHome: resolveCodexHome(readRuntimeProcessEnv()),
      requestedSqliteHome: readRuntimeProcessEnv().CODEX_SQLITE_HOME ?? null,
      pluginProcessCodexHome: resolveCodexHome(process.env),
      transport: params.appServerTransport ?? (params.appServerEndpoint ? 'unixWebSocket' : 'stdio'),
    };
    try {
      // ThreadResumeResponse has no Goal field. An explicit native read,
      // including goal:null, establishes the reopened source's initial state.
      const goal = readCodexGoalPayload(await goalClient.request('thread/goal/get', { threadId: observedThreadId }));
      goalObservationState = goal.kind === 'malformed' ? 'unobserved' : 'observed';
      params.host.logger.debug('Codex app-server initial goal read', { ...goalReadScope, kind: goal.kind,
        goalThreadId: goal.kind === 'present' ? readExactCodexProviderSessionId(goal.goal.threadId) : null });
      if (goal.kind !== 'malformed') await params.observeGoal?.(goal);
    } catch (error) {
      goalObservationState = 'unobserved';
      params.host.logger.debug('Codex app-server initial goal read failed', {
        ...goalReadScope,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  };
  let currentModelId: string | null = trimStringValue(params.initialModelId);
  let currentNativeModelProvider: string | null = null;
  let currentNativeAuthType: CodexActiveProviderAccount['authType'];
  let currentCollaborationModeId: string | null = trimStringValue(params.initialCollaborationModeId);
  let currentCollaborationModePayload: Readonly<{
    mode: string;
    settings: Readonly<{
      model: string;
      reasoning_effort: string | null;
      developer_instructions: null;
    }>;
  }> | null = null;
  const collaborationModeSelectionCache = new Map<
    string,
    NonNullable<ReturnType<typeof resolveCodexAppServerCollaborationModeSelection>>
  >();
  const providerDisablesReasoning =
    params.initialProviderBinding?.config.model_reasoning_effort === 'none';
  // Provider model changes follow restart_session, so both native factories
  // retain these exact model facts for this runtime's lifetime.
  const providerReasoningEffortOption = params.initialProviderModel
    ? readProviderReasoningEffortOption(params.initialProviderModel)
    : null;
  const requiresConfinedMcp = params.toolRestriction?.unlistedTools === 'deny'
    && mcpServerKeys.size > 0;
  let currentReasoningEffort: string | null = null;
  let currentServiceTier: string | null = null;
  let modelsSnapshot: AgentSessionModelsSnapshot = { models: null };
  const modelListeners = new Set<(snapshot: AgentSessionModelsSnapshot) => void>();
  // External Provider catalogs retain their existing authorized publisher.
  // Native discovery belongs only to the plain native route.
  const modelsBinding = !params.initialProviderBinding ? params.host.models?.bind({
    read: () => modelsSnapshot,
    subscribe(listener) {
      modelListeners.add(listener);
      return { dispose: () => { modelListeners.delete(listener); } };
    },
  }) : undefined;
  const publishCurrentModel = (modelId: string | null): void => {
    if (!modelsSnapshot.models || !modelId || modelsSnapshot.currentModelId === modelId) return;
    modelsSnapshot = { ...modelsSnapshot, currentModelId: modelId };
    for (const listener of modelListeners) listener(modelsSnapshot);
  };
  let currentPermissionPolicyOverride: CodexAppServerPolicy | null = null;
  let currentWorkspaceWrites = params.initialWorkspaceWrites;
  let currentPermissionMode = params.initialPermissionMode;
  let hasServiceTierOverride = false;
  let permissionSupport: CodexAppServerPermissionSupport = 'unknown';
  let publishedThreadId: string | null = null;
  // Realtime acceptance can publish an identity without persisting a native-resumable rollout.
  let nativeReadyThreadId: string | null = null;
  let turnSeq = 0;
  let pendingTurn: PendingTurn | null = null;
  let settledPromptCache: Readonly<{ threadId: string; nativeTurnId: string; lastUseAtMs: number }> | null = null;
  let connectedServiceAuthApplyTail: Promise<void> = Promise.resolve();
  let connectedServiceAuthApplyCount = 0;
  // Keep the existing terminal fence's original host correlation for late native tool results.
  const terminatedProviderTurnIds = new Map<string, string>();
  const preAckCancelledTurns = new Set<PendingTurn>();
  let turnCompletionSettling = false;
  let pendingTurnCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPendingTurnCompletion: Readonly<{
    status: 'completed' | 'interrupted';
    notificationParams: unknown;
  }> | null = null;
  let terminalPendingTurnFailure: Error | null = null;
  let active = false;
  let lastActivityAtMs: number | null = null;
  let disposed = false;
  let hostDisposed = false;
  let unexpectedExitPublished = false;
  let startedEmptyThreadWithoutExplicitModel = false;
  let startedEmptyThreadPolicyKey: string | null = null;
  let backgroundCompletion: Promise<void> | null = null;
  let activeChatGptAuthTokensRefreshSelection: CodexConnectedServiceRefreshSelection | null =
    resolveCodexConnectedServiceRefreshSelectionFromEnv(readRuntimeProcessEnv());
  const assertToolRestrictionAuthSupported = (externalAuthRequested = false): void => {
    if (requiresConfinedMcp && (externalAuthRequested || params.initialProviderBinding || activeChatGptAuthTokensRefreshSelection)) {
      throw new PluginError({ code: 'codex_tool_restriction_unsupported_auth', message: 'Codex MCP confinement cannot establish native tool-mode support after an external account or provider binding.' });
    }
  };
  let activeChatGptAccessTokenFingerprint: string | null = null;
  let appliedChatGptAccessTokens: Readonly<{ accessToken: string; accountId: string }> | null = null;
  let clientHasExternalAuthTokens = false;
  let latestConnectedServiceRuntimeIdentity: CodexConnectedServiceRuntimeIdentity | null = null;
  let publishedProvisionalProviderAccountUsageRecordId: string | null = null;
  const pendingProviderPrompts = new Set<PendingProviderPrompt>();
  const runtimeSubscribers = new Set<(event: CodexAppServerEvent) => void>();
  const resolveCurrentPolicy = (
    policy: CodexAppServerPolicy | null = currentPermissionPolicyOverride ?? params.resolveCurrentPolicy?.() ?? null,
  ): CodexAppServerPolicy | null => {
    if (policy?.approvalPolicy !== 'never' || !Object.entries(params.mcpToolPolicy ?? {}).some(([name, server]) =>
      mcpServerKeys.has(name)
      && (server.unlisted !== 'deny' || Object.values(server.tools).some(setting => setting === 'ask' || setting === 'allow')))) {
      return policy;
    }
    // Codex 0.162.1 refuses prompted MCP calls under `never` before the host
    // can enforce its live tool policy. Admit only MCP approval requests;
    // retain the native sandbox and denial of every other approval category.
    return { ...policy, approvalPolicy: { granular: {
      sandbox_approval: false, rules: false, mcp_elicitations: true,
      request_permissions: false, skill_approval: false,
    } } };
  };

  const readHostOwnedAuthTokens = async () => appliedChatGptAccessTokens
    ? { ...appliedChatGptAccessTokens, idToken: null, accountLabel: latestConnectedServiceRuntimeIdentity?.accountLabel ?? null }
    : await readCodexAuthTokensFromNativeHome(params.host.nativeHome);
  const recordAppliedChatGptAccessTokens = (accessToken: string, accountId: string): void => {
    // This process's accepted access material, not its immutable launch home,
    // serves subsequent native authentication and account-scoped observations.
    appliedChatGptAccessTokens = { accessToken, accountId };
    activeChatGptAccessTokenFingerprint = computeCodexAccessTokenFingerprint(accessToken);
  };
  const readHostOwnedAuthStoreProof = async () => {
    try {
      const bytes = (await params.host.nativeHome?.readFiles(['auth.json']))?.['auth.json'];
      if (!bytes) return { status: 'missing' } as const;
      return readCodexAuthStoreProviderAccountIdFromJson(
        JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      );
    } catch {
      return { status: 'missing' } as const;
    }
  };
  const toolEventProjector = createCodexAppServerToolEventProjector();
  const pendingHappierTitleToolNamesByCallId = new Map<string, string>();
  const publishedGeneratedMediaItemIds = new Set<string>();
  const publishedProviderUserMessageIds = new Set<string>();

  const publishRuntimeEvent = (event: CodexAppServerEventInput): void => {
    const payload = createCodexRuntimeEvent(params, event);
    for (const subscriber of runtimeSubscribers) subscriber(payload);
  };

  const publishSkillMentions = (turn: PendingTurn, input: readonly CodexAppServerTurnInputItem[]): void => {
    const reported = turn.reportedSkillNames ??= new Set<string>();
    const skills: Array<Readonly<{ name: string; path: string }>> = [];
    for (const item of input) {
      if (item.type !== 'skill' || reported.has(item.name)) continue;
      reported.add(item.name);
      skills.push({ name: item.name, path: item.path });
    }
    if (skills.length) publishRuntimeEvent({ kind: 'skill-usage', turnId: turn.sessionTurnId,
      ...(turn.agentTurnId ? { agentTurnId: turn.agentTurnId } : {}), skills });
  };

  const buildTurnToolCallKey = (turnId: string, callId: string): string => `${turnId}:${callId}`;

  const clearPendingHappierTitleToolNamesForTurn = (turnId: string): void => {
    const prefix = `${turnId}:`;
    for (const key of Array.from(pendingHappierTitleToolNamesByCallId.keys())) {
      if (key.startsWith(prefix)) pendingHappierTitleToolNamesByCallId.delete(key);
    }
  };

  const bufferedTranscriptSegments = new Map<string, BufferedTranscriptSegment>();

  const updateBufferedTranscriptSegment = (
    streamKey: string,
    kind: BufferedTranscriptSegment['kind'],
    sidechainId: string | null,
    text: string,
    mode: 'append' | 'override',
  ): void => {
    if (mode === 'append' && text.length === 0) return;
    const existing = bufferedTranscriptSegments.get(streamKey);
    bufferedTranscriptSegments.set(streamKey, {
      kind,
      sidechainId,
      text: mode === 'append' && existing?.kind === kind
        ? `${existing.text}${text}`
        : text,
      needsCommittedReconciliation: mode === 'override' || existing?.needsCommittedReconciliation === true,
    });
  };

  const publishBufferedTranscriptSegment = (
    streamKey: string,
    segment: BufferedTranscriptSegment,
    interruptedReason?: string,
  ): void => {
    if (!segment.needsCommittedReconciliation) return;
    publishRuntimeEvent({
      kind: 'transcript-agent-message-committed',
      agentId: 'codex',
      localId: `codex:${streamKey}`,
      ...(pendingTurn ? { turnId: pendingTurn.sessionTurnId } : {}),
      body: segment.kind === 'assistant'
        ? { type: 'message', message: segment.text }
        : { type: 'reasoning', message: segment.text },
      ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
      meta: {
        source: 'codex-app-server-runtime',
        streamKey,
        ...(interruptedReason !== undefined ? { interruptedReason } : {}),
      },
    });
  };

  const flushBufferedTranscriptSegments = (args: Readonly<{
    reason: 'turn-end' | 'abort' | 'tool-call-boundary';
    interruptedReason?: string;
  }>): void => {
    const segments = Array.from(bufferedTranscriptSegments.entries());
    bufferedTranscriptSegments.clear();
    for (const [streamKey, segment] of segments) {
      publishBufferedTranscriptSegment(streamKey, segment,
        args.reason === 'abort' ? args.interruptedReason ?? 'app-server-turn-interrupted' : undefined);
    }
  };

  const assistantReasoningProjector = createCodexAppServerAssistantReasoningProjector({
    bridge: {
      appendAssistantDelta({ deltaText, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'assistant', sidechainId, deltaText, 'append');
        const activeTurn = pendingTurn;
        if (activeTurn) publishRuntimeEvent({
          kind: 'message-delta',
          turnId: activeTurn.sessionTurnId,
          messageId: `codex:${streamKey}`,
          delta: { text: deltaText, thinking: false },
          ...(sidechainId ? { sidechainId } : {}),
        });
      },
      appendThinkingDelta({ deltaText, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'reasoning', sidechainId, deltaText, 'append');
        const activeTurn = pendingTurn;
        if (activeTurn) publishRuntimeEvent({
          kind: 'message-delta',
          turnId: activeTurn.sessionTurnId,
          messageId: `codex:${streamKey}`,
          delta: { text: deltaText, thinking: true },
          ...(sidechainId ? { sidechainId } : {}),
        });
      },
      overrideAssistantText({ text, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'assistant', sidechainId, text, 'override');
        const segment = bufferedTranscriptSegments.get(streamKey);
        if (segment) {
          bufferedTranscriptSegments.delete(streamKey);
          publishBufferedTranscriptSegment(streamKey, segment);
        }
      },
      overrideThinkingText({ text, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'reasoning', sidechainId, text, 'override');
      },
      async flushAll(args) {
        flushBufferedTranscriptSegments(args);
      },
    },
  });

  const flushAssistantReasoningProjection = (reason: 'turn-end' | 'abort'): void => {
    void assistantReasoningProjector.flush(reason).catch((error: unknown) => {
      params.host.logger.debug('Codex app-server assistant transcript projection flush failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };

  const trackPendingProviderPrompt = (
    text: string,
    options: CodexAppServerSendOptions | undefined,
    waitForProviderAcceptance = false,
  ): PendingProviderPrompt => {
    const userMessageSeq = readRuntimeUserMessageSeq(options);
    const localInputIds = readRuntimeLocalInputIds(options);
    let providerAcceptance: PendingProviderAcceptance | null = null;
    if (waitForProviderAcceptance && localInputIds.length === 1) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      void promise.catch(() => undefined);
      providerAcceptance = { promise, settled: false, resolve, reject };
    }
    const pending = {
      text,
      localInputIds,
      hostTurnId: readRuntimeTurnId(options),
      userMessageSeq,
      userMessageSeqs: readRuntimeUserMessageSeqs(options),
      providerAcceptance,
    };
    pendingProviderPrompts.add(pending);
    return pending;
  };

  const clearPendingProviderPrompt = (
    pending: PendingProviderPrompt | null | undefined,
    error?: Error,
  ): void => {
    if (!pending) return;
    pendingProviderPrompts.delete(pending);
    const acceptance = pending.providerAcceptance;
    if (error && acceptance && !acceptance.settled) {
      acceptance.settled = true;
      acceptance.reject(error);
    }
  };

  const clearAllPendingProviderPrompts = (error?: Error): void => {
    for (const pending of [...pendingProviderPrompts]) {
      clearPendingProviderPrompt(pending, error);
    }
  };

  const rejectPendingProviderAcceptancesForHostTurn = (
    hostTurnId: string,
    error: Error,
  ): void => {
    for (const pending of [...pendingProviderPrompts]) {
      if (pending.hostTurnId === hostTurnId) clearPendingProviderPrompt(pending, error);
    }
  };

  const invalidatePromptCacheEvidence = (): void => {
    settledPromptCache = null;
    if (pendingTurn) pendingTurn.promptCache = undefined;
  };

  const invalidatePendingProviderOperationIdentity = (): void => {
    invalidatePromptCacheEvidence();
    currentNativeAuthType = undefined;
    if (!pendingTurn) return;
    pendingTurn.providerOperationIdentity = null;
    pendingTurn.providerAccountScope = undefined;
  };

  const readLiveProviderAccount = async (): Promise<CodexActiveProviderAccount | null> => {
    try {
      const identityBeforeRead = latestConnectedServiceRuntimeIdentity;
      const liveAccount = readCodexActiveProviderAccount(await (await ensureClient()).request(
        'account/read',
        undefined,
        { timeoutMs: null },
      ));
      if (latestConnectedServiceRuntimeIdentity === identityBeforeRead) {
        if (currentNativeAuthType !== undefined && currentNativeAuthType !== liveAccount.authType) invalidatePromptCacheEvidence();
        currentNativeAuthType = liveAccount.authType;
      }
      if (latestConnectedServiceRuntimeIdentity === identityBeforeRead
        && isCodexRequestUsageIdentityContradicted(identityBeforeRead, liveAccount)) {
        // Negative native evidence withdraws both the current attempt and future
        // dispatch proof. A later matching read cannot restore the old attempt.
        invalidatePendingProviderOperationIdentity();
        latestConnectedServiceRuntimeIdentity = null;
      }
      return liveAccount;
    } catch (error) {
      params.host.logger.debug('Codex app-server live account read failed for provider-account usage snapshot (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  };

  const runtimeIdentityMatchesActiveSelection = (
    identity: CodexConnectedServiceRuntimeIdentity,
  ): boolean => {
    const selection = activeChatGptAuthTokensRefreshSelection;
    if (!selection) return true;
    if (selection.kind === 'group') {
      return identity.profileId === selection.activeProfileId
        && identity.groupId === selection.groupId
        && identity.generation === selection.generation;
    }
    return identity.profileId === selection.profileId && identity.groupId === null;
  };

  const refreshLiveAccountRuntimeIdentity = async (): Promise<CodexConnectedServiceRuntimeIdentity | null> => {
    const identityBeforeRead = latestConnectedServiceRuntimeIdentity;
    const liveProviderAccount = await readLiveProviderAccount();
    if (latestConnectedServiceRuntimeIdentity !== identityBeforeRead) return null;
    const liveRuntimeIdentity = liveProviderAccount
      ? buildCodexLiveAccountRuntimeIdentity({
          liveProviderAccount,
          currentSelection: activeChatGptAuthTokensRefreshSelection,
          previousIdentity: identityBeforeRead,
        })
      : null;
    if (liveRuntimeIdentity) {
      latestConnectedServiceRuntimeIdentity = liveRuntimeIdentity;
    }
    return liveRuntimeIdentity;
  };

  const readRateLimitResetCreditsRaw = async (
    _env: Readonly<Record<string, string | undefined>>,
  ): Promise<unknown> => {
    const authTokens = await readHostOwnedAuthTokens();
    const accessToken = authTokens.accessToken ?? authTokens.idToken;
    if (!accessToken) return undefined;
    if (!params.host.fetchRateLimitResetCredits) return undefined;
    try {
      return await params.host.fetchRateLimitResetCredits({
        accessToken,
        accountId: authTokens.accountId,
      });
    } catch (error) {
      params.host.logger.debug('Codex app-server reset-credit usage snapshot fetch failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  };

  const recordProviderAccountUsageSnapshot = async (
    rawSnapshot: unknown,
    options: RecordProviderAccountUsageSnapshotOptions,
  ): Promise<void> => {
    const service = params.host.accountUsage;
    if (!service) return;
    const env = readRuntimeProcessEnv();
    const codexHome = resolveCodexHome(env);
    const observedAtMs = Date.now();
    try {
      const identityBeforeLiveRead = options.operationIdentity;
      const liveProviderAccount = options.includeLiveAccountIdentity === true
        ? await readLiveProviderAccount()
        : null;
      let appliedIdentity = identityBeforeLiveRead;
      let verifiedLiveProviderAccount: CodexActiveProviderAccount | null = null;
      let forceProvisional = latestConnectedServiceRuntimeIdentity !== identityBeforeLiveRead
        || (identityBeforeLiveRead === null && activeChatGptAuthTokensRefreshSelection !== null);
      if (latestConnectedServiceRuntimeIdentity !== identityBeforeLiveRead) {
        appliedIdentity = null;
      } else if (liveProviderAccount) {
        const verifiedIdentity = buildCodexLiveAccountRuntimeIdentity({
          liveProviderAccount,
          currentSelection: activeChatGptAuthTokensRefreshSelection,
          previousIdentity: identityBeforeLiveRead,
        });
        if (verifiedIdentity) {
          latestConnectedServiceRuntimeIdentity = verifiedIdentity;
          appliedIdentity = verifiedIdentity;
          verifiedLiveProviderAccount = liveProviderAccount;
        } else {
          appliedIdentity = null;
          forceProvisional = true;
        }
      }
      const identityFence = latestConnectedServiceRuntimeIdentity;
      const rawResetCredits = await readRateLimitResetCreditsRaw(env);
      const authStoreProviderAccountIdProof = !appliedIdentity && !forceProvisional
        ? await readHostOwnedAuthStoreProof()
        : null;
      if (latestConnectedServiceRuntimeIdentity !== identityFence) {
        appliedIdentity = null;
        verifiedLiveProviderAccount = null;
        forceProvisional = true;
      }
      const sourceContext = appliedIdentity
        ? await service.resolveSourceContext({ serviceId: appliedIdentity.serviceId })
        : null;
      const provisionalDiscriminator = buildCodexProviderAccountUsageProvisionalDiscriminator({
        sourceContext,
        happierSessionId: runtimeTargetId,
        codexHome,
      });
      const subject = appliedIdentity
        ? {
            providerId: CODEX_ACCOUNT_USAGE_PROVIDER_ID,
            kind: 'providerSubject' as const,
            accountSubjectId: appliedIdentity.providerAccountId,
            proof: 'connected_service_provider_account_id' as const,
          }
        : resolveCodexUsageSubjectRef({
            ...(forceProvisional ? {} : { authStoreProviderAccountIdProof }),
            provisionalDiscriminator,
          });
      const snapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
        subject,
        rawSnapshot,
        rawResetCredits,
        observedAtMs,
        fetchedAtMs: observedAtMs,
        accountLabel: appliedIdentity?.accountLabel ?? verifiedLiveProviderAccount?.providerEmail ?? null,
      });
      const result = await service.recordSnapshot({
        snapshot,
        ...(options.policyDisposition ? { policyDisposition: options.policyDisposition } : {}),
        ...(sourceContext && appliedIdentity
          ? { source: { serviceId: appliedIdentity.serviceId } }
          : {}),
      });
      if (result.status !== 'recorded') {
        params.host.logger.debug('Codex app-server provider-account usage snapshot was not recorded', {
          status: result.status,
          reason: 'reason' in result ? result.reason : null,
        });
        return;
      }
      if (subject.kind === 'provisionalLocalSubject') {
        publishedProvisionalProviderAccountUsageRecordId = buildAgentAccountUsageRecordId(snapshot.recordKey);
        return;
      }
      const provisionalRecordId = publishedProvisionalProviderAccountUsageRecordId;
      if (!provisionalRecordId) return;
      publishedProvisionalProviderAccountUsageRecordId = null;
      const adoptionResult = await service.adoptProvisionalRecord({
        adoption: {
          fromRecordId: provisionalRecordId,
          toRecordId: buildAgentAccountUsageRecordId(snapshot.recordKey),
          stableRecordKey: snapshot.recordKey,
          proof: subject.proof === 'auth_store_chatgpt_account_id'
            ? { kind: 'id_token_account_id', issuer: 'chatgpt' }
            : { kind: 'provider_account_id_match' },
          observedAtMs,
        },
      });
      if (adoptionResult.status !== 'adopted' && adoptionResult.status !== 'already_adopted') {
        params.host.logger.debug('Codex app-server provider-account usage adoption was not applied', {
          status: adoptionResult.status,
          reason: 'reason' in adoptionResult ? adoptionResult.reason : null,
        });
      }
    } catch (error) {
      params.host.logger.debug('Codex app-server provider-account usage recording failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  const publishImmediateProviderAccountUsageSnapshotForQuotaFailure = async (error: Error): Promise<void> => {
    if (!isCodexRuntimeAuthQuotaFailure(error)) return;
    try {
      const appServerClient = await ensureClient();
      const operationIdentity = latestConnectedServiceRuntimeIdentity;
      const result = await readCodexRuntimeRateLimitsSnapshot(appServerClient);
      await recordProviderAccountUsageSnapshot(result.rawSnapshot, {
        operationIdentity,
        includeLiveAccountIdentity: true,
        policyDisposition: 'evidence_only',
      });
    } catch (snapshotError) {
      params.host.logger.debug('Codex app-server immediate quota usage snapshot failed (ignored)', {
        errorName: snapshotError instanceof Error ? snapshotError.name : typeof snapshotError,
      });
    }
  };

  let pendingChatGptRefreshAttempt: Readonly<{
    expectedCredentialRevision: string;
    refreshAttemptId: string;
  }> | null = null;

  const refreshChatGptAuthTokens = async (requestParams: unknown): Promise<unknown> => {
    // An auth transition inside one native attempt can combine accounts.
    // No end-state comparison (including A -> B -> A) restores that proof.
    invalidatePendingProviderOperationIdentity();
    const selection = activeChatGptAuthTokensRefreshSelection;
    if (!selection) {
      throw new Error('connected_service_chatgpt_refresh_selection_unavailable');
    }
    const refreshRuntimeAuth = params.host.refreshRuntimeAuth;
    if (!refreshRuntimeAuth) {
      throw new Error('connected_service_chatgpt_refresh_unavailable');
    }
    const expectedCredentialRevision = latestConnectedServiceRuntimeIdentity?.credentialRevision ?? null;
    if (!expectedCredentialRevision) {
      throw new Error('connected_service_credential_revision_unavailable');
    }
    const refreshAttempt = pendingChatGptRefreshAttempt?.expectedCredentialRevision === expectedCredentialRevision
      ? pendingChatGptRefreshAttempt
      : Object.freeze({
          expectedCredentialRevision,
          refreshAttemptId: `codex-auth-refresh-${randomUUID()}`,
        });
    pendingChatGptRefreshAttempt = refreshAttempt;
    let refreshServiceResult: Awaited<ReturnType<NonNullable<
      CodexAppServerRuntimeHost['refreshRuntimeAuth']
    >>>;
    do {
      refreshServiceResult = await refreshRuntimeAuth({
        serviceId: 'openai-codex',
        refreshAttemptId: refreshAttempt.refreshAttemptId,
        selection,
        planType: readCodexChatGptAuthTokensPlanType(requestParams),
        ...(activeChatGptAccessTokenFingerprint
          ? { failingAccessTokenFingerprint: activeChatGptAccessTokenFingerprint }
          : {}),
        expectedCredentialRevision,
        reason: 'chatgpt_auth_tokens_refresh',
      });
    } while (isCodexChatGptAuthTokensRefreshPending(refreshServiceResult, refreshAttempt.refreshAttemptId));
    const refreshed = readCodexChatGptAuthTokensRefreshResult(refreshServiceResult);
    if (!refreshed) {
      throw new Error('connected_service_chatgpt_refresh_invalid_result');
    }
    pendingChatGptRefreshAttempt = null;
    recordAppliedChatGptAccessTokens(refreshed.accessToken, refreshed.chatgptAccountId);
    if (
      latestConnectedServiceRuntimeIdentity
      && latestConnectedServiceRuntimeIdentity.providerAccountId === refreshed.chatgptAccountId
    ) {
      latestConnectedServiceRuntimeIdentity = {
        ...latestConnectedServiceRuntimeIdentity,
        credentialFingerprint: activeChatGptAccessTokenFingerprint,
        credentialRevision: refreshed.credentialRevision,
        source: 'token_refresh',
      };
    }
    return {
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
      ...(refreshed.chatgptPlanType ? { chatgptPlanType: refreshed.chatgptPlanType } : {}),
    };
  };

  const publishThreadIdentity = (nextThreadId: string, isExistingResume = false): void => {
    const exactThreadId = readExactCodexProviderSessionId(nextThreadId);
    if (!exactThreadId) return;
    threadId = exactThreadId;
    if (!canPublishSessionResumeIdentity({
      isExistingResume,
      hasResumeEvidence: nativeReadyThreadId === exactThreadId,
    })) return;
    if (publishedThreadId === exactThreadId) return;
    publishedThreadId = exactThreadId;
    publishRuntimeEvent({
      kind: 'session-id-publish',
      publishedSessionId: exactThreadId,
      source: 'codex-app-server',
    });
    publishRuntimeEvent({
      kind: 'descriptor-update',
      descriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: exactThreadId,
        appServerEndpoint: params.appServerEndpoint,
        appServerTransport: params.appServerTransport,
        homePath: resolveCodexHome(readRuntimeProcessEnv()),
      }),
    });
  };

  const setActive = (nextActive: boolean): void => {
    active = nextActive;
    lastActivityAtMs = Date.now();
  };

  const notificationMatchesPendingTurn = (notificationParams: unknown): boolean => {
    const activeTurn = pendingTurn;
    if (!activeTurn) return false;
    const notificationThreadId = readThreadId(notificationParams) ?? activeTurn.threadId;
    if (notificationThreadId !== activeTurn.threadId) return false;
    const agentTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams);
    return !agentTurnId || !activeTurn.agentTurnId || agentTurnId === activeTurn.agentTurnId;
  };

  const readProviderEventItemRole = (notificationParams: unknown): string | null => {
    const item = readProviderEventItemRecord(notificationParams);
    const role = trimStringValue(item?.role);
    return role ? role.toLowerCase() : null;
  };

  const readProviderUserMessageClientId = (notificationParams: unknown): string | null => {
    if (readNormalizedProviderEventItemType(notificationParams) !== 'usermessage') return null;
    const item = readProviderEventItemRecord(notificationParams);
    return trimStringValue(item?.clientId) ?? trimStringValue(item?.client_id);
  };

  const markCorrelatedProviderUserMessageAccepted = (notificationParams: unknown): void => {
    const clientUserMessageId = readProviderUserMessageClientId(notificationParams);
    if (!clientUserMessageId) return;
    const pending = Array.from(pendingProviderPrompts).find((candidate) => (
      candidate.localInputIds.length === 1
      && candidate.localInputIds[0] === clientUserMessageId
    ));
    const acceptance = pending?.providerAcceptance;
    if (!acceptance || acceptance.settled) return;
    acceptance.settled = true;
    acceptance.resolve();
  };

  const publishProviderNativeUserMessage = (notificationParams: unknown): void => {
    if (readNormalizedProviderEventItemType(notificationParams) !== 'usermessage') return;
    if (readProviderUserMessageClientId(notificationParams)) return;
    const activeTurn = pendingTurn;
    const itemId = readProviderEventItemId(notificationParams);
    const text = readProviderUserMessageText(notificationParams);
    if (!activeTurn || !itemId || !text) return;
    const localId = `codex-app-server-user:${activeTurn.sessionTurnId}:${itemId}`;
    if (publishedProviderUserMessageIds.has(localId)) return;
    publishedProviderUserMessageIds.add(localId);
    publishRuntimeEvent({
      kind: 'transcript-user-message-committed',
      localId,
      text,
      turnId: activeTurn.sessionTurnId,
    });
  };

  const readThreadNameUpdateTitle = (notificationParams: unknown): string | null => {
    const record = readRecord(notificationParams);
    return trimStringValue(record?.threadName);
  };

  const applyThreadNameUpdate = (notificationParams: unknown): void => {
    const title = readThreadNameUpdateTitle(notificationParams);
    // Empty-rollout materialization names the native thread for attachment.
    // Its echoed bookkeeping name must not replace the person's Session title.
    if (!title || title === nativeAttachmentThreadName) return;
    const notificationThreadId = readThreadId(notificationParams);
    if (threadId && notificationThreadId && notificationThreadId !== threadId) return;
    if (!params.host.setTitle) return;
    void params.host.setTitle(title).catch((error: unknown) => {
      params.host.logger.debug('Codex app-server display title write failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };

  const observeAssistantReasoningNotification = (
    method: string,
    notificationParams: unknown,
    childContext?: NativeChildProjectionContext,
  ): boolean => {
    const activeTurn = pendingTurn;
    if (!childContext && !notificationMatchesPendingTurn(notificationParams)) return false;
    const context = childContext ?? (activeTurn ? { sidechainId: null, streamScopeId: activeTurn.sessionTurnId } : null);
    if (!context) return false;
    const projector = childContext?.projector ?? assistantReasoningProjector;
    const itemId = readProviderEventItemId(notificationParams)
      ?? `${method}:${context.streamScopeId}`;
    if (method === 'item/agentMessage/delta') {
      const text = readProviderEventText(notificationParams, ['delta', 'text']);
      return projector.observeStreamUpdate({
        type: 'assistant-text-delta',
        itemId,
        text,
      }, context);
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const text = readProviderEventText(notificationParams, ['delta', 'text']);
      return projector.observeStreamUpdate({
        type: 'reasoning-delta',
        itemId,
        text,
      }, context);
    }
    if (method === 'rawResponseItem/completed') {
      // Raw Responses items include developer/system/user input as well as model output.
      // Only the native assistant message is a user-facing fallback for typed item events.
      if (readNormalizedProviderEventItemType(notificationParams) !== 'message'
        || readProviderEventItemRole(notificationParams) !== 'assistant') return false;
      const text = readProviderEventText(notificationParams, ['text', 'message', 'outputText', 'output_text']);
      return projector.observeStreamUpdate({
        type: 'assistant-raw-final',
        itemId: readProviderEventItemId(notificationParams),
        text,
      }, context);
    }
    if (method !== 'item/completed') return false;
    if (!childContext && handleAsyncQuestionNotification?.(notificationParams)) {
      return true;
    }
    const itemType = readNormalizedProviderEventItemType(notificationParams);
    const itemRole = readProviderEventItemRole(notificationParams);
    const text = readProviderEventText(notificationParams, ['text', 'message', 'outputText', 'output_text']);
    if (text === null) return false;
    if (itemType?.includes('reasoning') || itemType?.includes('thinking')) {
      return projector.observeStreamUpdate({
        type: 'reasoning-final',
        itemId,
        text,
      }, context);
    }
    if (
      itemRole === 'assistant'
      || itemType?.includes('agentmessage')
      || itemType?.includes('assistantmessage')
      || itemType === 'message'
      || itemType?.includes('outputmessage')
    ) {
      return projector.observeStreamUpdate({
        type: 'assistant-text-final',
        itemId,
        text,
      }, context);
    }
    return false;
  };

  const nativeChildren = createCodexNativeChildObserver({
    parentThreadId: () => threadId,
    subagents: params.host.subagents,
    logger: params.host.logger,
    publish: publishRuntimeEvent,
    observeReasoning: observeAssistantReasoningNotification,
    readFailureMessage: (notificationParams) => createErrorFromAppServerNotification(notificationParams, null).message,
  });

  const publishToolEventsFromNotification = (method: string, notificationParams: unknown): boolean => {
    const activeTurn = pendingTurn;
    const activeMatch = activeTurn && notificationMatchesPendingTurn(notificationParams) ? activeTurn : null;
    const providerTurnId = readProviderEventTurnId(notificationParams);
    const settledHostTurnId = (method === 'item/completed' || method === 'rawResponseItem/completed')
      && readThreadId(notificationParams) === threadId && providerTurnId
      ? terminatedProviderTurnIds.get(providerTurnId)
      : undefined;
    const hostTurnId = activeMatch?.sessionTurnId ?? settledHostTurnId;
    if (!hostTurnId) return false;
    const publishable = toolEventProjector.project({ method, notificationParams,
      mcpServerKeys, scopeId: hostTurnId, ...(!activeMatch ? { lateResultOnly: true } : {}) });
    if (activeMatch?.promptCache && method === 'item/completed'
      && publishable.some(event => event.type === 'tool-result' && !event.sidechainId)) {
      const completedAtMs = readRecord(notificationParams)?.completedAtMs;
      if (typeof completedAtMs === 'number' && Number.isSafeInteger(completedAtMs) && completedAtMs >= 0) {
        activeMatch.promptCache = { ...activeMatch.promptCache, lastNonModelItemCompletedAtMs: completedAtMs };
      }
    }
    if (publishable.length === 0) return false;
    if (activeMatch) flushBufferedTranscriptSegments({ reason: 'tool-call-boundary' });
    let published = false;
    for (const event of publishable) {
      if (event.type === 'tool-call') {
        if (!event.sidechainId && isChangeTitleToolNameAlias(event.name)) {
          const title = readHappierTitleToolTitle(event.input);
          if (title) {
            pendingHappierTitleToolNamesByCallId.set(buildTurnToolCallKey(hostTurnId, event.callId), title);
          }
        }
        publishRuntimeEvent({
          kind: 'tool-call',
          turnId: hostTurnId,
          toolCallId: event.callId,
          toolName: event.name,
          toolInput: event.input,
          ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
        });
        published = true;
        continue;
      }
      const completedTitleName = pendingHappierTitleToolNamesByCallId.get(
        buildTurnToolCallKey(hostTurnId, event.callId),
      ) ?? null;
      pendingHappierTitleToolNamesByCallId.delete(buildTurnToolCallKey(hostTurnId, event.callId));
      if (activeMatch && completedTitleName && !event.sidechainId && didHappierTitleToolSucceed(event.output)) {
        const activeClient = client;
        if (activeClient) {
          void activeClient.request('thread/name/set', {
            threadId: activeMatch.threadId,
            name: completedTitleName,
          }).catch((error: unknown) => {
            params.host.logger.debug('Codex app-server failed to sync Happier title to native thread name', {
              threadId: activeMatch.threadId,
              errorName: error instanceof Error ? error.name : typeof error,
            });
          });
        }
      }
      publishRuntimeEvent({
        kind: 'tool-result',
        turnId: hostTurnId,
        toolCallId: event.callId,
        output: event.output,
        ...(event.isError === undefined ? {} : { isError: event.isError }),
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      });
      published = true;
    }
    return published;
  };

  const publishGeneratedMediaFromNotification = (method: string, notificationParams: unknown): void => {
    if (method !== 'item/completed' || !params.host.publishGeneratedMedia) return;
    const item = readProviderEventItemRecord(notificationParams);
    const itemId = readProviderEventItemId(notificationParams);
    if (!item || !itemId || publishedGeneratedMediaItemIds.has(itemId)) return;
    const candidate = extractCodexGeneratedMediaCandidate(itemId, item);
    if (!candidate) return;
    publishedGeneratedMediaItemIds.add(itemId);
    void params.host.publishGeneratedMedia(candidate).catch((error: unknown) => {
      params.host.logger.debug('Codex app-server generated media publication failed (ignored)', {
        code: 'codex_generated_media_publish_failed',
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };

  const clearPendingTurnCompletionTimer = (): void => {
    if (pendingTurnCompletionTimer) {
      clearTimeout(pendingTurnCompletionTimer);
      pendingTurnCompletionTimer = null;
    }
    scheduledPendingTurnCompletion = null;
    turnCompletionSettling = false;
  };

  const publishRollbackBoundaryForSettledTurn = (
    activeTurn: PendingTurn,
    agentTurnId: string | null,
  ): void => {
    if (!agentTurnId) return;
    const startUserMessageSeq = activeTurn.startUserMessageSeq;
    const endSeqInclusive = startUserMessageSeq === null
      ? null
      : activeTurn.userMessageSeqs.reduce(
          (latestSeq, seq) => Math.max(latestSeq, seq),
          startUserMessageSeq,
        );
    publishRuntimeEvent({
      kind: 'turn-rollback-boundary-observed',
      turnId: activeTurn.sessionTurnId,
      agentTurnId,
      providerCheckpoint: agentTurnId,
      ...(startUserMessageSeq === null
        ? {}
        : {
            startUserMessageSeq,
            startSeqInclusive: startUserMessageSeq,
            endSeqInclusive,
          }),
    });
  };

  const finishPendingTurn = (status: 'completed' | 'interrupted', notificationParams: unknown): void => {
    const activeTurn = pendingTurn;
    if (!activeTurn) {
      clearPendingTurnCompletionTimer();
      return;
    }
    const notificationThreadId = readThreadId(notificationParams) ?? activeTurn.threadId;
    if (notificationThreadId !== activeTurn.threadId) return;
    const agentTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams)
      ?? activeTurn.agentTurnId;
    if (agentTurnId && activeTurn.agentTurnId && agentTurnId !== activeTurn.agentTurnId) return;
    if (activeTurn.compaction) {
      if (agentTurnId) terminatedProviderTurnIds.set(agentTurnId, activeTurn.sessionTurnId);
      activeTurn.compaction.finish(status === 'completed' ? 'completed' : 'cancelled');
      settlePendingTurnAgentTurnIdObservation(activeTurn);
      pendingTurn = null;
      activeTurn.resolve();
      return;
    }
    const lastUseAtMs = resolvePromptCacheLastUseAtMs(activeTurn.promptCache ?? {});
    settledPromptCache = agentTurnId && lastUseAtMs !== undefined
      ? { threadId: activeTurn.threadId, nativeTurnId: agentTurnId, lastUseAtMs }
      : null;
    if (agentTurnId && recordPendingTurnAgentTurnId(activeTurn, agentTurnId)) {
      publishRuntimeEvent({
        kind: 'turn-agent-id-observed',
        turnId: activeTurn.sessionTurnId,
        agentTurnId,
      });
    }
    if (agentTurnId) terminatedProviderTurnIds.set(agentTurnId, activeTurn.sessionTurnId);
    publishToolEventsFromNotification('turn/completed', notificationParams);
    settlePendingTurnAgentTurnIdObservation(activeTurn);
    clearPendingTurnCompletionTimer();
    flushAssistantReasoningProjection(
      status === 'interrupted' || readCodexTerminalOutcome('turn/completed', notificationParams) === 'interrupted'
        ? 'abort'
        : 'turn-end',
    );
    rejectPendingProviderAcceptancesForHostTurn(
      activeTurn.sessionTurnId,
      new Error('Codex provider turn ended before correlated user-message acceptance was observed'),
    );
    pendingTurn = null;
    clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
    terminalPendingTurnFailure = null;
    setActive(false);
    if (status === 'interrupted' || readCodexTerminalOutcome('turn/completed', notificationParams) === 'interrupted') {
      publishRuntimeEvent({
        kind: 'turn-cancelled',
        turnId: activeTurn.sessionTurnId,
        ...(agentTurnId ? { agentTurnId } : {}),
      });
    } else {
      publishRuntimeEvent({
        kind: 'turn-complete',
        turnId: activeTurn.sessionTurnId,
        ...(agentTurnId ? { agentTurnId } : {}),
      });
    }
    publishRollbackBoundaryForSettledTurn(activeTurn, agentTurnId ?? null);
    activeTurn.resolve();
  };

  const adoptProviderTurnFromActivity = (
    notificationParams: unknown,
    options: Readonly<{ allowUnownedAdoption: boolean }>,
  ): PendingTurn | null => {
    const activeTurn = pendingTurn;
    const explicitNotificationThreadId = readThreadId(notificationParams);
    if (!activeTurn && Array.from(preAckCancelledTurns).some((turn) => (
      !explicitNotificationThreadId || turn.threadId === explicitNotificationThreadId
    ))) return null;
    const notificationThreadId = explicitNotificationThreadId
      ?? activeTurn?.threadId
      ?? threadId;
    if (!notificationThreadId) return null;
    if (activeTurn && notificationThreadId !== activeTurn.threadId) return null;
    if (!activeTurn && threadId && notificationThreadId !== threadId) return null;

    const agentTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams);
    if (!agentTurnId) return activeTurn;
    if (terminatedProviderTurnIds.has(agentTurnId)) return null;
    // Older Codex versions can return a thread id before materializing resumable state.
    // Provider turn activity is the first durable boundary for a freshly started thread.
    nativeReadyThreadId = notificationThreadId;
    publishThreadIdentity(notificationThreadId);

    if (activeTurn) {
      if (!activeTurn.agentTurnId) {
        observePendingTurnAgentTurnId(activeTurn, agentTurnId);
        activeTurn.providerStartAcknowledged = true;
        if (!activeTurn.compaction) publishRuntimeEvent({
          kind: 'turn-agent-id-observed',
          turnId: activeTurn.sessionTurnId,
          agentTurnId,
        });
        return activeTurn;
      }
      if (activeTurn.agentTurnId === agentTurnId) return activeTurn;

      const predecessorCompletion = scheduledPendingTurnCompletion;
      if (
        !turnCompletionSettling
        || !predecessorCompletion
        || explicitNotificationThreadId !== activeTurn.threadId
      ) return null;
      const predecessorAgentTurnId = activeTurn.agentTurnId;
      finishPendingTurn(predecessorCompletion.status, predecessorCompletion.notificationParams);
      if (pendingTurn) return null;
      params.host.logger.debug('Codex app-server handed off an immediate provider-started successor turn', {
        threadId: notificationThreadId,
        predecessorAgentTurnId,
        successorAgentTurnId: agentTurnId,
      });
    } else if (!options.allowUnownedAdoption) {
      return null;
    } else if (!explicitNotificationThreadId || explicitNotificationThreadId !== threadId) {
      // Without a pending predecessor, only an explicitly identified primary-thread event
      // can establish ownership. Thread-less late items and child activity stay unowned.
      return null;
    }

    turnSeq += 1;
    const providerTurn = createPendingTurn(
      notificationThreadId,
      createCodexAppServerTurnId(),
      null,
      null,
    );
    const startedAt = readRecord(readRecord(notificationParams)?.turn)?.startedAt;
    providerTurn.promptCache = {};
    if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0) {
      providerTurn.promptCache = { turnStartedAtMs: startedAt * 1000 };
    }
    settledPromptCache = null;
    observePendingTurnAgentTurnId(providerTurn, agentTurnId);
    providerTurn.providerStartAcknowledged = true;
    pendingTurn = providerTurn;
    terminalPendingTurnFailure = null;
    void providerTurn.promise.catch(() => undefined);
    setActive(true);
    publishRuntimeEvent({
      kind: 'turn-start',
      turnId: providerTurn.sessionTurnId,
      agentTurnId,
      startedBy: 'provider',
    });
    return providerTurn;
  };

  const canSettleTerminalPendingTurn = (notificationParams: unknown): boolean => {
    const activeTurn = pendingTurn;
    if (!activeTurn) return false;
    const notificationThreadId = readThreadId(notificationParams);
    // A child-thread completion is owned by that subagent, never by the primary turn.
    if (notificationThreadId && notificationThreadId !== activeTurn.threadId) return false;
    const terminalTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams);
    // Resume can replay an already terminated provider turn while a new primary turn is active.
    if (terminalTurnId && terminatedProviderTurnIds.has(terminalTurnId)) return false;
    if (terminalTurnId && activeTurn.agentTurnId && activeTurn.agentTurnId !== terminalTurnId) {
      params.host.logger.debug('Codex app-server ignored an unknown mismatched terminal turn', {
        threadId: activeTurn.threadId,
        activeAgentTurnId: activeTurn.agentTurnId,
        terminalTurnId,
      });
      return false;
    }
    if (terminalTurnId && !activeTurn.agentTurnId && !activeTurn.providerStartAcknowledged) {
      params.host.logger.debug('Codex app-server ignored a terminal id before provider turn start was acknowledged', {
        threadId: activeTurn.threadId,
        terminalTurnId,
      });
      return false;
    }
    if (
      terminalTurnId
      && !activeTurn.agentTurnId
      && recordPendingTurnAgentTurnId(activeTurn, terminalTurnId)
    ) {
      if (!activeTurn.compaction) publishRuntimeEvent({ kind: 'turn-agent-id-observed', turnId: activeTurn.sessionTurnId, agentTurnId: terminalTurnId });
    }
    return true;
  };

  const completePendingTurn = (status: 'completed' | 'interrupted', notificationParams: unknown): void => {
    if (!pendingTurn) return;
    if (!canSettleTerminalPendingTurn(notificationParams)) return;
    if (status === 'interrupted' || readCodexTerminalOutcome('turn/completed', notificationParams) === 'interrupted') {
      finishPendingTurn(status, notificationParams);
      return;
    }
    const settleMs = readCodexAppServerTurnCompletionSettleMs(readRuntimeProcessEnv());
    if (settleMs <= 0) {
      finishPendingTurn(status, notificationParams);
      return;
    }
    scheduledPendingTurnCompletion = { status, notificationParams };
    turnCompletionSettling = true;
    if (pendingTurnCompletionTimer) return;
    pendingTurnCompletionTimer = setTimeout(() => {
      pendingTurnCompletionTimer = null;
      const completion = scheduledPendingTurnCompletion;
      scheduledPendingTurnCompletion = null;
      if (!completion) return;
      finishPendingTurn(completion.status, completion.notificationParams);
    }, settleMs);
  };

  const failPendingTurn = (error: Error, diagnostic = readCodexAppServerTurnFailureDiagnostic(error)): void => {
    const activeTurn = pendingTurn;
    if (!activeTurn || activeTurn.failureSettling) return;
    if (activeTurn.compaction) {
      activeTurn.compaction.finish('failed');
      if (activeTurn.agentTurnId) terminatedProviderTurnIds.set(activeTurn.agentTurnId, activeTurn.sessionTurnId);
      settlePendingTurnAgentTurnIdObservation(activeTurn);
      pendingTurn = null;
      activeTurn.resolve();
      return;
    }
    activeTurn.failureSettling = true;
    publishToolEventsFromNotification('turn/interrupted', { threadId: activeTurn.threadId, turnId: activeTurn.agentTurnId });
    if (activeTurn.agentTurnId) terminatedProviderTurnIds.set(activeTurn.agentTurnId, activeTurn.sessionTurnId);
    clearPendingTurnCompletionTimer();
    flushAssistantReasoningProjection('abort');
    settlePendingTurnAgentTurnIdObservation(activeTurn);
    clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
    clearPendingProviderPrompt(activeTurn.providerPrompt);
    rejectPendingProviderAcceptancesForHostTurn(activeTurn.sessionTurnId, error);
    params.host.logger.warn('Codex app-server turn failed', {
      ...diagnostic,
      providerStartAcknowledged: activeTurn.providerStartAcknowledged,
    });
    const agentTurnId = activeTurn.agentTurnId;
    const settleFailure = (): void => {
      if (pendingTurn !== activeTurn) return;
      pendingTurn = null;
      setActive(false);
      terminalPendingTurnFailure = error;
      const runtimeAuthClassification = sanitizeCodexAppServerRuntimeAuthClassification(
        (error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification,
      );
      publishRuntimeEvent({
        kind: 'turn-failed',
        turnId: activeTurn.sessionTurnId,
        ...(agentTurnId ? { agentTurnId } : {}),
        issue: buildCodexAppServerTurnFailureIssue(terminalPendingTurnFailure, activeTurn),
        ...(runtimeAuthClassification ? { runtimeAuthClassification } : {}),
      });
      activeTurn.reject(error);
    };
    // The host's accepted-turn lifecycle owns recovery. Retain the failed native
    // turn until its quota evidence settles, before either native failure surface
    // can let that host dispose the provider or adopt another account.
    if (isCodexRuntimeAuthQuotaFailure(error)) {
      void publishImmediateProviderAccountUsageSnapshotForQuotaFailure(error).then(settleFailure);
    } else {
      settleFailure();
    }
  };

  const handleTurnCompletedNotification = (notificationParams: unknown): void => {
    const outcome = readCodexTerminalOutcome('turn/completed', notificationParams);
    if (outcome === 'failed') {
      if (!canSettleTerminalPendingTurn(notificationParams)) return;
      const failure = createErrorFromAppServerNotification(
        notificationParams,
        pendingTurn?.providerOperationIdentity ?? null,
      );
      failPendingTurn(failure);
      return;
    }
    completePendingTurn(outcome === 'interrupted' ? 'interrupted' : 'completed', notificationParams);
  };

  const handleTurnInterruptedNotification = (notificationParams: unknown): void => {
    completePendingTurn('interrupted', notificationParams);
  };

  const deferTerminalNotificationUntilTurnStartAcknowledged = (
    method: 'turn/completed' | 'turn/interrupted',
    notificationParams: unknown,
  ): boolean => {
    const activeTurn = pendingTurn;
    if (!activeTurn || activeTurn.agentTurnId || activeTurn.providerStartAcknowledged) return false;
    const terminalTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
      ?? readTurnId(notificationParams);
    if (!terminalTurnId) return false;
    activeTurn.deferredTerminalNotification = { method, params: notificationParams };
    return true;
  };

  const replayDeferredTerminalNotification = (activeTurn: PendingTurn): void => {
    const deferred = activeTurn.deferredTerminalNotification;
    activeTurn.deferredTerminalNotification = null;
    if (!deferred || pendingTurn !== activeTurn) return;
    const terminalTurnId = readProviderEventTurnId(deferred.params, { allowTopLevelId: true })
      ?? readTurnId(deferred.params);
    if (terminalTurnId && activeTurn.agentTurnId && terminalTurnId !== activeTurn.agentTurnId) {
      return;
    }
    if (deferred.method === 'turn/completed') {
      handleTurnCompletedNotification(deferred.params);
      return;
    }
    handleTurnInterruptedNotification(deferred.params);
  };

  const attachClientHandlers = (nextClient: DisposableCodexAppServerClient): void => {
    nextClient.registerNotificationHandler('account/updated', () => {
      currentNativeAuthType = undefined;
      invalidatePromptCacheEvidence();
    });
    nextClient.onNativeEvent((method, notificationParams) => {
      // Admit an owned native start before later receipts arrive, while projection remains ordered.
      if (!disposed && method === 'turn/started' && pendingTurn && !pendingTurn.agentTurnId
        && readThreadId(notificationParams) === pendingTurn.threadId) {
        adoptProviderTurnFromActivity(notificationParams, { allowUnownedAdoption: false });
      }
    });
    nextClient.onExit((result) => {
      if (disposed || unexpectedExitPublished) return;
      unexpectedExitPublished = true;
      const exitDescription = result.signal
        ? `signal ${result.signal}`
        : `exit code ${result.exitCode ?? 'unknown'}`;
      failPendingTurn(new Error(`Codex app-server exited unexpectedly (${exitDescription}).`));
      publishRuntimeEvent({
        kind: 'session-ended',
        reason: 'codex_app_server_unexpected_exit',
      });
    });
    if (params.host.refreshRuntimeAuth) {
      nextClient.registerRequestHandler('account/chatgptAuthTokens/refresh', refreshChatGptAuthTokens);
    }
    handleAsyncQuestionNotification = registerCodexAppServerInteractionHandlers({
      client: nextClient,
      ...(params.host.ui ? { ui: params.host.ui } : {}),
      ...(params.host.mcp ? { mcp: params.host.mcp } : {}),
      ...(params.host.sendUserMessage ? { sendUserMessage: params.host.sendUserMessage } : {}),
      onAsyncQuestionDeliveryError: (error) => {
        params.host.logger.warn('Codex async question reply delivery failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      },
      getThreadId: () => threadId,
      mcpServerKeys,
    });
    nextClient.registerNotificationHandler('account/rateLimits/updated', (notificationParams) => {
      void recordProviderAccountUsageSnapshot(notificationParams, { operationIdentity: null });
    });
    const publishUsageObservation = (observation: CodexTokenUsageRuntimeObservation, notificationParams: unknown, responseBound: boolean): void => {
      const { turnId: nativeTurnId, ...sessionObservation } = observation;
      const hostTurnId = pendingTurn && notificationMatchesPendingTurn(notificationParams)
        ? pendingTurn.sessionTurnId
        : null;
      const attribution = responseBound && hostTurnId ? resolveCodexRequestUsageAttribution({
        turnId: hostTurnId, service: params.connectedAccountService,
        requestIdentity: pendingTurn?.providerOperationIdentity ?? null,
        accountScope: pendingTurn?.providerAccountScope,
        scope: observation.scope, matchesNativeAttempt: Boolean(pendingTurn?.agentTurnId && pendingTurn.agentTurnId === nativeTurnId),
      }) : undefined;
      // An explicit unknown native witness prevents the host from substituting
      // launch credentials for a snapshot or a contradicted response identity.
      const usageAttribution = attribution ?? (hostTurnId ? {
        v: 1 as const, turnId: hostTurnId, source: { kind: 'native' as const, connectedAccount: null },
      } : undefined);
      const usageThreadId = readThreadId(notificationParams);
      const ownedTurn = pendingTurn?.promptCache && !pendingTurn.compaction && usageThreadId === pendingTurn.threadId
        && nativeTurnId === pendingTurn.agentTurnId ? pendingTurn : null;
      const lastUseAtMs = ownedTurn ? resolvePromptCacheLastUseAtMs(ownedTurn.promptCache ?? {})
        : settledPromptCache?.threadId === usageThreadId && settledPromptCache.nativeTurnId === nativeTurnId
          ? settledPromptCache.lastUseAtMs : undefined;
      const ttlMs = lastUseAtMs === undefined ? undefined : resolveCodexPromptCacheTtlMs({
        authType: currentNativeAuthType, modelProvider: currentNativeModelProvider, modelId: currentModelId,
      });
      publishRuntimeEvent({ ...sessionObservation, ...(hostTurnId ? { turnId: hostTurnId } : {}),
        ...(usageAttribution ? { attribution: usageAttribution } : {}),
        ...(lastUseAtMs === undefined ? {} : { promptCache: { lastUseAtMs, ...(ttlMs === undefined ? {} : { ttlMs }) } }),
      });
    };
    if (params.happierSessionId !== undefined) nextClient.registerNotificationHandler('rawResponse/completed', (notificationParams) => {
      const record = readRecord(notificationParams);
      const responseId = trimStringValue(record?.responseId);
      const nativeTurnId = readTurnId(notificationParams);
      const nativeThreadId = readThreadId(notificationParams);
      if (!responseId || !nativeTurnId || !nativeThreadId || nativeThreadId !== threadId
        || !pendingTurn || pendingTurn.agentTurnId !== nativeTurnId) return;
      // Codex rust-v0.160.0/0.162.1 emits exact upstream usage here before its
      // cumulative TokenCount snapshot. The same responseId is persisted in
      // TokenUsageRecord and consumed by native accounting for deduplication.
      // A response's counters do not establish a context-window snapshot.
      const input = buildCodexAppServerTokenCountObservationInput({
        notificationParams: { tokenUsage: { last: record?.usage } },
        modelId: currentModelId, modelSource: params.initialProviderBinding ? 'provider' : 'codex-native',
      });
      if (!input?.runtimeObservation?.tokens) return;
      const { context: _context, ...observation } = input.runtimeObservation;
      publishUsageObservation({ ...observation, source: 'codex-app-server-response-usage',
        observationId: `codex-response:${createHash('sha256').update(JSON.stringify([runtimeTargetId, threadId, responseId])).digest('hex')}`,
        turnId: nativeTurnId,
        accounting: { ...observation.accounting, nativeSessionId: nativeThreadId, inferenceId: responseId, historyComplete: false },
      }, notificationParams, true);
    });
    if (params.happierSessionId !== undefined) nextClient.registerNotificationHandler('thread/tokenUsage/updated', (notificationParams) => {
      if (readThreadId(notificationParams) !== threadId) return;
      handleTokenUsageNotification({
        notificationParams,
        sessionId: runtimeTargetId,
        modelId: currentModelId,
        modelSource: params.initialProviderBinding ? 'provider' : 'codex-native',
        emit(message, observation) {
          publishRuntimeEvent({
            kind: 'transcript-agent-message-committed',
            agentId: 'codex',
            localId: message.id,
            body: message,
            meta: { source: 'codex-app-server-token-usage' },
          });
          if (observation) {
            // Snapshots can be estimated/replayed; even last-only compatibility
            // input cannot certify an exact request. Keep its private counters,
            // context and admitted host correlation without request proof.
            publishUsageObservation(observation, notificationParams, false);
          }
        },
      });
    });
    nextClient.registerNotificationHandler('thread/name/updated', (notificationParams) => {
      applyThreadNameUpdate(notificationParams);
    });
    nextClient.registerNotificationHandler('thread/goal/updated', (notificationParams) => {
      const record = readRecord(notificationParams);
      const notificationThreadId = readThreadId(notificationParams);
      const goal = readRecord(record?.goal);
      if (!params.observeGoal || !threadId || notificationThreadId !== threadId || !goal) return;
      void Promise.resolve(params.observeGoal({ kind: 'present', goal })).catch((error: unknown) => {
        params.host.logger.debug('Codex app-server goal update publication failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    });
    nextClient.registerNotificationHandler('thread/goal/cleared', (notificationParams) => {
      const notificationThreadId = readThreadId(notificationParams);
      if (!params.observeGoal || !threadId || notificationThreadId !== threadId) return;
      // Resume can announce initial absence before loading the retained Goal.
      // The post-resume read below supplies the authoritative initial snapshot.
      if (goalObservationState === 'reading') {
        params.host.logger.debug('Codex app-server goal clear awaits initial read', { threadId });
        return;
      }
      if (goalObservationState === 'unobserved') {
        // A failed initial read did not establish emptiness. Reconcile this
        // notification through the same native read before publishing a clear.
        void readAndPublishGoalSnapshot(nextClient, threadId);
        return;
      }
      void Promise.resolve(params.observeGoal({ kind: 'absent' })).catch((error: unknown) => {
        params.host.logger.debug('Codex app-server goal clear publication failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
    });
    nextClient.registerNotificationHandler('thread/started', nativeChildren.registerProvenance);
    nextClient.registerNotificationHandler('turn/started', (notificationParams): void | Promise<void> => {
      const childNotification = nativeChildren.observe('turn/started', notificationParams);
      if (childNotification) return childNotification;
      adoptProviderTurnFromActivity(notificationParams, {
        allowUnownedAdoption: true,
      });
    });
    nextClient.registerNotificationHandler('turn/completed', (notificationParams): void | Promise<void> => {
      const childNotification = nativeChildren.observe('turn/completed', notificationParams);
      if (childNotification) return childNotification;
      if (deferTerminalNotificationUntilTurnStartAcknowledged('turn/completed', notificationParams)) return;
      handleTurnCompletedNotification(notificationParams);
    });
    nextClient.registerNotificationHandler('turn/interrupted', (notificationParams): void | Promise<void> => {
      const childNotification = nativeChildren.observe('turn/interrupted', notificationParams);
      if (childNotification) return childNotification;
      if (deferTerminalNotificationUntilTurnStartAcknowledged('turn/interrupted', notificationParams)) return;
      handleTurnInterruptedNotification(notificationParams);
    });
    nextClient.registerNotificationHandler('error', (notificationParams): void | Promise<void> => {
      const childNotification = nativeChildren.observe('error', notificationParams);
      if (childNotification) return childNotification;
      const record = readRecord(notificationParams);
      const errorThreadId = readThreadId(notificationParams);
      const errorTurnId = readProviderEventTurnId(notificationParams, { allowTopLevelId: true })
        ?? readTurnId(notificationParams);
      if (!errorThreadId || !errorTurnId) return;
      if (!notificationMatchesPendingTurn(notificationParams)) return;
      const providerError = createErrorFromAppServerNotification(
        notificationParams,
        pendingTurn?.providerOperationIdentity ?? null,
      );
      if (record?.willRetry === true && pendingTurn) {
        assistantReasoningProjector.supersedeUnfinishedAssistantMessages({
          sidechainId: null,
          streamScopeId: pendingTurn.sessionTurnId,
        });
      }
      // App-server `error` is diagnostic and can be followed by more activity
      // for the same native turn even when willRetry is false. Only a provider
      // terminal turn notification can release the active owner; otherwise a
      // later prompt can start a split-brain turn while Codex still owns this one.
      params.host.logger.debug('Codex app-server awaiting terminal notification after provider error', {
        threadId: errorThreadId,
        turnId: errorTurnId,
        willRetry: record?.willRetry === true,
        runtimeIssueSource: resolveCodexRuntimeIssueSource(providerError),
        ...readCodexAppServerTurnFailureDiagnostic(providerError),
        providerErrorSummary: isCodexAppServerWorkspaceRoutingUnauthorizedError(providerError)
          ? CODEX_APP_SERVER_WORKSPACE_ROUTING_ERROR_SUMMARY
          : 'Codex provider error',
      });
    });
    for (const method of [
      'item/agentMessage/delta',
      'turn/diff/updated',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta',
      'item/started',
      'item/completed',
      'rawResponseItem/completed',
    ]) {
      nextClient.registerNotificationHandler(method, (notificationParams): void | Promise<void> => {
        const childNotification = nativeChildren.observe(method, notificationParams);
        if (childNotification) return childNotification;
        const providerTurnId = readProviderEventTurnId(notificationParams);
        if ((method === 'item/completed' || method === 'rawResponseItem/completed')
          && providerTurnId && terminatedProviderTurnIds.has(providerTurnId)) {
          publishToolEventsFromNotification(method, notificationParams);
          return;
        }
        if (!adoptProviderTurnFromActivity(notificationParams, {
          allowUnownedAdoption: method === 'item/agentMessage/delta'
            || method === 'turn/diff/updated'
            || method === 'item/reasoning/summaryTextDelta'
            || method === 'item/reasoning/textDelta'
            || method === 'item/started',
        })) return;
        if (pendingTurn?.compaction) {
          if (method === 'item/started' || method === 'item/completed') {
            const item = readRecord(readRecord(notificationParams)?.item);
            const itemId = trimStringValue(item?.id);
            if (item?.type === 'contextCompaction' && itemId) {
              pendingTurn.compaction.observeItem(itemId, method === 'item/completed');
            }
          }
          return;
        }
        if (method === 'item/started' || method === 'item/completed') {
          const item = readRecord(readRecord(notificationParams)?.item);
          const compactionId = trimStringValue(item?.id);
          if (item?.type === 'contextCompaction' && compactionId) {
            publishRuntimeEvent({ kind: 'context-compaction', compactionId,
              phase: method === 'item/started' ? 'started' : 'completed', trigger: 'unknown',
              ...(pendingTurn?.sessionTurnId ? { turnId: pendingTurn.sessionTurnId } : {}),
            });
          }
          markCorrelatedProviderUserMessageAccepted(notificationParams);
        }
        if (method === 'item/started') {
          publishProviderNativeUserMessage(notificationParams);
        }
        publishGeneratedMediaFromNotification(method, notificationParams);
        publishToolEventsFromNotification(method, notificationParams);
        observeAssistantReasoningNotification(method, notificationParams);
      });
    }
  };

  const ensureClient = async (): Promise<DisposableCodexAppServerClient> => {
    if (disposed) throw new Error('Codex app-server runtime has been disposed.');
    assertToolRestrictionAuthSupported();
    if (client) return client;
    if (!clientPromise) {
      const processEnv = readRuntimeProcessEnv();
      clientPromise = params.host.createClient({
        cwd: params.directory,
        processEnv,
        configOverrides: buildCodexAppServerConfigOverrides(mcpServers, {
          processEnv,
          ...params.toolRestriction,
          mcpToolPolicy: params.mcpToolPolicy,
          ...(params.appServerTransport !== 'daemonProxy' ? { skills: params.skills } : {}),
        }),
        disableUserMcpServers: true,
        toolRestrictionRequired: params.toolRestriction?.unlistedTools === 'deny',
        toolRestrictionAllowedMcpServerKeys: [...mcpServerKeys.values()],
      }).then(async (createdClient) => {
        if (disposed) {
          void createdClient.dispose().catch(() => undefined);
          throw new Error('Codex app-server runtime has been disposed.');
        }
        collaborationModeSelectionCache.clear();
        clientHasExternalAuthTokens = false;
        attachClientHandlers(createdClient);
        if (currentSkills && params.appServerTransport !== 'daemonProxy') {
          try {
            await createdClient.request('skills/extraRoots/set', { extraRoots: [currentSkills.skillsRoot] });
            skillsDelivered = true;
          } catch (error) {
            skillsDelivered = false;
            params.host.logger.warn('Codex session-private skills were not delivered', buildCodexAppServerSafeErrorIdentity(error));
          }
        }
        try {
          if (activeChatGptAuthTokensRefreshSelection && params.host.refreshRuntimeAuth) {
            const authTokens = await readHostOwnedAuthTokens();
            if (authTokens.accessToken && authTokens.accountId) {
              const result = await applyCodexExternalAuthTokens({
                client: createdClient,
                accessToken: authTokens.accessToken,
                accountId: authTokens.accountId,
              });
              if (!result.applied) {
                throw Object.assign(new Error('Codex refresh-free Connected Account authentication failed.'), {
                  code: 'codex_refresh_free_auth_unsupported',
                  reason: result.reason,
                });
              }
              recordAppliedChatGptAccessTokens(authTokens.accessToken, authTokens.accountId);
              latestConnectedServiceRuntimeIdentity = resolveCodexInitialConnectedServiceRuntimeIdentity(
                processEnv, authTokens,
              );
              clientHasExternalAuthTokens = true;
            }
          }
        } catch (error) {
          await createdClient.dispose().catch(() => undefined);
          throw error;
        }
        if (disposed) {
          await createdClient.dispose().catch(() => undefined);
          throw new Error('Codex app-server runtime has been disposed.');
        }
        client = createdClient;
        const operationIdentity = latestConnectedServiceRuntimeIdentity;
        void readCodexRuntimeRateLimitsSnapshot(createdClient)
          .then((result) => recordProviderAccountUsageSnapshot(result.rawSnapshot, { operationIdentity }))
          .catch(() => undefined);
        return createdClient;
      }).catch((error: unknown) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  };

  const resolveCollaborationMode = async (modeId: string): Promise<void> => {
    const normalizedModeId = trimStringValue(modeId);
    if (normalizedModeId === 'default') {
      currentCollaborationModeId = normalizedModeId;
      currentCollaborationModePayload = null;
      return;
    }
    if (!normalizedModeId) {
      throw Object.assign(new Error('Codex collaboration mode is unavailable.'), {
        code: 'codex_collaboration_mode_unavailable',
      });
    }
    const appServerClient = await ensureClient();
    const cacheKey = JSON.stringify([
      normalizedModeId,
      currentModelId,
      currentReasoningEffort,
      latestConnectedServiceRuntimeIdentity?.credentialFingerprint ?? null,
    ]);
    const cachedSelection = collaborationModeSelectionCache.get(cacheKey);
    if (cachedSelection) {
      currentCollaborationModeId = cachedSelection.modeId;
      currentCollaborationModePayload = cachedSelection.payload;
      return;
    }

    const modesResponse = await appServerClient.request('collaborationMode/list', {});
    if (!hasCodexAppServerCollaborationMode(modesResponse, normalizedModeId)) {
      throw Object.assign(new Error('Codex collaboration mode is unavailable.'), {
        code: 'codex_collaboration_mode_unavailable',
      });
    }
    let selection = resolveCodexAppServerCollaborationModeSelection({
      modesResponse,
      modeId: normalizedModeId,
      currentModelId,
      currentReasoningEffort,
    });
    if (!selection) {
      const modelsResponse = await appServerClient.request('model/list', {});
      selection = resolveCodexAppServerCollaborationModeSelection({
        modesResponse,
        modelsResponse,
        modeId: normalizedModeId,
        currentModelId,
        currentReasoningEffort,
      });
    }
    if (!selection) {
      throw Object.assign(new Error('Codex collaboration mode is unavailable.'), {
        code: 'codex_collaboration_mode_unavailable',
      });
    }
    collaborationModeSelectionCache.set(cacheKey, selection);
    currentCollaborationModeId = selection.modeId;
    currentCollaborationModePayload = selection.payload;
  };

  const waitForConnectedServiceAuthApply = async (): Promise<void> => {
    while (connectedServiceAuthApplyCount > 0) {
      await connectedServiceAuthApplyTail;
    }
  };

  const runConnectedServiceAuthApply = async <T>(apply: () => Promise<T>): Promise<T> => {
    const previousApply = connectedServiceAuthApplyTail;
    let release!: () => void;
    connectedServiceAuthApplyTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    connectedServiceAuthApplyCount += 1;
    await previousApply;
    try {
      invalidatePendingProviderOperationIdentity();
      return await apply();
    } finally {
      connectedServiceAuthApplyCount -= 1;
      release();
    }
  };

  const openSessionOnce = async (options?: Readonly<Record<string, unknown>>): Promise<string> => {
    goalObservationState = 'reading';
    assertToolRestrictionAuthSupported();
    const authTokens = await readHostOwnedAuthTokens();
    const hasLiveExternalAuth = client !== null && clientHasExternalAuthTokens;
    if (activeChatGptAuthTokensRefreshSelection
      && (!params.host.refreshRuntimeAuth || (!hasLiveExternalAuth && (!authTokens.accessToken || !authTokens.accountId)))) {
      throw Object.assign(new Error('Codex refresh-free Connected Account authentication is unavailable.'), {
        code: 'codex_refresh_free_auth_unsupported',
        reason: !params.host.refreshRuntimeAuth ? 'refresh_bridge_unavailable' : 'provider_account_identity_unavailable',
      });
    }
    if (!hasLiveExternalAuth) {
      activeChatGptAccessTokenFingerprint = computeCodexAccessTokenFingerprint(
        authTokens.accessToken ?? authTokens.idToken,
      );
    }
    latestConnectedServiceRuntimeIdentity ??= resolveCodexInitialConnectedServiceRuntimeIdentity(
      readRuntimeProcessEnv(),
      authTokens,
    );
    const appServerClient = await ensureClient();
    const resumeId = readResumeId(options);
    const existingSessionId = trimStringValue(options?.existingSessionId);
    const requestedThreadId = resumeId ?? existingSessionId;
    const preserveRequestedThreadId = options?.preserveRequestedThreadId === true;
    const strictRequestedThreadId = requestedThreadId
      && options?.strictNativeResumeIdentity === true
      ? requestedThreadId
      : null;
    if (requestedThreadId && !preserveRequestedThreadId && !strictRequestedThreadId) {
      publishThreadIdentity(requestedThreadId, true);
    }
    const policy = resolveCurrentPolicy();
    const policyKey = serializeCodexAppServerPolicy(policy);
    const permissionFields = buildCodexAppServerPermissionParams({
      policy,
      support: permissionSupport,
      target: 'thread',
    });
    const effectiveReasoningEffort = providerDisablesReasoning ? 'none' : currentReasoningEffort;
    const reasoningConfig = buildThreadConfigOverrideParams(effectiveReasoningEffort).config ?? {};
    const providerConfig = params.initialProviderBinding?.config ?? {};
    const threadConfig = { ...reasoningConfig, ...providerConfig };
    const commonFields = {
      ...(currentModelId ? { model: currentModelId } : {}),
      ...(params.initialProviderBinding
        ? { modelProvider: params.initialProviderBinding.modelProvider }
        : {}),
      ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
      ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
      ...permissionFields,
      ...(options?.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
    };
    const requestWithPermissionFallback = async (
      method: 'thread/start' | 'thread/resume',
      requestParams: Record<string, unknown>,
      target: CodexAppServerPermissionTarget,
      requestOptions?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
      try {
        const result = await appServerClient.request(method, requestParams, requestOptions);
        if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
          permissionSupport = 'supported';
        }
        return result;
      } catch (error) {
        if (!policy || !shouldRetryWithoutCodexAppServerPermissionProfile(error, requestParams)) {
          throw error;
        }
        permissionSupport = 'legacy';
        const retryParams = { ...requestParams };
        delete retryParams.permissions;
        return await appServerClient.request(method, {
          ...retryParams,
          ...buildCodexAppServerLegacyPermissionParams({ policy, target }),
        }, requestOptions);
      }
    };
    const readResumedThreadMetadata = async (
      nextThreadId: string,
      requestOptions?: CodexAppServerRequestOptions,
    ): Promise<unknown> => {
      const startedAt = Date.now();
      params.host.logger.debug('Reading lean Codex app-server thread metadata after oversized resume response', {
        threadId: nextThreadId,
        timeoutMs: requestOptions?.timeoutMs ?? null,
      });
      try {
        const result = await appServerClient.request('thread/read', {
          threadId: nextThreadId,
          includeTurns: false,
        }, requestOptions);
        params.host.logger.debug('Completed lean Codex app-server thread metadata read after oversized resume response', {
          threadId: nextThreadId,
          elapsedMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        params.host.logger.debug('Failed lean Codex app-server thread metadata read after oversized resume response', {
          threadId: nextThreadId,
          elapsedMs: Date.now() - startedAt,
          ...buildCodexAppServerSafeErrorIdentity(error),
        });
        throw error;
      }
    };
    const resumeThread = async (nextThreadId: string): Promise<unknown> => {
      const resumeRequestOptions = { timeoutMs: null } as const;
      const recoveryReadRequestOptions = options?.importHistory === true
        ? undefined
        : { timeoutMs: readCodexAppServerResumeRecoveryTimeoutMs(readRuntimeProcessEnv()) };
      try {
        return await requestWithPermissionFallback('thread/resume', {
          threadId: nextThreadId,
          cwd: params.directory,
          ...commonFields,
          persistExtendedHistory: true,
          excludeTurns: options?.importHistory !== true,
        }, 'thread', resumeRequestOptions);
      } catch (error) {
        if (isCodexAppServerApplicationRejectionForMethod(error, 'thread/resume')
          && error instanceof Error && /\bno rollout found\b/i.test(error.message)) {
          throw Object.assign(new Error('Provider session state is missing; the original thread cannot be resumed.'), {
            code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' as const,
          });
        }
        if (options?.importHistory === true || !isCodexAppServerOversizedJsonFrameError(error)) {
          throw error;
        }
        return await readResumedThreadMetadata(nextThreadId, recoveryReadRequestOptions);
      }
    };
    const response = requestedThreadId
      ? await resumeThread(requestedThreadId)
      : await requestWithPermissionFallback('thread/start', {
        cwd: params.directory,
        ...commonFields,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
        }, 'thread').catch((error: unknown) => {
          if (!isCodexAppServerApplicationRejectionForMethod(error, 'thread/start')) throw error;
          const failure = createCodexAppServerTurnFailure({
            value: error,
            sourceAccountIdentity: latestConnectedServiceRuntimeIdentity,
            providerStartRejected: turnSeq === 0 && pendingTurn === null,
          });
          throw isCodexAppServerRejectedStartModelEntitlementError(failure) ? failure : error;
        });
    const observedThreadId = readThreadId(response);
    if (
      strictRequestedThreadId
      && observedThreadId
      && observedThreadId !== strictRequestedThreadId
    ) {
      throw new CodexAppServerResumeIdentityMismatchError(
        strictRequestedThreadId,
        observedThreadId,
      );
    }
    const nextThreadId = strictRequestedThreadId || preserveRequestedThreadId
      ? requestedThreadId
      : observedThreadId ?? requestedThreadId;
    if (!nextThreadId) {
      throw new Error('Codex app-server thread/start returned no thread id');
    }
    threadId = nextThreadId;
    startedEmptyThreadWithoutExplicitModel = !requestedThreadId && !Object.prototype.hasOwnProperty.call(commonFields, 'model');
    startedEmptyThreadPolicyKey = requestedThreadId ? null : policyKey;
    currentModelId = readModelId(response) ?? currentModelId;
    const nextNativeModelProvider = trimStringValue(readRecord(response)?.modelProvider);
    if (currentNativeModelProvider !== nextNativeModelProvider) invalidatePromptCacheEvidence();
    currentNativeModelProvider = nextNativeModelProvider;
    if (requiresConfinedMcp) {
      assertCodexToolRestrictionModelSupported(await ensureClient(), currentModelId);
    }
    currentServiceTier = readServiceTier(response) ?? (hasServiceTierOverride ? currentServiceTier : null);
    if (modelsBinding) {
      const observedModelId = readModelId(response) ?? trimStringValue(commonFields.model);
      const controls = await readCodexAppServerSessionControls({ client: appServerClient,
        currentModelId: observedModelId, currentModeId: currentCollaborationModeId,
        currentReasoningEffort, currentServiceTier });
      if (!disposed && client === appServerClient && controls.modelsObserved) {
        modelsSnapshot = { models: controls.availableModels, observedAt: Date.now(), currentModelId: observedModelId ?? controls.currentModelId };
        for (const listener of modelListeners) listener(modelsSnapshot);
      }
    }
    if (requestedThreadId) {
      if (params.observeGoal) {
        await readAndPublishGoalSnapshot(appServerClient, nextThreadId);
      }
      nativeReadyThreadId = nextThreadId;
      publishThreadIdentity(nextThreadId);
    } else {
      goalObservationState = 'observed';
    }
    return nextThreadId;
  };

  const openSession = async (options?: Readonly<Record<string, unknown>>): Promise<string> => {
    let retryDelayMs = CODEX_APP_SERVER_STATE_RUNTIME_RETRY_INITIAL_DELAY_MS;
    while (true) {
      try {
        return await openSessionOnce(options);
      } catch (error) {
        if (disposed || !isCodexAppServerStateRuntimeInitializationFailure(error)) {
          throw error;
        }
        params.host.logger.debug('Retrying Codex app-server session startup after shared state runtime initialization failed', {
          retryDelayMs,
        });
        await delay(retryDelayMs);
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          CODEX_APP_SERVER_STATE_RUNTIME_RETRY_MAX_DELAY_MS,
        );
      }
    }
  };

  const ensureThreadId = async (requestedSessionId?: string | null): Promise<string> => {
    const requested = readExactCodexProviderSessionId(requestedSessionId);
    const readyThreadId = threadId && (!requested || requested === threadId)
      ? threadId
      : await openSession(requested ? { existingSessionId: requested, importHistory: false } : undefined);
    if (requiresConfinedMcp) {
      assertCodexToolRestrictionModelSupported(await ensureClient(), currentModelId);
    }
    return readyThreadId;
  };

  const prepareProviderCliAttach = async (): Promise<string> => {
    const attachedThreadId = await ensureThreadId();
    if (nativeReadyThreadId !== attachedThreadId) {
      const appServerClient = await ensureClient();
      await appServerClient.request('thread/name/set', {
        threadId: attachedThreadId,
        name: nativeAttachmentThreadName,
      });
      // A fresh paginated Codex thread needs metadata and a full read to
      // persist its zero-turn rollout before another client can resume it.
      const snapshot = await appServerClient.request('thread/read', {
        threadId: attachedThreadId,
        includeTurns: true,
      });
      if (readThreadId(snapshot) !== attachedThreadId || threadId !== attachedThreadId) {
        throw new Error('Codex native attachment materialized a different thread');
      }
      nativeReadyThreadId = attachedThreadId;
    }
    publishThreadIdentity(attachedThreadId);
    return attachedThreadId;
  };

  const realtimeConversation = createCodexAppServerRealtimeConversation({
    getClient: ensureClient,
    getThreadId: () => threadId,
    onThreadAccepted: publishThreadIdentity,
    isDisposed: () => disposed,
    isRuntimeExited: () => unexpectedExitPublished,
    settlementTimeoutMs: readCodexAppServerRealtimeStartTimeoutMs(readRuntimeProcessEnv()),
  });

  const startTurnPromptAttempt = async (
    input: CodexAppServerInput,
    options?: CodexAppServerSendOptions,
  ): Promise<void | CodexAppServerSendResult> => {
    const prompt = input.text;
    let activeThreadId: string;
    let appServerClient: DisposableCodexAppServerClient;
    try {
      await waitForConnectedServiceAuthApply();
      activeThreadId = await ensureThreadId();
      await waitForConnectedServiceAuthApply();
      if (pendingTurn) throw new Error('Codex app-server already has a turn in flight');
      appServerClient = await ensureClient();
      await waitForConnectedServiceAuthApply();
      if (pendingTurn) throw new Error('Codex app-server already has a turn in flight');
    } catch (error) {
      // Host Exec evidence describes this launch only. This preparation boundary
      // additionally proves that this input has not reached turn/start.
      if (isPluginError(error) && error.execLaunch === 'notStarted' && error.data.execLaunch === 'notStarted') {
        return { status: 'rejected', diagnosticCode: error.code, retryable: error.retryable,
          diagnostic: 'Native process launch was refused before input dispatch.' };
      }
      throw error;
    }
    const pendingProviderPrompt = trackPendingProviderPrompt(prompt, options);
    turnSeq += 1;
    const activeTurn = createPendingTurn(
      activeThreadId,
      readRuntimeTurnId(options) ?? createCodexAppServerTurnId(),
      pendingProviderPrompt,
      null,
    );
    activeTurn.promptCache = { turnStartedAtMs: Date.now() };
    settledPromptCache = null;
    pendingTurn = activeTurn;
    terminalPendingTurnFailure = null;
    void activeTurn.promise.catch(() => undefined);
    setActive(true);
    publishRuntimeEvent({
      kind: 'turn-start',
      turnId: activeTurn.sessionTurnId,
      startedBy: 'user',
    });
    try {
      if (currentCollaborationModeId && !currentCollaborationModePayload) {
        await resolveCollaborationMode(currentCollaborationModeId);
      }
      const policy = resolveCurrentPolicy();
      const effectiveReasoningEffort = providerDisablesReasoning ? 'none' : currentReasoningEffort;
      const turnInput = buildCodexAppServerTurnInput({
        text: prompt,
        ...(input.structuredInput === undefined ? {} : { structuredInput: input.structuredInput }),
      });
      const requestParams: Record<string, unknown> = {
        ...buildCodexAppServerPermissionParams({
          policy,
          support: permissionSupport,
          target: 'turn',
        }),
        threadId: activeThreadId,
        input: turnInput,
        ...(pendingProviderPrompt.localInputIds[0]
          ? { clientUserMessageId: pendingProviderPrompt.localInputIds[0] }
          : {}),
        ...(currentModelId ? { model: currentModelId } : {}),
        ...(effectiveReasoningEffort ? { effort: effectiveReasoningEffort } : {}),
        ...(hasServiceTierOverride
          ? (currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null })
          : {}),
        ...(currentCollaborationModePayload
          ? {
              collaborationMode: {
                ...currentCollaborationModePayload,
                settings: {
                  ...currentCollaborationModePayload.settings,
                  ...(currentModelId ? { model: currentModelId } : {}),
                  ...(currentReasoningEffort ? { reasoning_effort: currentReasoningEffort } : {}),
                },
              },
            }
          : {}),
      };
      const captureRequestAccount = async (): Promise<void> => {
        // Capture at native dispatch, after collaboration resolution and auth
        // applications that settled while that resolution was awaiting.
        await waitForConnectedServiceAuthApply();
        const identity = latestConnectedServiceRuntimeIdentity;
        activeTurn.providerOperationIdentity = identity;
        activeTurn.providerAccountScope = undefined;
        if (!params.connectedAccountService || !identity) return;
        const liveAccount = await readLiveProviderAccount();
        await waitForConnectedServiceAuthApply();
        // Refresh/apply invalidates the incumbent attempt, even if application
        // fails or returns to A. Never restore it from a later read/end state.
        if (activeTurn.providerOperationIdentity !== identity
          || isCodexRequestUsageIdentityContradicted(identity, liveAccount)) {
          activeTurn.providerOperationIdentity = null;
          return;
        }
        activeTurn.providerAccountScope = liveAccount?.accountScope;
      };
      const requestTurnStart = async (params: Record<string, unknown>): Promise<unknown> => {
        await captureRequestAccount();
        activeTurn.nativePermissionPolicyKey = serializeCodexAppServerPolicy(policy);
        return await appServerClient.request('turn/start', params)
          .then((result) => {
            if (Object.prototype.hasOwnProperty.call(params, 'permissions')) {
              permissionSupport = 'supported';
            }
            return result;
          })
          .catch(async (error: unknown) => {
            if (!policy || !shouldRetryWithoutCodexAppServerPermissionProfile(error, params)) {
              throw error;
            }
            permissionSupport = 'legacy';
            const retryParams = { ...params };
            delete retryParams.permissions;
            await captureRequestAccount();
            return await appServerClient.request('turn/start', {
              ...retryParams,
              ...buildCodexAppServerLegacyPermissionParams({ policy, target: 'turn' }),
            });
          });
      };
      const response = await requestTurnStart(requestParams);
      publishCurrentModel(readModelId(response) ?? trimStringValue(requestParams.model));
      const agentTurnId = readTurnId(response);
      nativeReadyThreadId = activeTurn.threadId;
      publishThreadIdentity(activeTurn.threadId);
      activeTurn.providerStartAcknowledged = true;
      if (activeTurn.interruptWhenProviderTurnIdArrives) {
        if (agentTurnId) {
          terminatedProviderTurnIds.set(agentTurnId, activeTurn.sessionTurnId);
          await requestCodexTurnInterruptWithStartupRetry({
            client: appServerClient,
            threadId: activeTurn.threadId,
            turnId: agentTurnId,
          }).catch((error: unknown) => {
            params.host.logger.debug('Codex app-server late turn interrupt failed after cancellation', {
              errorName: error instanceof Error ? error.name : typeof error,
            });
          });
        }
        preAckCancelledTurns.delete(activeTurn);
        return;
      }
      if (agentTurnId && observePendingTurnAgentTurnId(activeTurn, agentTurnId)) {
        publishRuntimeEvent({
          kind: 'turn-agent-id-observed',
          turnId: activeTurn.sessionTurnId,
          agentTurnId,
        });
      }
      publishSkillMentions(activeTurn, turnInput);
      replayDeferredTerminalNotification(activeTurn);
      clearPendingProviderPrompt(pendingProviderPrompt);
    } catch (error) {
      preAckCancelledTurns.delete(activeTurn);
      const classifiedFailure = isCodexAppServerApplicationRejectionForMethod(error, 'turn/start')
        ? createCodexAppServerTurnFailure({
            value: error,
            sourceAccountIdentity: activeTurn.providerOperationIdentity,
            providerStartRejected: pendingTurn === activeTurn
              && !activeTurn.providerStartAcknowledged
              && activeTurn.agentTurnId === null
              && activeTurn.deferredTerminalNotification === null,
          })
        : null;
      const failure = isCodexAppServerRejectedStartModelEntitlementError(classifiedFailure)
        ? classifiedFailure
        : error instanceof Error ? error : new Error(String(error));
      failPendingTurn(failure, readCodexAppServerTurnFailureDiagnostic(classifiedFailure ?? failure));
      throw failure;
    }
  };

  const sendTurnPrompt = async (
    input: CodexAppServerInput,
    options?: CodexAppServerSendOptions,
  ): Promise<void | CodexAppServerSendResult> => {
    terminalPendingTurnFailure = null;
    return await startTurnPromptAttempt(input, options);
  };

  const waitForTurnCompletion = async (): Promise<void> => {
    const activeTurn = pendingTurn;
    if (activeTurn) {
      await activeTurn.promise;
      return;
    }
    const terminalFailure = terminalPendingTurnFailure;
    if (terminalFailure) {
      terminalPendingTurnFailure = null;
      throw terminalFailure;
    }
  };

  const observeCompletionInBackground = (submitted: Promise<void | CodexAppServerSendResult>): void => {
    backgroundCompletion = submitted.then(() => waitForTurnCompletion());
    void backgroundCompletion.catch((error: unknown) => {
      params.host.logger.debug(
        'Codex app-server background turn completion failed',
        buildCodexAppServerBackgroundCompletionFailureDiagnostics(error),
      );
    });
  };

  const waitForActiveProviderTurnId = async (activeTurn: PendingTurn): Promise<string | null> => {
    return activeTurn.agentTurnId ?? await activeTurn.agentTurnIdObservation.promise;
  };

  const steerInFlightTurn = async (
    input: CodexAppServerInput,
    options?: CodexAppServerSendOptions,
  ): Promise<void> => {
    const message = input.text;
    const activeTurn = pendingTurn;
    if (!activeTurn) throw new Error('Codex app-server steer requires an active turn');
    const assertActiveTurnSteerable = (): void => {
      if (pendingTurn !== activeTurn || turnCompletionSettling) {
        throw new Error('Codex app-server steer requires an active provider turn');
      }
    };
    const agentTurnId = await waitForActiveProviderTurnId(activeTurn);
    assertActiveTurnSteerable();
    if (!agentTurnId) throw new Error('Codex app-server steer requires an active provider turn id');
    const appServerClient = await ensureClient();
    assertActiveTurnSteerable();
    const userMessageSeq = readRuntimeUserMessageSeq(options);
    const pendingProviderPrompt = trackPendingProviderPrompt(message, options, true);
    const clientUserMessageId = pendingProviderPrompt.localInputIds[0] ?? null;
    const steerInput = buildCodexAppServerTurnInput({
      text: message,
      ...(input.structuredInput === undefined ? {} : { structuredInput: input.structuredInput }),
    });
    const requestSteer = async (turnInput: CodexAppServerTurnInputItem[]): Promise<void> => {
      assertActiveTurnSteerable();
      await appServerClient.request('turn/steer', {
        threadId: activeTurn.threadId,
        input: turnInput,
        expectedTurnId: agentTurnId,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      });
    };
    try {
      await requestSteer(steerInput);
    } catch (error) {
      const steerError = error instanceof Error ? error : new Error(String(error));
      clearPendingProviderPrompt(pendingProviderPrompt, steerError);
      throw error;
    }
    await pendingProviderPrompt.providerAcceptance?.promise;
    publishSkillMentions(activeTurn, steerInput);
    clearPendingProviderPrompt(pendingProviderPrompt);
    for (const seq of pendingProviderPrompt.userMessageSeqs) {
      appendRollbackUserMessageSeq(activeTurn, seq);
    }
    publishRuntimeEvent({
      kind: 'turn-input-appended',
      turnId: activeTurn.sessionTurnId,
      agentTurnId,
      ...(userMessageSeq === null ? {} : { userMessageSeq }),
    });
  };

  const cancelTurn = async (): Promise<void> => {
    const activeTurn = pendingTurn;
    if (!activeTurn) {
      setActive(false);
      return;
    }
    const agentTurnId = activeTurn.agentTurnId;
    if (!agentTurnId) {
      activeTurn.interruptWhenProviderTurnIdArrives = true;
      preAckCancelledTurns.add(activeTurn);
      clearPendingTurnCompletionTimer();
      flushAssistantReasoningProjection('abort');
      settlePendingTurnAgentTurnIdObservation(activeTurn);
      pendingTurn = null;
      clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
      clearPendingProviderPrompt(activeTurn.providerPrompt);
      rejectPendingProviderAcceptancesForHostTurn(
        activeTurn.sessionTurnId,
        new Error('Codex provider turn was cancelled before correlated user-message acceptance was observed'),
      );
      if (activeTurn.compaction) activeTurn.compaction.finish('cancelled');
      else publishRuntimeEvent({ kind: 'turn-cancelled', turnId: activeTurn.sessionTurnId });
      activeTurn.resolve();
      setActive(false);
      return;
    }
    const appServerClient = await ensureClient();
    params.host.logger.debug('Codex app-server turn interrupt requested', {
      turnId: activeTurn.sessionTurnId,
      threadId: activeTurn.threadId,
      agentTurnId,
    });
    const interrupt = await requestCodexTurnInterruptWithStartupRetry({
      client: appServerClient,
      threadId: activeTurn.threadId,
      turnId: agentTurnId,
      waitForProviderTerminal: async (waitKind) => {
        if (
          pendingTurn === activeTurn
          && turnCompletionSettling
          && scheduledPendingTurnCompletion !== null
        ) {
          await activeTurn.promise.catch(() => undefined);
          return true;
        }
        return await waitForPromiseSettlementWithin(
          activeTurn.promise,
          waitKind === 'startup_gap'
            ? CODEX_APP_SERVER_CANCEL_STARTUP_RETRY_INTERVAL_MS
            : readCodexAppServerRpcTimeoutMs(readRuntimeProcessEnv()),
        );
      },
    });
    params.host.logger.debug('Codex app-server turn interrupt request settled', {
      turnId: activeTurn.sessionTurnId,
      agentTurnId,
      outcome: interrupt,
    });
    if (interrupt === 'providerTerminal') return;
    await activeTurn.promise.catch(() => undefined);
    params.host.logger.debug('Codex app-server turn settled after interrupt', {
      turnId: activeTurn.sessionTurnId,
      agentTurnId,
    });
  };

  const rollbackNativeConversation = async (
    request: AgentSessionConversationRollbackRequest,
  ): Promise<AgentSessionConversationRollbackResult> => {
    if (!threadId || threadId !== request.providerSessionId || pendingTurn || turnCompletionSettling) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: { code: 'codex_rollback_session_unavailable', severity: 'error' },
      };
    }
    const providerCheckpoints = request.affectedTurns.map((turn) => trimStringValue(turn.providerCheckpoint));
    const beforeTurnId = providerCheckpoints[0] ?? null;
    if (!beforeTurnId || providerCheckpoints.some((checkpoint) => !checkpoint)) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: { code: 'codex_rollback_checkpoint_unavailable', severity: 'error' },
      };
    }
    try {
      const appServerClient = await ensureClient();
      try {
        await appServerClient.request('thread/revert', { threadId, beforeTurnId });
      } catch (error) {
        if (!isCodexAppServerDefinitiveMethodNotFoundError(error, 'thread/revert')) throw error;
        await appServerClient.request('thread/rollback', {
          threadId,
          numTurns: request.affectedTurns.length,
        });
      }
      return { status: 'applied' };
    } catch {
      return {
        status: 'outcomeUnknown',
        diagnostic: { code: 'codex_rollback_outcome_unknown', severity: 'error' },
      };
    }
  };

  const reconcileNativeConversationRollback = async (
    request: AgentSessionConversationRollbackRequest,
  ): Promise<AgentSessionConversationRollbackReconciliationResult> => {
    if (!threadId || threadId !== request.providerSessionId) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: { code: 'codex_rollback_session_unavailable', severity: 'error' },
      };
    }
    const providerTurnIds = request.affectedTurns.map((turn) => trimStringValue(turn.providerCheckpoint));
    if (providerTurnIds.some((checkpoint) => !checkpoint)) {
      return {
        status: 'unavailable',
        retryable: false,
        diagnostic: { code: 'codex_rollback_checkpoint_unavailable', severity: 'error' },
      };
    }
    try {
      const client = await ensureClient();
      const affected = new Set(providerTurnIds as string[]);
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        const response = readRecord(await client.request('thread/turns/list', {
          threadId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }));
        for (const turn of Array.isArray(response?.data) ? response.data : []) {
          const id = trimStringValue(readRecord(turn)?.id);
          if (id && affected.has(id)) return { status: 'notApplied' };
        }
        const nextCursor = trimStringValue(response?.nextCursor);
        if (!nextCursor) return { status: 'applied' };
        if (seenCursors.has(nextCursor)) throw new Error('Codex thread turn pagination repeated a cursor');
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } catch {
      return {
        status: 'unavailable',
        retryable: true,
        diagnostic: { code: 'codex_rollback_reconciliation_failed', severity: 'error' },
      };
    }
  };

  const resetOrDisposeRuntime = async (): Promise<void> => {
    disposed = true;
    modelsBinding?.dispose();
    modelListeners.clear();
    await realtimeConversation.dispose();
    clearAllPendingProviderPrompts(new Error('Codex runtime disposed before provider input acceptance was observed'));
    const activeTurn = pendingTurn;
    clearPendingTurnCompletionTimer();
    flushAssistantReasoningProjection('abort');
    activeTurn?.compaction?.finish('cancelled');
    if (activeTurn) settlePendingTurnAgentTurnIdObservation(activeTurn);
    pendingTurn = null;
    if (activeTurn) clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
    activeTurn?.resolve();
    terminalPendingTurnFailure = null;
    toolEventProjector.clear();
    terminatedProviderTurnIds.clear();
    settledPromptCache = null;
    preAckCancelledTurns.clear();
    pendingHappierTitleToolNamesByCallId.clear();
    publishedGeneratedMediaItemIds.clear();
    runtimeSubscribers.clear();
    threadId = null;
    active = false;
    lastActivityAtMs = null;
    backgroundCompletion = null;
    activeChatGptAuthTokensRefreshSelection = null;
    appliedChatGptAccessTokens = null;
    latestConnectedServiceRuntimeIdentity = null;
    const currentClient = client;
    client = null;
    clientPromise = null;
    collaborationModeSelectionCache.clear();
    publishedThreadId = null;
    nativeReadyThreadId = null;
    startedEmptyThreadPolicyKey = null;
    let disposeHost = Promise.resolve();
    if (!hostDisposed && params.host.dispose) {
      hostDisposed = true;
      disposeHost = params.host.dispose();
    }
    await Promise.all([
      currentClient?.dispose() ?? Promise.resolve(),
      disposeHost,
    ]);
  };

  const buildConnectedServiceRuntimeIdentity = (
    request: CodexConnectedServiceAuthGenerationRequest,
    providerAccountId: string,
    accountLabel: string | null,
  ): CodexConnectedServiceRuntimeIdentity => ({
    serviceId: 'openai-codex',
    providerAccountId,
    accountLabel,
    source: 'applied_credential',
    profileId: resolveCodexAppliedProfileId({
      credential: request.credential,
      selection: request.selection,
      expected: request.expected,
    }),
    groupId: resolveCodexAppliedGroupId({
      selection: request.selection,
      expected: request.expected,
    }),
    generation: resolveCodexAppliedGeneration({
      selection: request.selection,
      expected: request.expected,
    }),
    credentialFingerprint: computeCodexAccessTokenFingerprint(request.credential.oauth.accessToken),
    credentialRevision: request.credentialRevision,
  });

  const buildConnectedServiceApplicationVerification = (
    identity: CodexConnectedServiceRuntimeIdentity,
  ) => ({
    activeAccountId: identity.providerAccountId,
    providerAccountId: identity.providerAccountId,
    proofStrength: 'exact' as const,
    source: 'applied_credential',
    ...(identity.groupId
      && identity.generation !== null
      && identity.credentialRevision
      && identity.credentialFingerprint
      ? {
          generationApplication: {
            serviceId: identity.serviceId,
            groupId: identity.groupId,
            profileId: identity.profileId,
            generation: identity.generation,
            credentialRevision: identity.credentialRevision,
            credentialFingerprint: identity.credentialFingerprint,
          },
        }
      : {}),
  });

  const applyRuntimeAuth = async (
    rawRequest: AgentSessionRuntimeAuthApplyRequest,
  ): Promise<AgentSessionRuntimeAuthApplyResult> => await runConnectedServiceAuthApply(async () => {
    const request = normalizeCodexConnectedServiceAuthGenerationRequest(rawRequest);
    if (!request) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      };
    }
    if (!params.host.refreshRuntimeAuth) {
      return { ok: false, errorCode: 'codex_refresh_free_auth_unsupported', error: 'refresh_bridge_unavailable' };
    }
    const appServerClient = await ensureClient();
    const applied = await applyCodexConnectedServiceAuthGeneration({
      client: appServerClient,
      candidate: request.credential,
      forcedWorkspaceId: request.forcedWorkspaceId,
      forcedLoginMethod: request.forcedLoginMethod,
      refreshSelection: request.selection,
      updateRefreshSelection: async (selection) => {
        const previousSelection = activeChatGptAuthTokensRefreshSelection;
        activeChatGptAuthTokensRefreshSelection = selection;
        return () => {
          activeChatGptAuthTokensRefreshSelection = previousSelection;
        };
      },
    });
    if (!applied.applied) {
      if (applied.appliedVia === 'direct_live_hot_auth' && applied.activeAccountId) {
        recordAppliedChatGptAccessTokens(request.credential.oauth.accessToken, applied.activeAccountId);
        latestConnectedServiceRuntimeIdentity = buildConnectedServiceRuntimeIdentity(
          request,
          applied.activeAccountId,
          null,
        );
      }
      return {
        ok: false,
        errorCode: applied.reason,
        error: applied.reason,
        ...(applied.appliedVia ? { appliedVia: applied.appliedVia } : {}),
        ...(applied.activeAccountId ? { activeAccountId: applied.activeAccountId } : {}),
      };
    }
    if (disposed) {
      return {
        ok: false,
        errorCode: 'runtime_replaced_during_auth_apply',
        error: 'runtime_replaced_during_auth_apply',
        appliedVia: applied.appliedVia,
        activeAccountId: applied.activeAccountId,
      };
    }

    recordAppliedChatGptAccessTokens(request.credential.oauth.accessToken, applied.activeAccountId);
    clientHasExternalAuthTokens = true;
    const appliedRuntimeIdentity = buildConnectedServiceRuntimeIdentity(
      request,
      applied.activeAccountId,
      null,
    );
    latestConnectedServiceRuntimeIdentity = appliedRuntimeIdentity;
    // Exact provider application and durable auth-store persistence settle the
    // auth operation. The canonical account-usage owner performs the optional
    // live-account verification and quota publication afterward, fenced by the
    // exact identity that was just applied. A slow diagnostic must not turn a
    // successful in-process hot swap into a restart-required fan-out result.
    void (async () => {
      try {
        const result = await readCodexRuntimeRateLimitsSnapshot(appServerClient);
        await recordProviderAccountUsageSnapshot(result.rawSnapshot, {
          operationIdentity: appliedRuntimeIdentity,
          includeLiveAccountIdentity: true,
        });
      } catch (error) {
        params.host.logger.debug('Codex app-server quota snapshot failed after connected-service auth apply (ignored)', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    })();

    return {
      ok: true,
      appliedVia: applied.appliedVia,
      activeAccountId: applied.activeAccountId,
      verification: buildConnectedServiceApplicationVerification(appliedRuntimeIdentity),
    };
  });

  const readRuntimeAuthIdentity = async (
    request: AgentSessionRuntimeAuthIdentityRequest,
  ): Promise<AgentSessionRuntimeAuthIdentityResult> => {
    const record = readRecord(request);
    if (record?.serviceId !== 'openai-codex') {
      return {
        ok: false,
        errorCode: 'runtime_identity_probe_unavailable',
        error: 'runtime_identity_probe_unavailable',
      };
    }
    let identity = latestConnectedServiceRuntimeIdentity;
    if (identity && !runtimeIdentityMatchesActiveSelection(identity)) {
      identity = await refreshLiveAccountRuntimeIdentity();
    }
    if (!identity) {
      identity = await refreshLiveAccountRuntimeIdentity();
      if (!identity) {
        return {
          ok: false,
          errorCode: 'runtime_identity_probe_unavailable',
          error: 'runtime_identity_probe_unavailable',
        };
      }
    }
    return {
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: identity.providerAccountId,
        ...(identity.accountLabel ? { accountLabel: identity.accountLabel } : {}),
        source: identity.source,
      },
      runtime: {
        safeToProbe: true,
        // Codex owns an in-process account/login/start hot-auth boundary. Keep
        // turn state visible, but never reinterpret it as a restart/defer gate.
        safeToApply: true,
        inProviderTurn: pendingTurn !== null,
        profileId: identity.profileId,
        ...(identity.groupId ? { groupId: identity.groupId } : {}),
        ...(identity.generation === null ? {} : { generation: identity.generation }),
        ...(identity.credentialRevision ? { credentialRevision: identity.credentialRevision } : {}),
      },
    };
  };

  const runtime: CodexAppServerRuntime = {
    goals: createCodexGoalControl(params.goalProjection ?? createCodexGoalProjection(), async (context, run) => {
      context.signal.throwIfAborted();
      return await run(await ensureClient());
    }),
    usageLimitRecovery: createCodexUsageLimitRecoveryControl(async (context, run) => {
      context.signal.throwIfAborted();
      return await run(await ensureClient());
    }),
    realtimeConversation,
    prepareProviderCliAttach,
    get skillsDelivered() { return skillsDelivered; },
    async readCatalog(request, options) {
      options?.signal?.throwIfAborted();
      const appServerClient = await ensureClient();
      return await readCodexSessionCatalog(request, {
        client: { request: (method, requestParams) => appServerClient.request(method, requestParams, options) },
        cwd: params.directory,
      });
    },
    async prepareSkillDelivery() { await ensureClient(); },
    async refreshSkills(request, options) {
      options?.signal?.throwIfAborted();
      if (params.appServerTransport === 'daemonProxy') {
        return { kind: 'restart_required', reason: 'launch_path_unsupported' };
      }
      const appServerClient = await ensureClient();
      await appServerClient.request('skills/extraRoots/set', { extraRoots: [request.skills.skillsRoot] }, options);
      currentSkills = request.skills;
      skillsDelivered = true;
      return { kind: 'applied' };
    },
    identity: {
      read() {
        return { providerSessionId: publishedThreadId };
      },
    },
    events: {
      subscribe(handler) {
        runtimeSubscribers.add(handler);
        return () => {
          runtimeSubscribers.delete(handler);
        };
      },
    },
    async send(input, options?: CodexAppServerSendOptions) {
      const text = readRuntimeInputText(input);
      if (!text) {
        return {
          status: 'rejected',
          diagnostic: 'Codex app-server runtime input did not include text',
        };
      }
      if (options?.deliverAs === 'followUp') {
        return {
          status: 'unsupported',
          diagnostic: 'Codex app-server does not support queued follow-up delivery yet',
        };
      }
      let structuredInput: unknown;
      try {
        structuredInput = await resolveCodexBrowserImageStructuredInput(input.structuredInput, params.host.inputFiles, options?.signal);
      } catch (error) {
        if (!(error instanceof CodexBrowserImageUnavailableError)) throw error;
        return { status: 'rejected', diagnostic: error.code };
      }
      const turnInput: CodexAppServerInput = {
        text,
        ...(structuredInput === undefined ? {} : { structuredInput }),
      };
      const resolveStructuredInputRefusal = (error: unknown, method: 'turn/start' | 'turn/steer') => {
        if (!isCodexAppServerInvalidParamsError(error)) return null;
        const rejectedInput = buildCodexAppServerTurnInput(turnInput);
        if (!rejectedInput.some((item) => item.type !== 'text')) return null;
        const errorCode = readRecord(error)?.code;
        params.host.logger.warn('Codex app-server rejected structured input', {
          method,
          ...buildCodexAppServerSafeErrorIdentity(error),
          ...(typeof errorCode === 'number' && Number.isFinite(errorCode) ? { errorCode } : {}),
        });
        return {
          status: 'unsupported' as const,
          diagnostic: rejectedInput.some((item) => item.type === 'image' || item.type === 'localImage')
            ? 'codex_image_input_unsupported'
            : 'codex_structured_input_rejected',
        };
      };
      if (options?.deliverAs === 'steer') {
        try { await steerInFlightTurn(turnInput, options); }
        catch (error) {
          const refusal = resolveStructuredInputRefusal(error, 'turn/steer');
          if (!refusal) throw error;
          return refusal;
        }
        return acceptedSendResult();
      }
      const submitted = sendTurnPrompt(turnInput, options);
      observeCompletionInBackground(submitted);
      try {
        const refusal = await submitted;
        if (refusal) return refusal;
      }
      catch (error) {
        const refusal = resolveStructuredInputRefusal(error, 'turn/start');
        if (!refusal) throw error;
        return refusal;
      }
      return acceptedSendResult();
    },
    async compact(request) {
      if (request.instructions !== undefined) return {
        status: 'unsupported', retryable: false,
        diagnostic: { code: 'codex_compaction_instructions_unsupported', severity: 'warning' },
      };
      if (disposed) return {
        status: 'unavailable', retryable: false,
        diagnostic: { code: 'codex_runtime_disposed', severity: 'warning' },
      };
      const appServerClient = await ensureClient();
      if (pendingTurn) return {
        status: 'unavailable', retryable: false,
        diagnostic: { code: 'codex_app_server_turn_in_flight', severity: 'warning' },
      };
      const currentThreadId = threadId;
      if (!currentThreadId) return {
        status: 'unavailable', retryable: false,
        diagnostic: { code: 'codex_compaction_thread_unavailable', severity: 'warning' },
      };
      // Reserve the existing native operation before request notifications can arrive.
      invalidatePromptCacheEvidence();
      const operation = createPendingTurn(currentThreadId, request.compactionId, null, null);
      operation.compaction = createCodexCompactionOperation(request, publishRuntimeEvent);
      pendingTurn = operation;
      try {
        await appServerClient.request('thread/compact/start', { threadId: currentThreadId });
        if (operation.compaction.phase === 'failed') throw new Error('Native compaction failed before acknowledgement');
        operation.providerStartAcknowledged = true;
        replayDeferredTerminalNotification(operation);
        return { status: 'admitted' };
      } catch {
        if (operation.compaction.phase === 'started') operation.compaction.finish('failed');
        if (pendingTurn === operation) pendingTurn = null;
        settlePendingTurnAgentTurnIdObservation(operation);
        operation.resolve();
        return { status: 'rejected', retryable: false,
          diagnostic: { code: 'codex_compaction_request_rejected', severity: 'error' } };
      }
    },
    async cancel(expectedTurnId?: string) {
      if (expectedTurnId !== undefined && pendingTurn?.sessionTurnId !== expectedTurnId) {
        return cancelledResult('not_running');
      }
      const hadActiveTurn = pendingTurn !== null;
      await cancelTurn();
      return cancelledResult(hadActiveTurn ? 'cancelled' : 'not_running');
    },
    rollbackNativeConversation,
    reconcileNativeConversationRollback,
    runtimeAuth: {
      apply: async (request: AgentSessionRuntimeAuthApplyRequest) => {
        assertToolRestrictionAuthSupported(true);
        return await applyRuntimeAuth(request);
      },
      readIdentity: readRuntimeAuthIdentity,
    },
    permissions: { capability: 'inline' },
    async updateConfig(update) {
      const updateRecord = readRecord(update);
      const nextModelId = trimStringValue(update.modelId);
      if (nextModelId && requiresConfinedMcp) {
        assertCodexToolRestrictionModelSupported(await ensureClient(), nextModelId);
      }
      const collaborationModeId = trimStringValue(updateRecord?.collaborationModeId);
      const nextPermissionMode = trimStringValue(updateRecord?.permissionMode) ?? currentPermissionMode;
      const nextWorkspaceWrites = updateRecord?.workspaceWrites === 'allow' || updateRecord?.workspaceWrites === 'deny'
        ? updateRecord.workspaceWrites : currentWorkspaceWrites;
      const nextPermissionPolicy = nextPermissionMode
        ? resolveCodexTerminalPermissionPolicy(nextPermissionMode, nextWorkspaceWrites, params.toolRestriction?.unlistedTools)
        : null;
      if (nextWorkspaceWrites !== currentWorkspaceWrites && (pendingTurn !== null || realtimeConversation.isActive())) {
        const nextPolicyKey = serializeCodexAppServerPolicy(resolveCurrentPolicy(nextPermissionPolicy));
        // A queued permission intent does not describe the active turn's sandbox.
        // An equivalent admitted policy needs no native change when adding a Role ceiling.
        if (realtimeConversation.isActive() || !pendingTurn?.nativePermissionPolicyKey
          || pendingTurn.nativePermissionPolicyKey !== nextPolicyKey) {
          throw Object.assign(new Error('The active Codex turn retains its admitted sandbox'), { code: 'role_policy_restart_required' });
        }
      }
      if (nextPermissionMode) currentPermissionMode = nextPermissionMode;
      currentWorkspaceWrites = nextWorkspaceWrites;
      if (nextPermissionPolicy) {
        currentPermissionPolicyOverride = nextPermissionPolicy;
        const nextPolicyKey = serializeCodexAppServerPolicy(resolveCurrentPolicy());
        if (
          threadId
          && publishedThreadId !== threadId
          && turnSeq === 0
          && pendingTurn === null
          && !realtimeConversation.isActive()
          && startedEmptyThreadPolicyKey !== null
          && startedEmptyThreadPolicyKey !== nextPolicyKey
        ) {
          threadId = null;
          nativeReadyThreadId = null;
          publishedThreadId = null;
          startedEmptyThreadPolicyKey = null;
          startedEmptyThreadWithoutExplicitModel = false;
        }
      }
      if (nextModelId) {
        if (nextModelId !== currentModelId) invalidatePromptCacheEvidence();
        if (
          threadId
          && publishedThreadId !== threadId
          && turnSeq === 0
          && pendingTurn === null
          && !realtimeConversation.isActive()
          && startedEmptyThreadWithoutExplicitModel
          && currentModelId !== nextModelId
        ) {
          threadId = null;
          nativeReadyThreadId = null;
          publishedThreadId = null;
          startedEmptyThreadPolicyKey = null;
          startedEmptyThreadWithoutExplicitModel = false;
        }
        currentModelId = nextModelId;
      }
      const configOption = readRecord(update.configOption);
      const configOptionId = normalizeCodexAppServerConfigOptionId(configOption?.id);
      const configOptionValue = trimStringValue(configOption?.value);
      if (
        configOptionId === CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID
        && !providerDisablesReasoning
        && (!params.initialProviderBinding || (
          params.initialProviderModel?.id === currentModelId
          && providerReasoningEffortOption?.options?.some(option => option.value === configOptionValue)
        ))
      ) {
        currentReasoningEffort = configOptionValue ?? currentReasoningEffort;
      }
      // Collaboration-mode selection depends on the effective model and reasoning effort. Apply
      // the rest of this atomic configuration update first so same-update values can satisfy the
      // mode without an avoidable model catalog request on the session-start hot path.
      if (collaborationModeId) await resolveCollaborationMode(collaborationModeId);
      const serviceTier = trimStringValue(updateRecord?.serviceTier)
        ?? (configOptionId === CODEX_APP_SERVER_SERVICE_TIER_CONFIG_OPTION_ID ? configOptionValue : null);
      if (serviceTier === 'fast' || serviceTier === 'standard') {
        currentServiceTier = serviceTier;
        hasServiceTierOverride = true;
      }
    },
    supportsInFlightSteer() {
      return true;
    },
    isTurnInFlight() {
      return pendingTurn !== null;
    },
    canSteerPrompt() {
      return !turnCompletionSettling && pendingTurn !== null;
    },
    async steerPrompt(prompt, options) {
      const localInputId = readPendingLocalId(options?.localId);
      const localInputIds = [
        ...(localInputId ? [localInputId] : []),
        ...(options?.localIds ?? []),
      ].filter((localId, index, values) => readPendingLocalId(localId) !== null && values.indexOf(localId) === index);
      const userMessageSeq = typeof options?.userMessageSeq === 'number' && Number.isFinite(options.userMessageSeq)
        ? Math.trunc(options.userMessageSeq)
        : null;
      const userMessageSeqs = [
        ...(userMessageSeq === null ? [] : [userMessageSeq]),
        ...(options?.userMessageSeqs ?? []),
      ].filter((seq, index, values) => Number.isSafeInteger(seq) && seq >= 0 && values.indexOf(seq) === index);
      await steerInFlightTurn({ text: prompt }, {
        deliverAs: 'steer',
        ...(localInputId ? { localInputId } : {}),
        ...(localInputIds.length === 0 ? {} : { localInputIds }),
        ...(userMessageSeq === null ? {} : { userMessageSeq }),
        ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
      });
    },
    dispose: resetOrDisposeRuntime,
    probeTurnLiveness() {
      return {
        active,
        lastActivityAtMs,
        diagnostics: {
          source: 'codex-app-server-runtime',
          promptInFlight: pendingTurn !== null,
          threadId,
        },
      };
    },
  };

  codexAppServerRuntimeStarters.set(runtime, openSession);
  codexAppServerRuntimeCompletionWaiters.set(runtime, () => backgroundCompletion ?? waitForTurnCompletion());
  return runtime;
}

export async function startCodexAppServerRuntime(
  runtime: CodexAppServerRuntime,
  options?: CodexAppServerStartOrLoadOptions,
): Promise<string> {
  const start = codexAppServerRuntimeStarters.get(runtime);
  if (!start) {
    throw new Error('Codex app-server runtime was not created by this module.');
  }
  return await start(options);
}

export async function waitForCodexAppServerRuntimeTurnCompletion(
  runtime: CodexAppServerRuntime,
): Promise<void> {
  const waitForCompletion = codexAppServerRuntimeCompletionWaiters.get(runtime);
  if (!waitForCompletion) {
    throw new Error('Codex app-server runtime was not created by this module.');
  }
  return await waitForCompletion();
}
