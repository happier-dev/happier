import { randomUUID } from 'node:crypto';
import type {
  PluginContextV1,
  RuntimeCancelResultV1,
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimePromptAcceptedCallbackV1,
  RuntimeUndeliverablePromptsCallbackV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import {
  buildSessionRuntimeIssueV1,
  RuntimeEventV1Schema,
  resolveRecoverableTurnFailureRetryDecision,
  resolveRecoverableTurnFailureSecondFailure,
  type SessionRollbackTarget,
  type SessionConnectedServiceAuthApplyGenerationRequestV1,
  type SessionConnectedServiceAuthApplyGenerationResponseV1,
  type SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
  type SessionRuntimeIssueSourceV1,
  type SessionRuntimeIssueV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  buildProviderAccountUsageRecordId,
  type ProviderAccountUsageRecordKeyV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/usage';
import { isChangeTitleToolNameAlias } from '@happier-dev/plugin-sdk/experimental/acp';

import {
  applyCodexConnectedServiceAuthGeneration,
  type CodexConnectedServiceRefreshSelection,
} from '../../auth/services/runtime/auth/application.js';
import {
  normalizeCodexConnectedServiceAuthGenerationRequest,
  readCodexConnectedServiceExpected,
  resolveCodexAppliedGeneration,
  resolveCodexAppliedGroupId,
  resolveCodexAppliedProfileId,
  writeCodexConnectedServiceAuthStore,
  type CodexConnectedServiceAuthGenerationRequest,
} from '../../auth/services/runtime/auth/generationRequest.js';
import {
  readCodexActiveProviderAccount,
  readCodexAuthStoreProviderAccountId,
  type CodexActiveProviderAccount,
} from '../../auth/services/runtime/auth/accountId.js';
import { readCodexEnvironmentAuthTokens } from '../../cli/auth/environment.js';
import { fetchCodexRateLimitResetCredits } from '../../auth/services/quota/rateLimitResetCreditsClient.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../auth/services/quota/runtimeRateLimits.js';
import { resolveCodexUsageSubjectRef } from '../../auth/services/usage/identity.js';
import {
  mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot,
} from '../../auth/services/usage/snapshot.js';
import { buildCodexAgentRuntimeDescriptorV1 } from '../../../protocol/runtimeDescriptorV1.js';
import {
  createCodexAppServerClient,
  isCodexAppServerOversizedJsonFrameError,
  resolveCodexHome,
  type CodexAppServerRequestOptions,
  type DisposableCodexAppServerClient,
} from './client.js';
import { readCodexAppServerResumeRecoveryTimeoutMs } from './client/timeout.js';
import { buildCodexAppServerConfigOverrides } from './config/overrides.js';
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
import { buildCodexAppServerTurnInput } from './turnInput.js';
import {
  buildCodexLiveAccountRuntimeIdentity,
  resolveCodexConnectedServiceRefreshSelectionFromEnv,
  resolveCodexInitialConnectedServiceRuntimeIdentity,
  type CodexConnectedServiceRuntimeIdentity,
} from './connectedServiceRuntimeIdentity.js';
import {
  createCodexAppServerTurnFailure,
  isCodexAppServerTemporaryRecoverableTurnFailureError,
} from './turns/failure.js';
import { createCodexAppServerSessionTurnRollbackTracker } from './turns/rollbackTracker.js';
import { createCodexAppServerAssistantReasoningProjector } from './projection/assistantReasoning.js';
import { projectCodexAppServerToolEventsFromNotification } from './projection/toolEvents.js';
import {
  buildThreadConfigOverrideParams,
  buildThreadServiceTierParams,
  isCodexTurnInterruptedStatus,
  readNormalizedProviderEventItemType,
  readProviderEventItemId,
  readProviderEventItemRecord,
  readCodexTurnStatus,
  readModelId,
  readProviderEventTurnId,
  readRollbackUnsupportedErrorMessage,
  readServiceTier,
  readThreadId,
  readTurnId,
  trimSessionId,
  trimStringValue,
} from './wire/fields.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';
import { handleTokenUsageNotification } from '../../usage/handleTokenUsageNotification.js';
import type { CodexProviderBindingEngineConfigV1 } from '../../providerBinding/runtimeConfig.js';

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
  preserveRequestedThreadId?: boolean;
}>;

type CodexAppServerStartSession = (
  options?: CodexAppServerStartOrLoadOptions,
) => Promise<string>;

type CodexAppServerRollbackConversationRequest = Readonly<{
  v: 1;
  target?: SessionRollbackTarget;
}>;

type CodexAppServerRollbackConversationResult =
  | Readonly<{
      ok: true;
      target: SessionRollbackTarget;
      threadId?: string;
    }>
  | Readonly<{
      ok: false;
      errorCode: string;
      errorMessage: string;
    }>;

const codexAppServerRuntimeStarters = new WeakMap<object, CodexAppServerStartSession>();
const codexAppServerRuntimeCompletionWaiters = new WeakMap<object, () => Promise<void>>();

export type CodexAppServerRuntime = SessionRuntimeV1 & Readonly<{
  supportsInFlightSteer(): boolean;
  isTurnInFlight(): boolean;
  canSteerPrompt(): boolean;
  steerPrompt(prompt: string, options?: Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
  }>): Promise<void>;
  applyConnectedServiceAuthGeneration(
    request: SessionConnectedServiceAuthApplyGenerationRequestV1,
  ): Promise<SessionConnectedServiceAuthApplyGenerationResponseV1>;
  readConnectedServiceRuntimeIdentity(
    request: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  ): Promise<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1>;
  rollbackConversation(
    request: CodexAppServerRollbackConversationRequest,
  ): Promise<CodexAppServerRollbackConversationResult>;
  probeTurnLiveness(): Readonly<{
    active: boolean;
    lastActivityAtMs: number | null;
    diagnostics: Readonly<Record<string, unknown>>;
  }>;
}>;

type PendingTurn = {
  threadId: string;
  sessionTurnId: string;
  agentTurnId: string | null;
  providerStartAcknowledged: boolean;
  deferredTerminalNotification: Readonly<{
    method: 'turn/completed' | 'turn/interrupted';
    params: unknown;
  }> | null;
  providerPrompt: PendingProviderPrompt | null;
  startUserMessageSeq: number | null;
  userMessageSeqs: number[];
  interruptWhenProviderTurnIdArrives: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingProviderPrompt = Readonly<{
  text: string;
  localInputIds: readonly string[];
  userMessageSeq: number | null;
  userMessageSeqs: readonly number[];
}>;

type BufferedTranscriptSegment = {
  kind: 'assistant' | 'reasoning';
  text: string;
  sidechainId: string | null;
};

type CodexAppServerRuntimeParams = Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  initialProviderSessionId?: string | null;
  initialModelId?: string | null;
  initialProviderBinding?: CodexProviderBindingEngineConfigV1 | null;
  processEnv?: Readonly<Record<string, string | undefined>>;
  mcpServers?: unknown;
  resolveCurrentPolicy?: () => CodexAppServerPolicy | null;
  setThinking?: (thinking: boolean) => void;
}>;

const CODEX_TEMPORARY_RECOVERABLE_TURN_CONTINUATION_PROMPT =
  'Please continue the interrupted work from the recovered Codex turn. Do not restart or repeat completed work.';
const CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT_ENV_KEY = 'HAPPIER_CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT';
const CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS_ENV_KEY = 'HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS';
const DEFAULT_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS = 25;
const MAX_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS = 5_000;
const MAX_CODEX_APP_SERVER_DIAGNOSTIC_MESSAGE_CHARS = 1_000;
const CODEX_APP_SERVER_PROVIDER_TURN_ID_WAIT_TIMEOUT_MS = 1_000;
const CODEX_APP_SERVER_PROVIDER_TURN_ID_WAIT_POLL_MS = 20;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function readNonEmptyStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value : null;
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

function normalizeContinuationPrompt(value: unknown): string | null {
  const prompt = trimStringValue(value);
  return prompt && prompt.length <= 4000 ? prompt : null;
}

function resolveTemporaryRecoverableTurnContinuationPrompt(params: CodexAppServerRuntimeParams): string {
  const env = params.processEnv ?? params.ctx.env.list();
  return normalizeContinuationPrompt(env[CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT_ENV_KEY])
    ?? CODEX_TEMPORARY_RECOVERABLE_TURN_CONTINUATION_PROMPT;
}

function readCodexAppServerTurnCompletionSettleMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = Number.parseInt(String(env[CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS_ENV_KEY] ?? ''), 10);
  if (!Number.isFinite(raw)) return DEFAULT_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS;
  return Math.max(0, Math.min(MAX_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS, Math.trunc(raw)));
}

function readRuntimeInputText(input: RuntimeInputPayloadV1): string | null {
  return trimStringValue(input.text);
}

function createCodexAppServerTurnId(): string {
  return `codex-turn-${randomUUID()}`;
}

function readRuntimeTurnId(options: RuntimeSendOptionsV1 | undefined): string | null {
  return trimStringValue(options?.turnId);
}

function readRuntimeUserMessageSeq(options: RuntimeSendOptionsV1 | undefined): number | null {
  return typeof options?.userMessageSeq === 'number' && Number.isFinite(options.userMessageSeq)
    ? Math.trunc(options.userMessageSeq)
    : null;
}

function readRuntimeLocalInputIds(options: RuntimeSendOptionsV1 | undefined): string[] {
  const localIds: string[] = [];
  const append = (value: unknown) => {
    const localId = typeof value === 'string' ? value.trim() : '';
    if (!localId || localIds.includes(localId)) return;
    localIds.push(localId);
  };
  append(options?.localInputId);
  for (const localId of options?.localInputIds ?? []) {
    append(localId);
  }
  return localIds;
}

function readRuntimeUserMessageSeqs(options: RuntimeSendOptionsV1 | undefined): number[] {
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

function acceptedSendResult(): RuntimeSendResultV1 {
  return { status: 'accepted' };
}

function cancelledResult(status: RuntimeCancelResultV1['status']): RuntimeCancelResultV1 {
  return { status };
}

function readRollbackTarget(value: unknown): SessionRollbackTarget | null {
  const record = readRecord(value);
  if (!record) return { type: 'latest_turn' };
  if (record.type === 'latest_turn') return { type: 'latest_turn' };
  if (
    record.type === 'before_user_message'
    && Number.isSafeInteger(record.userMessageSeq)
    && (record.userMessageSeq as number) >= 0
  ) {
    return {
      type: 'before_user_message',
      userMessageSeq: record.userMessageSeq as number,
    };
  }
  return null;
}

function appendRollbackUserMessageSeq(turn: PendingTurn, seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0 || turn.userMessageSeqs.includes(seq)) return;
  turn.userMessageSeqs.push(seq);
}

type CodexProviderAccountUsageSourceContext = Awaited<
  ReturnType<PluginContextV1['agentRuntime']['accountUsage']['resolveSourceContext']>
>;

type RecordProviderAccountUsageSnapshotOptions = Readonly<{
  includeLiveAccountIdentity?: boolean;
}>;

function codexRuntimeIdentityMatchesExpected(input: Readonly<{
  identity: CodexConnectedServiceRuntimeIdentity;
  expected: CodexConnectedServiceAuthGenerationRequest['expected'];
}>): boolean {
  if (input.expected.groupId && input.identity.groupId !== input.expected.groupId) return false;
  return true;
}

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
}> | null {
  const record = readRecord(value);
  const result = readRecord(record?.result) ?? record;
  const accessToken = trimStringValue(result?.accessToken);
  const chatgptAccountId = trimStringValue(result?.chatgptAccountId);
  if (!accessToken || !chatgptAccountId) return null;
  const chatgptPlanType = trimStringValue(result?.chatgptPlanType);
  return {
    accessToken,
    chatgptAccountId,
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
  };
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

function resolveCodexRuntimeIssueSource(error: Error): SessionRuntimeIssueSourceV1 {
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

function sanitizeCodexAppServerDiagnosticText(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/giu, 'Bearer <redacted>')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gu, '<jwt-redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, '<redacted-token>');
  return redacted.length > MAX_CODEX_APP_SERVER_DIAGNOSTIC_MESSAGE_CHARS
    ? `${redacted.slice(0, MAX_CODEX_APP_SERVER_DIAGNOSTIC_MESSAGE_CHARS)}...`
    : redacted;
}

function buildCodexAppServerBackgroundCompletionFailureDiagnostics(
  error: unknown,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const classification = readRecord((error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification);
  const errorMessage = trimStringValue(sanitizeCodexAppServerDiagnosticText(error.message));
  const runtimeAuthKind = trimStringValue(classification?.kind);
  const runtimeAuthSource = trimStringValue(classification?.source);
  const runtimeAuthLimitCategory = trimStringValue(classification?.limitCategory);
  const runtimeAuthPlanType = trimStringValue(classification?.planType);
  const runtimeAuthRetryAfterMs = typeof classification?.retryAfterMs === 'number'
    && Number.isFinite(classification.retryAfterMs)
    ? Math.trunc(classification.retryAfterMs)
    : null;
  const runtimeAuthResetsAtMs = typeof classification?.resetsAtMs === 'number'
    && Number.isFinite(classification.resetsAtMs)
    ? Math.trunc(classification.resetsAtMs)
    : null;
  return {
    errorName: error.name,
    ...(errorMessage ? { errorMessage } : {}),
    runtimeIssueSource: resolveCodexRuntimeIssueSource(error),
    ...(runtimeAuthKind ? { runtimeAuthKind } : {}),
    ...(runtimeAuthSource ? { runtimeAuthSource } : {}),
    ...(runtimeAuthLimitCategory ? { runtimeAuthLimitCategory } : {}),
    ...(runtimeAuthPlanType ? { runtimeAuthPlanType } : {}),
    ...(runtimeAuthRetryAfterMs === null ? {} : { runtimeAuthRetryAfterMs }),
    ...(runtimeAuthResetsAtMs === null ? {} : { runtimeAuthResetsAtMs }),
  };
}

function buildCodexAppServerTurnFailureIssue(
  error: Error,
  activeTurn: PendingTurn,
): SessionRuntimeIssueV1 {
  return buildSessionRuntimeIssueV1({
    code: 'codex_app_server_turn_failed',
    source: resolveCodexRuntimeIssueSource(error),
    occurredAt: Date.now(),
    agentId: 'codex',
    agentTurnId: activeTurn.agentTurnId,
    sanitizedPreview: error.message,
  });
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
): PendingTurn {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
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
    providerStartAcknowledged: false,
    deferredTerminalNotification: null,
    providerPrompt,
    startUserMessageSeq,
    userMessageSeqs,
    interruptWhenProviderTurnIdArrives: false,
    promise,
    resolve,
    reject,
  };
}

function buildRuntimeSendOptionsForPendingProviderPrompt(
  pending: PendingProviderPrompt | null,
): RuntimeSendOptionsV1 | undefined {
  if (!pending || !pendingProviderPromptHasDeliveryIdentity(pending)) return undefined;
  return {
    ...(pending.localInputIds.length === 0 ? {} : { localInputIds: pending.localInputIds }),
    ...(pending.userMessageSeq === null ? {} : { userMessageSeq: pending.userMessageSeq }),
    ...(pending.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: pending.userMessageSeqs }),
  };
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
        }
      : null,
  });
}

function createCodexRuntimeEvent(
  happierSessionId: string,
  event: Omit<RuntimeEventV1, 'sessionId' | 'emittedAtMs'>,
): RuntimeEventV1 {
  const runtimeEvent = {
    ...event,
    sessionId: happierSessionId,
    emittedAtMs: Date.now(),
  };
  const parsed = RuntimeEventV1Schema.safeParse(runtimeEvent);
  if (!parsed.success) {
    throw new Error('Codex app-server produced an invalid RuntimeEventV1 payload');
  }
  return parsed.data;
}

export function createCodexAppServerRuntime(
  params: CodexAppServerRuntimeParams,
): CodexAppServerRuntime {
  const temporaryRecoverableTurnContinuationPrompt = resolveTemporaryRecoverableTurnContinuationPrompt(params);
  const readRuntimeProcessEnv = (): Readonly<Record<string, string | undefined>> =>
    params.processEnv ?? params.ctx.env.list();
  let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;
  let client: DisposableCodexAppServerClient | null = null;
  let threadId: string | null = trimSessionId(params.initialProviderSessionId);
  let currentModelId: string | null = trimStringValue(params.initialModelId);
  let currentReasoningEffort: string | null = null;
  let currentServiceTier: string | null = null;
  let currentPermissionPolicyOverride: CodexAppServerPolicy | null = null;
  let hasServiceTierOverride = false;
  let permissionSupport: CodexAppServerPermissionSupport = 'unknown';
  let publishedThreadId: string | null = null;
  let turnSeq = 0;
  let pendingTurn: PendingTurn | null = null;
  const terminatedProviderTurnIds = new Set<string>();
  let activeTurnHadMeaningfulActivity = false;
  let turnCompletionSettling = false;
  let pendingTurnCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledPendingTurnCompletion: Readonly<{
    status: 'completed' | 'interrupted';
    notificationParams: unknown;
  }> | null = null;
  let deferredTemporaryRecoverableFailure: Error | null = null;
  let terminalPendingTurnFailure: Error | null = null;
  let originalTemporaryRecoverableFailure: Error | null = null;
  let promptForTemporaryRecoverableRetry: string | null = null;
  let providerPromptForDeferredTemporaryRecoverableRetry: PendingProviderPrompt | null = null;
  let temporaryRecoverableRetryAttemptCount = 0;
  let active = false;
  let lastActivityAtMs: number | null = null;
  let disposed = false;
  let startedEmptyThreadWithoutExplicitModel = false;
  let startedEmptyThreadPolicyKey: string | null = null;
  let backgroundCompletion: Promise<void> | null = null;
  let onPromptAcceptedByProvider: RuntimePromptAcceptedCallbackV1 | null = null;
  let onUndeliverablePrompts: RuntimeUndeliverablePromptsCallbackV1 | null = null;
  let activeChatGptAuthTokensRefreshSelection: CodexConnectedServiceRefreshSelection | null =
    resolveCodexConnectedServiceRefreshSelectionFromEnv(readRuntimeProcessEnv());
  let latestConnectedServiceRuntimeIdentity: CodexConnectedServiceRuntimeIdentity | null =
    resolveCodexInitialConnectedServiceRuntimeIdentity(readRuntimeProcessEnv());
  const pendingProviderPrompts = new Set<PendingProviderPrompt>();
  const runtimeSubscribers = new Set<(event: RuntimeEventV1) => void>();
  const resolveCurrentPolicy = (): CodexAppServerPolicy | null =>
    currentPermissionPolicyOverride ?? params.resolveCurrentPolicy?.() ?? null;
  const rollbackTracker = createCodexAppServerSessionTurnRollbackTracker({
    session: {},
  });
  const rollbackProviderTurnIdsBySessionTurnId = new Map<string, string>();
  const publishedToolEventKeys = new Set<string>();
  const pendingHappierTitleToolNamesByCallId = new Map<string, string>();

  const publishRuntimeEvent = (event: Omit<RuntimeEventV1, 'sessionId' | 'emittedAtMs'>): void => {
    const payload = createCodexRuntimeEvent(params.happierSessionId, event);
    rollbackTracker.observeRuntimeEvent(payload);
    for (const subscriber of runtimeSubscribers) subscriber(payload);
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
    if (text.trim().length === 0) return;
    const existing = bufferedTranscriptSegments.get(streamKey);
    bufferedTranscriptSegments.set(streamKey, {
      kind,
      sidechainId,
      text: mode === 'append' && existing?.kind === kind
        ? `${existing.text}${text}`
        : text,
    });
  };

  const flushBufferedTranscriptSegments = (args: Readonly<{
    reason: 'turn-end' | 'abort' | 'tool-call-boundary';
    interruptedReason?: string;
  }>): void => {
    const segments = Array.from(bufferedTranscriptSegments.entries());
    bufferedTranscriptSegments.clear();
    for (const [streamKey, segment] of segments) {
      if (segment.text.trim().length === 0) continue;
      publishRuntimeEvent({
        kind: 'transcript-agent-message-committed',
        agentId: 'codex',
        localId: `codex:${streamKey}`,
        body: segment.kind === 'assistant'
          ? { type: 'message', message: segment.text }
          : { type: 'reasoning', message: segment.text },
        ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
        meta: {
          source: 'codex-app-server-runtime',
          streamKey,
          ...(args.reason === 'abort' ? { interruptedReason: args.interruptedReason ?? 'app-server-turn-interrupted' } : {}),
        },
      });
    }
  };

  const assistantReasoningProjector = createCodexAppServerAssistantReasoningProjector({
    bridge: {
      appendAssistantDelta({ deltaText, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'assistant', sidechainId, deltaText, 'append');
      },
      appendThinkingDelta({ deltaText, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'reasoning', sidechainId, deltaText, 'append');
      },
      overrideAssistantText({ text, streamKey, sidechainId }) {
        updateBufferedTranscriptSegment(streamKey, 'assistant', sidechainId, text, 'override');
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
      params.ctx.logger?.debug?.('Codex app-server assistant transcript projection flush failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };

  const trackPendingProviderPrompt = (
    text: string,
    options: RuntimeSendOptionsV1 | undefined,
  ): PendingProviderPrompt => {
    const userMessageSeq = readRuntimeUserMessageSeq(options);
    const pending = {
      text,
      localInputIds: readRuntimeLocalInputIds(options),
      userMessageSeq,
      userMessageSeqs: readRuntimeUserMessageSeqs(options),
    };
    pendingProviderPrompts.add(pending);
    return pending;
  };

  const markPendingProviderPromptAccepted = (
    pending: PendingProviderPrompt | null | undefined,
  ): void => {
    if (!pending || !pendingProviderPrompts.has(pending)) return;
    pendingProviderPrompts.delete(pending);
    if (!pendingProviderPromptHasDeliveryIdentity(pending)) return;
    onPromptAcceptedByProvider?.({
      ...(pending.localInputIds.length === 0 ? {} : { localInputIds: pending.localInputIds }),
      userMessageSeq: pending.userMessageSeq,
      ...(pending.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: pending.userMessageSeqs }),
    });
  };

  const clearPendingProviderPrompt = (
    pending: PendingProviderPrompt | null | undefined,
  ): void => {
    if (!pending) return;
    pendingProviderPrompts.delete(pending);
  };

  const emitPendingProviderPromptAsUndeliverable = (
    pending: PendingProviderPrompt | null | undefined,
  ): void => {
    if (!pending || !pendingProviderPrompts.has(pending)) return;
    pendingProviderPrompts.delete(pending);
    onUndeliverablePrompts?.([{
      text: pending.text,
      ...(pending.localInputIds.length === 0 ? {} : { localInputIds: pending.localInputIds }),
      userMessageSeq: pending.userMessageSeq,
      ...(pending.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: pending.userMessageSeqs }),
    }]);
  };

  const emitAllPendingProviderPromptsAsUndeliverable = (): void => {
    const prompts = Array.from(pendingProviderPrompts);
    pendingProviderPrompts.clear();
    const undeliverable = prompts.map((pending) => ({
      text: pending.text,
      ...(pending.localInputIds.length === 0 ? {} : { localInputIds: pending.localInputIds }),
      userMessageSeq: pending.userMessageSeq,
      ...(pending.userMessageSeqs.length === 0 ? {} : { userMessageSeqs: pending.userMessageSeqs }),
    }));
    if (undeliverable.length > 0) {
      onUndeliverablePrompts?.(undeliverable);
    }
  };

  const readLiveProviderAccount = async (): Promise<CodexActiveProviderAccount | null> => {
    try {
      return readCodexActiveProviderAccount(await (await ensureClient()).request('account/read'));
    } catch (error) {
      params.ctx.logger?.debug?.('Codex app-server live account read failed for provider-account usage snapshot (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  };

  const buildLiveAccountRuntimeIdentity = (
    liveProviderAccount: CodexActiveProviderAccount,
  ): CodexConnectedServiceRuntimeIdentity | null => {
    return buildCodexLiveAccountRuntimeIdentity({
      liveProviderAccount,
      currentSelection: activeChatGptAuthTokensRefreshSelection,
      previousIdentity: latestConnectedServiceRuntimeIdentity,
    });
  };

  const buildLiveAccountRuntimeIdentityFromExpectedContext = (
    liveProviderAccount: CodexActiveProviderAccount,
    expected: CodexConnectedServiceAuthGenerationRequest['expected'],
  ): CodexConnectedServiceRuntimeIdentity | null => {
    const providerAccountId = liveProviderAccount.providerAccountId?.trim();
    const profileId = expected.profileId?.trim();
    if (!providerAccountId || !profileId) return null;
    const groupId = expected.groupId?.trim() ?? null;
    return {
      serviceId: 'openai-codex',
      providerAccountId,
      accountLabel: liveProviderAccount.providerEmail,
      profileId,
      groupId,
      generation: expected.generation,
      source: 'live_account_read',
    };
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

  const refreshLiveAccountRuntimeIdentity = async (
    expected?: CodexConnectedServiceAuthGenerationRequest['expected'],
  ): Promise<CodexConnectedServiceRuntimeIdentity | null> => {
    const liveProviderAccount = await readLiveProviderAccount();
    const liveRuntimeIdentity = liveProviderAccount
      ? buildLiveAccountRuntimeIdentity(liveProviderAccount)
        ?? (expected ? buildLiveAccountRuntimeIdentityFromExpectedContext(liveProviderAccount, expected) : null)
      : null;
    if (liveRuntimeIdentity) {
      latestConnectedServiceRuntimeIdentity = liveRuntimeIdentity;
    }
    return liveRuntimeIdentity;
  };

  const readRateLimitResetCreditsRaw = async (
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<unknown> => {
    const authTokens = readCodexEnvironmentAuthTokens(env);
    const accessToken = authTokens.accessToken ?? authTokens.idToken;
    if (!accessToken) return undefined;
    try {
      return await fetchCodexRateLimitResetCredits({
        accessToken,
        accountId: authTokens.accountId,
        runtimeFetch: params.ctx.fetch,
      });
    } catch (error) {
      params.ctx.logger?.debug?.('Codex app-server reset-credit usage snapshot fetch failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  };

  const recordProviderAccountUsageSnapshot = async (
    rawSnapshot: unknown,
    options: RecordProviderAccountUsageSnapshotOptions = {},
  ): Promise<void> => {
    const service = params.ctx.agentRuntime.accountUsage;
    if (!service || typeof service.recordSnapshot !== 'function') return;
    const env = readRuntimeProcessEnv();
    const codexHome = resolveCodexHome(env);
    const observedAtMs = Date.now();
    try {
      const sourceContext = typeof service.resolveSourceContext === 'function'
        ? await service.resolveSourceContext({ serviceId: 'openai-codex', env })
        : null;
      const provisionalDiscriminator = buildCodexProviderAccountUsageProvisionalDiscriminator({
        sourceContext,
        happierSessionId: params.happierSessionId,
        codexHome,
      });
      const liveProviderAccount = options.includeLiveAccountIdentity === true
        ? await readLiveProviderAccount()
        : null;
      if (liveProviderAccount) {
        const liveRuntimeIdentity = buildLiveAccountRuntimeIdentity(liveProviderAccount);
        if (liveRuntimeIdentity) {
          latestConnectedServiceRuntimeIdentity = liveRuntimeIdentity;
        }
      }
      const rawResetCredits = await readRateLimitResetCreditsRaw(env);
      const subject = resolveCodexUsageSubjectRef({
        liveProviderAccount,
        authStoreProviderAccountIdProof: await readCodexAuthStoreProviderAccountId(codexHome),
        provisionalDiscriminator,
      });
      const snapshot = mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot({
        subject,
        rawSnapshot,
        rawResetCredits,
        observedAtMs,
        fetchedAtMs: observedAtMs,
        accountLabel: liveProviderAccount?.providerEmail ?? null,
      });
      const result = await service.recordSnapshot({
        snapshot,
        ...(sourceContext ? { source: sourceContext } : {}),
      });
      if (result.status !== 'recorded') {
        params.ctx.logger?.debug?.('Codex app-server provider-account usage snapshot was not recorded', {
          status: result.status,
          reason: 'reason' in result ? result.reason : null,
        });
        return;
      }
      if (subject.kind === 'providerSubject' && typeof service.adoptProvisionalRecord === 'function') {
        const provisionalSubject = resolveCodexUsageSubjectRef({ provisionalDiscriminator });
        if (provisionalSubject.kind === 'provisionalLocalSubject') {
          const provisionalRecordKey: ProviderAccountUsageRecordKeyV1 = {
            providerId: 'openai-codex',
            accountSubjectId: provisionalSubject.accountSubjectId,
            subjectKind: 'unknown',
            quotaScope: 'account',
          };
          const adoptionResult = await service.adoptProvisionalRecord({
            adoption: {
              providerId: 'openai-codex',
              fromRecordId: buildProviderAccountUsageRecordId(provisionalRecordKey),
              toRecordId: snapshot.recordId,
              stableRecordKey: snapshot.recordKey,
              proof: subject.proof === 'auth_store_chatgpt_account_id'
                ? { kind: 'id_token_account_id', issuer: 'chatgpt' }
                : { kind: 'provider_account_id_match' },
              observedAtMs,
            },
          });
          if (adoptionResult.status !== 'adopted' && adoptionResult.status !== 'already_adopted') {
            params.ctx.logger?.debug?.('Codex app-server provider-account usage adoption was not applied', {
              status: adoptionResult.status,
              reason: 'reason' in adoptionResult ? adoptionResult.reason : null,
            });
          }
        }
      }
    } catch (error) {
      params.ctx.logger?.debug?.('Codex app-server provider-account usage recording failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  const publishImmediateProviderAccountUsageSnapshotForQuotaFailure = async (error: Error): Promise<void> => {
    if (!isCodexRuntimeAuthQuotaFailure(error)) return;
    try {
      const appServerClient = await ensureClient();
      const result = await readCodexRuntimeRateLimitsSnapshot(appServerClient);
      await recordProviderAccountUsageSnapshot(result.rawSnapshot, { includeLiveAccountIdentity: true });
    } catch (snapshotError) {
      params.ctx.logger?.debug?.('Codex app-server immediate quota usage snapshot failed (ignored)', {
        errorName: snapshotError instanceof Error ? snapshotError.name : typeof snapshotError,
      });
    }
  };

  const readRefreshRuntimeAuthService = (): ((request: unknown) => Promise<unknown> | unknown) | null => {
    const auth = readRecord((params.ctx as Readonly<{ auth?: unknown }>).auth);
    const services = readRecord(auth?.services);
    const refreshRuntimeAuth = services?.refreshRuntimeAuth;
    return typeof refreshRuntimeAuth === 'function'
      ? refreshRuntimeAuth as (request: unknown) => Promise<unknown> | unknown
      : null;
  };

  const refreshChatGptAuthTokens = async (requestParams: unknown): Promise<unknown> => {
    const selection = activeChatGptAuthTokensRefreshSelection;
    if (!selection) {
      throw new Error('connected_service_chatgpt_refresh_selection_unavailable');
    }
    const refreshRuntimeAuth = readRefreshRuntimeAuthService();
    if (!refreshRuntimeAuth) {
      throw new Error('connected_service_chatgpt_refresh_unavailable');
    }
    const refreshed = readCodexChatGptAuthTokensRefreshResult(await refreshRuntimeAuth({
      agentId: 'codex',
      serviceId: 'openai-codex',
      selection,
      planType: readCodexChatGptAuthTokensPlanType(requestParams),
      reason: 'chatgpt_auth_tokens_refresh',
    }));
    if (!refreshed) {
      throw new Error('connected_service_chatgpt_refresh_invalid_result');
    }
    return refreshed;
  };

  const publishThreadIdentity = (nextThreadId: string): void => {
    const normalizedThreadId = trimSessionId(nextThreadId);
    if (!normalizedThreadId) return;
    threadId = normalizedThreadId;
    if (publishedThreadId === normalizedThreadId) return;
    publishedThreadId = normalizedThreadId;
    publishRuntimeEvent({
      kind: 'session-id-publish',
      publishedSessionId: normalizedThreadId,
      source: 'codex-app-server',
    });
    publishRuntimeEvent({
      kind: 'descriptor-update',
      descriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: normalizedThreadId,
      }),
    });
  };

  const setActive = (nextActive: boolean): void => {
    active = nextActive;
    lastActivityAtMs = Date.now();
    params.setThinking?.(nextActive);
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

  const readMeaningfulText = (notificationParams: unknown, keys: readonly string[]): string | null => {
    const record = readRecord(notificationParams);
    for (const key of keys) {
      const text = trimStringValue(record?.[key]);
      if (text) return text;
    }
    return null;
  };

  const readProviderEventText = (notificationParams: unknown, keys: readonly string[]): string | null => {
    const record = readRecord(notificationParams);
    const item = readProviderEventItemRecord(notificationParams);
    const sources = item === record ? [record] : [record, item];
    for (const source of sources) {
      if (!source) continue;
      for (const key of keys) {
        const text = readNonEmptyStringValue(source[key]);
        if (text !== null) return text;
      }
    }
    const content = item?.content ?? record?.content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const part of content) {
      const partRecord = readRecord(part);
      const text = readNonEmptyStringValue(partRecord?.text)
        ?? readNonEmptyStringValue(partRecord?.output_text)
        ?? readNonEmptyStringValue(partRecord?.outputText);
      if (text !== null) parts.push(text);
    }
    return parts.length > 0 ? parts.join('') : null;
  };

  const readProviderEventItemRole = (notificationParams: unknown): string | null => {
    const item = readProviderEventItemRecord(notificationParams);
    const role = trimStringValue(item?.role);
    return role ? role.toLowerCase() : null;
  };

  const readThreadNameUpdateTitle = (notificationParams: unknown): string | null => {
    const record = readRecord(notificationParams);
    const thread = readRecord(record?.thread);
    return trimStringValue(record?.name)
      ?? trimStringValue(record?.title)
      ?? trimStringValue(record?.displayName)
      ?? trimStringValue(record?.display_name)
      ?? trimStringValue(thread?.name)
      ?? trimStringValue(thread?.title)
      ?? trimStringValue(thread?.displayName)
      ?? trimStringValue(thread?.display_name);
  };

  const applyThreadNameUpdate = (notificationParams: unknown): void => {
    const title = readThreadNameUpdateTitle(notificationParams);
    if (!title) return;
    const notificationThreadId = readThreadId(notificationParams);
    if (threadId && notificationThreadId && notificationThreadId !== threadId) return;
    const writeStateField = params.ctx.sessions?.writeStateField;
    if (typeof writeStateField !== 'function') return;
    void writeStateField({
      fieldId: 'display.title',
      value: title,
      reason: 'provider_update',
    }).catch((error: unknown) => {
      params.ctx.logger?.debug?.('Codex app-server display title write failed (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
  };

  const isMeaningfulActivityNotification = (method: string, notificationParams: unknown): boolean => {
    if (method === 'item/agentMessage/delta') {
      return readMeaningfulText(notificationParams, ['delta', 'text']) !== null;
    }
    if (method === 'turn/diff/updated') {
      return readMeaningfulText(notificationParams, ['unifiedDiff', 'diff']) !== null;
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      return readMeaningfulText(notificationParams, ['delta', 'text']) !== null;
    }
    return true;
  };

  const observeAssistantReasoningNotification = (method: string, notificationParams: unknown): boolean => {
    const activeTurn = pendingTurn;
    if (!activeTurn || !notificationMatchesPendingTurn(notificationParams)) return false;
    const context = {
      sidechainId: null,
      streamScopeId: activeTurn.sessionTurnId,
    };
    const itemId = readProviderEventItemId(notificationParams)
      ?? `${method}:${activeTurn.agentTurnId ?? activeTurn.sessionTurnId}`;
    if (method === 'item/agentMessage/delta') {
      const text = readProviderEventText(notificationParams, ['delta', 'text']);
      return assistantReasoningProjector.observeStreamUpdate({
        type: 'assistant-text-delta',
        itemId,
        text,
      }, context);
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const text = readProviderEventText(notificationParams, ['delta', 'text']);
      return assistantReasoningProjector.observeStreamUpdate({
        type: 'reasoning-delta',
        itemId,
        text,
      }, context);
    }
    if (method === 'rawResponseItem/completed') {
      const text = readProviderEventText(notificationParams, ['text', 'message', 'outputText', 'output_text']);
      return assistantReasoningProjector.observeStreamUpdate({
        type: 'assistant-raw-final',
        itemId: readProviderEventItemId(notificationParams),
        text,
      }, context);
    }
    if (method !== 'item/completed') return false;
    const itemType = readNormalizedProviderEventItemType(notificationParams);
    const itemRole = readProviderEventItemRole(notificationParams);
    const text = readProviderEventText(notificationParams, ['text', 'message', 'outputText', 'output_text']);
    if (!text) return false;
    if (itemType?.includes('reasoning') || itemType?.includes('thinking')) {
      return assistantReasoningProjector.observeStreamUpdate({
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
      return assistantReasoningProjector.observeStreamUpdate({
        type: 'assistant-text-final',
        itemId,
        text,
      }, context);
    }
    return false;
  };

  const publishToolEventsFromNotification = (method: string, notificationParams: unknown): boolean => {
    const activeTurn = pendingTurn;
    if (!activeTurn || !notificationMatchesPendingTurn(notificationParams)) return false;
    const projected = projectCodexAppServerToolEventsFromNotification({ method, notificationParams });
    const publishable = projected.filter((event) => (
      !publishedToolEventKeys.has(`${activeTurn.sessionTurnId}:${event.type}:${event.callId}`)
    ));
    if (publishable.length === 0) return false;
    flushBufferedTranscriptSegments({ reason: 'tool-call-boundary' });
    let published = false;
    for (const event of publishable) {
      const key = `${activeTurn.sessionTurnId}:${event.type}:${event.callId}`;
      publishedToolEventKeys.add(key);
      if (event.type === 'tool-call') {
        if (!event.sidechainId && isChangeTitleToolNameAlias(event.name)) {
          const title = readHappierTitleToolTitle(event.input);
          if (title) {
            pendingHappierTitleToolNamesByCallId.set(buildTurnToolCallKey(activeTurn.sessionTurnId, event.callId), title);
          }
        }
        publishRuntimeEvent({
          kind: 'tool-call',
          turnId: activeTurn.sessionTurnId,
          toolCallId: event.callId,
          toolName: event.name,
          toolInput: event.input,
          ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
        });
        published = true;
        continue;
      }
      const completedTitleName = pendingHappierTitleToolNamesByCallId.get(
        buildTurnToolCallKey(activeTurn.sessionTurnId, event.callId),
      ) ?? null;
      pendingHappierTitleToolNamesByCallId.delete(buildTurnToolCallKey(activeTurn.sessionTurnId, event.callId));
      if (completedTitleName && !event.sidechainId && didHappierTitleToolSucceed(event.output)) {
        const activeClient = client;
        if (activeClient) {
          void activeClient.request('thread/name/set', {
            threadId: activeTurn.threadId,
            name: completedTitleName,
          }).catch((error: unknown) => {
            params.ctx.logger?.debug?.('Codex app-server failed to sync Happier title to native thread name', {
              threadId: activeTurn.threadId,
              errorName: error instanceof Error ? error.name : typeof error,
            });
          });
        }
      }
      publishRuntimeEvent({
        kind: 'tool-result',
        turnId: activeTurn.sessionTurnId,
        toolCallId: event.callId,
        output: event.output,
        ...(event.isError === undefined ? {} : { isError: event.isError }),
        ...(event.sidechainId ? { sidechainId: event.sidechainId } : {}),
      });
      published = true;
    }
    return published;
  };

  const markMeaningfulActivityFromNotification = (method: string, notificationParams: unknown): void => {
    if (!notificationMatchesPendingTurn(notificationParams)) return;
    if (!isMeaningfulActivityNotification(method, notificationParams)) return;
    activeTurnHadMeaningfulActivity = true;
  };

  const clearPendingTurnCompletionTimer = (): void => {
    if (pendingTurnCompletionTimer) {
      clearTimeout(pendingTurnCompletionTimer);
      pendingTurnCompletionTimer = null;
    }
    scheduledPendingTurnCompletion = null;
    turnCompletionSettling = false;
  };

  const publishRollbackBoundaryForCompletedTurn = (
    activeTurn: PendingTurn,
    agentTurnId: string | null,
  ): void => {
    const startUserMessageSeq = activeTurn.startUserMessageSeq;
    if (startUserMessageSeq === null) return;
    const endSeqInclusive = activeTurn.userMessageSeqs.reduce(
      (latestSeq, seq) => Math.max(latestSeq, seq),
      startUserMessageSeq,
    );
    if (agentTurnId) {
      rollbackProviderTurnIdsBySessionTurnId.set(activeTurn.sessionTurnId, agentTurnId);
    }
    publishRuntimeEvent({
      kind: 'turn-rollback-boundary-observed',
      turnId: activeTurn.sessionTurnId,
      ...(agentTurnId ? { agentTurnId } : {}),
      startUserMessageSeq,
      startSeqInclusive: startUserMessageSeq,
      endSeqInclusive,
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
    if (agentTurnId && !activeTurn.agentTurnId) {
      activeTurn.agentTurnId = agentTurnId;
      publishRuntimeEvent({
        kind: 'turn-agent-id-observed',
        turnId: activeTurn.sessionTurnId,
        agentTurnId,
      });
    }
    if (agentTurnId) terminatedProviderTurnIds.add(agentTurnId);
    clearPendingTurnCompletionTimer();
    flushAssistantReasoningProjection(
      status === 'interrupted' || isCodexTurnInterruptedStatus(readCodexTurnStatus(notificationParams))
        ? 'abort'
        : 'turn-end',
    );
    pendingTurn = null;
    clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
    providerPromptForDeferredTemporaryRecoverableRetry = null;
    terminalPendingTurnFailure = null;
    originalTemporaryRecoverableFailure = null;
    setActive(false);
    if (status === 'interrupted' || isCodexTurnInterruptedStatus(readCodexTurnStatus(notificationParams))) {
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
      publishRollbackBoundaryForCompletedTurn(activeTurn, agentTurnId ?? null);
    }
    activeTurn.resolve();
  };

  const adoptProviderTurnFromActivity = (
    notificationParams: unknown,
    options: Readonly<{ allowUnownedAdoption: boolean }>,
  ): PendingTurn | null => {
    const activeTurn = pendingTurn;
    const explicitNotificationThreadId = readThreadId(notificationParams);
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

    if (activeTurn) {
      if (!activeTurn.agentTurnId) {
        activeTurn.agentTurnId = agentTurnId;
        activeTurn.providerStartAcknowledged = true;
        publishRuntimeEvent({
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
      params.ctx.logger?.debug?.('Codex app-server handed off an immediate provider-started successor turn', {
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
    );
    providerTurn.agentTurnId = agentTurnId;
    providerTurn.providerStartAcknowledged = true;
    pendingTurn = providerTurn;
    activeTurnHadMeaningfulActivity = false;
    deferredTemporaryRecoverableFailure = null;
    terminalPendingTurnFailure = null;
    originalTemporaryRecoverableFailure = null;
    promptForTemporaryRecoverableRetry = null;
    providerPromptForDeferredTemporaryRecoverableRetry = null;
    temporaryRecoverableRetryAttemptCount = 0;
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
      params.ctx.logger?.debug?.('Codex app-server ignored an unknown mismatched terminal turn', {
        threadId: activeTurn.threadId,
        activeAgentTurnId: activeTurn.agentTurnId,
        terminalTurnId,
      });
      return false;
    }
    if (terminalTurnId && !activeTurn.agentTurnId && !activeTurn.providerStartAcknowledged) {
      params.ctx.logger?.debug?.('Codex app-server ignored a terminal id before provider turn start was acknowledged', {
        threadId: activeTurn.threadId,
        terminalTurnId,
      });
      return false;
    }
    if (terminalTurnId && !activeTurn.agentTurnId) {
      activeTurn.agentTurnId = terminalTurnId;
      publishRuntimeEvent({ kind: 'turn-agent-id-observed', turnId: activeTurn.sessionTurnId, agentTurnId: terminalTurnId });
    }
    return true;
  };

  const completePendingTurn = (status: 'completed' | 'interrupted', notificationParams: unknown): void => {
    if (!pendingTurn) return;
    if (!canSettleTerminalPendingTurn(notificationParams)) return;
    if (status === 'interrupted' || isCodexTurnInterruptedStatus(readCodexTurnStatus(notificationParams))) {
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

  const reportProviderCapacityFailureForRecovery = (error: Error): void => {
    const classification = readRecord(
      (error as { runtimeAuthClassification?: unknown }).runtimeAuthClassification,
    );
    if (trimStringValue(classification?.kind) !== 'capacity') return;
    void params.ctx.sessions.current.auth.services.refreshRuntimeAuth({
      agentId: 'codex',
      serviceId: 'openai-codex',
      targetId: params.happierSessionId,
      classification,
      reason: 'provider_session_capacity_failure',
    }).catch((reportError: unknown) => {
      params.ctx.logger?.debug?.('Codex app-server capacity recovery report failed', {
        errorName: reportError instanceof Error ? reportError.name : typeof reportError,
      });
    });
  };

  const failPendingTurn = (
    error: Error,
    options: Readonly<{
      deferBackendError?: boolean;
      emitUndeliverablePrompt?: boolean;
    }> = {},
  ): void => {
    const activeTurn = pendingTurn;
    if (!activeTurn) return;
    clearPendingTurnCompletionTimer();
    flushAssistantReasoningProjection('abort');
    pendingTurn = null;
    clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
    const providerPromptWasPending = activeTurn.providerPrompt
      ? pendingProviderPrompts.has(activeTurn.providerPrompt)
      : false;
    if (options.emitUndeliverablePrompt === false) {
      clearPendingProviderPrompt(activeTurn.providerPrompt);
    } else {
      emitPendingProviderPromptAsUndeliverable(activeTurn.providerPrompt);
    }
    setActive(false);
    void publishImmediateProviderAccountUsageSnapshotForQuotaFailure(error);
    if (options.deferBackendError !== true) {
      deferredTemporaryRecoverableFailure = null;
      providerPromptForDeferredTemporaryRecoverableRetry = null;
      terminalPendingTurnFailure = resolveTerminalPendingTurnFailure(error);
      reportProviderCapacityFailureForRecovery(terminalPendingTurnFailure);
      const agentTurnId = activeTurn.agentTurnId;
      publishRuntimeEvent({
        kind: 'turn-failed',
        turnId: activeTurn.sessionTurnId,
        ...(agentTurnId ? { agentTurnId } : {}),
        issue: buildCodexAppServerTurnFailureIssue(terminalPendingTurnFailure, activeTurn),
      });
      publishRuntimeEvent({
        kind: 'backend-error',
        error: { message: terminalPendingTurnFailure.message },
      });
    } else {
      deferredTemporaryRecoverableFailure = error;
      providerPromptForDeferredTemporaryRecoverableRetry =
        options.emitUndeliverablePrompt === false && providerPromptWasPending
          ? activeTurn.providerPrompt
          : null;
    }
    activeTurn.reject(error);
  };

  const shouldDeferTemporaryRecoverableFailure = (error: Error): boolean => {
    return isCodexAppServerTemporaryRecoverableTurnFailureError(error)
      && temporaryRecoverableRetryAttemptCount === 0;
  };

  const resolveTerminalPendingTurnFailure = (error: Error): Error => {
    const originalFailure = originalTemporaryRecoverableFailure;
    if (!originalFailure || !isCodexAppServerTemporaryRecoverableTurnFailureError(error)) {
      return error;
    }
    return resolveRecoverableTurnFailureSecondFailure({
      originalFailure,
      latestFailure: error,
    }).failure;
  };

  const handleTurnCompletedNotification = (notificationParams: unknown): void => {
    const status = readCodexTurnStatus(notificationParams);
    if (status === 'failed') {
      if (!canSettleTerminalPendingTurn(notificationParams)) return;
      const failure = createErrorFromAppServerNotification(notificationParams, latestConnectedServiceRuntimeIdentity);
      const deferBackendError = shouldDeferTemporaryRecoverableFailure(failure);
      failPendingTurn(failure, {
        deferBackendError,
        emitUndeliverablePrompt: deferBackendError ? false : undefined,
      });
      return;
    }
    completePendingTurn('completed', notificationParams);
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
    nextClient.registerRequestHandler('account/chatgptAuthTokens/refresh', refreshChatGptAuthTokens);
    nextClient.registerNotificationHandler('account/rateLimits/updated', (notificationParams) => {
      void recordProviderAccountUsageSnapshot(notificationParams);
    });
    nextClient.registerNotificationHandler('thread/tokenUsage/updated', (notificationParams) => {
      handleTokenUsageNotification({
        notificationParams,
        modelId: currentModelId,
        emit(message) {
          publishRuntimeEvent({
            kind: 'transcript-agent-message-committed',
            agentId: 'codex',
            localId: message.id,
            body: message,
            meta: { source: 'codex-app-server-token-usage' },
          });
        },
      });
    });
    nextClient.registerNotificationHandler('thread/name/updated', (notificationParams) => {
      applyThreadNameUpdate(notificationParams);
    });
    nextClient.registerNotificationHandler('turn/started', (notificationParams) => {
      adoptProviderTurnFromActivity(notificationParams, {
        allowUnownedAdoption: true,
      });
    });
    nextClient.registerNotificationHandler('turn/completed', (notificationParams) => {
      if (deferTerminalNotificationUntilTurnStartAcknowledged('turn/completed', notificationParams)) return;
      handleTurnCompletedNotification(notificationParams);
    });
    nextClient.registerNotificationHandler('turn/interrupted', (notificationParams) => {
      if (deferTerminalNotificationUntilTurnStartAcknowledged('turn/interrupted', notificationParams)) return;
      handleTurnInterruptedNotification(notificationParams);
    });
    nextClient.registerNotificationHandler('error', (notificationParams) => {
      const record = readRecord(notificationParams);
      if (record?.willRetry === true) return;
      const failure = createErrorFromAppServerNotification(notificationParams, latestConnectedServiceRuntimeIdentity);
      const deferBackendError = shouldDeferTemporaryRecoverableFailure(failure);
      failPendingTurn(failure, {
        deferBackendError,
        emitUndeliverablePrompt: deferBackendError ? false : undefined,
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
      nextClient.registerNotificationHandler(method, (notificationParams) => {
        if (!adoptProviderTurnFromActivity(notificationParams, {
          allowUnownedAdoption: method === 'item/agentMessage/delta'
            || method === 'turn/diff/updated'
            || method === 'item/reasoning/summaryTextDelta'
            || method === 'item/reasoning/textDelta'
            || method === 'item/started',
        })) return;
        if (publishToolEventsFromNotification(method, notificationParams)) {
          activeTurnHadMeaningfulActivity = true;
        }
        if (observeAssistantReasoningNotification(method, notificationParams)) {
          activeTurnHadMeaningfulActivity = true;
          return;
        }
        markMeaningfulActivityFromNotification(method, notificationParams);
      });
    }
  };

  const ensureClient = async (): Promise<DisposableCodexAppServerClient> => {
    if (disposed) throw new Error('Codex app-server runtime has been disposed.');
    if (client) return client;
    if (!clientPromise) {
      const processEnv = readRuntimeProcessEnv();
      clientPromise = createCodexAppServerClient({
        exec: params.ctx.agentRuntime.exec,
        cwd: params.directory,
        processEnv,
        configOverrides: buildCodexAppServerConfigOverrides(normalizeMcpServers(params.mcpServers)),
      }).then((createdClient) => {
        if (disposed) {
          void createdClient.dispose().catch(() => undefined);
          throw new Error('Codex app-server runtime has been disposed.');
        }
        client = createdClient;
        attachClientHandlers(createdClient);
        void readCodexRuntimeRateLimitsSnapshot(createdClient)
          .then((result) => recordProviderAccountUsageSnapshot(result.rawSnapshot))
          .catch(() => undefined);
        return createdClient;
      }, (error: unknown) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  };

  const startOrLoadSession = async (options?: Readonly<Record<string, unknown>>): Promise<string> => {
    const appServerClient = await ensureClient();
    const resumeId = readResumeId(options);
    const existingSessionId = trimStringValue(options?.existingSessionId);
    const requestedThreadId = resumeId ?? existingSessionId;
    if (requestedThreadId) {
      publishThreadIdentity(requestedThreadId);
    }
    const policy = resolveCurrentPolicy();
    const policyKey = serializeCodexAppServerPolicy(policy);
    const permissionFields = buildCodexAppServerPermissionParams({
      policy,
      support: permissionSupport,
      target: 'thread',
    });
    const reasoningConfig = buildThreadConfigOverrideParams(currentReasoningEffort).config ?? {};
    const providerConfig = params.initialProviderBinding?.config ?? {};
    const threadConfig = { ...providerConfig, ...reasoningConfig };
    const commonFields = {
      ...(currentModelId ? { model: currentModelId } : {}),
      ...(params.initialProviderBinding
        ? { modelProvider: params.initialProviderBinding.modelProvider }
        : {}),
      ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
      ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
      ...permissionFields,
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
      params.ctx.logger.debug('Reading lean Codex app-server thread metadata after oversized resume response', {
        threadId: nextThreadId,
        timeoutMs: requestOptions?.timeoutMs ?? null,
      });
      try {
        const result = await appServerClient.request('thread/read', {
          threadId: nextThreadId,
          includeTurns: false,
        }, requestOptions);
        params.ctx.logger.debug('Completed lean Codex app-server thread metadata read after oversized resume response', {
          threadId: nextThreadId,
          elapsedMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        params.ctx.logger.debug('Failed lean Codex app-server thread metadata read after oversized resume response', {
          threadId: nextThreadId,
          elapsedMs: Date.now() - startedAt,
          error,
        });
        throw error;
      }
    };
    const resumeThread = async (nextThreadId: string): Promise<unknown> => {
      const resumeRequestOptions = options?.importHistory === true
        ? undefined
        : { timeoutMs: readCodexAppServerResumeRecoveryTimeoutMs(readRuntimeProcessEnv()) };
      try {
        return await requestWithPermissionFallback('thread/resume', {
          threadId: nextThreadId,
          ...commonFields,
          persistExtendedHistory: true,
        }, 'thread', resumeRequestOptions);
      } catch (error) {
        if (options?.importHistory === true || !isCodexAppServerOversizedJsonFrameError(error)) {
          throw error;
        }
        return await readResumedThreadMetadata(nextThreadId, resumeRequestOptions);
      }
    };
    const response = requestedThreadId
      ? await resumeThread(requestedThreadId)
      : await requestWithPermissionFallback('thread/start', {
        cwd: params.directory,
        ...commonFields,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
        }, 'thread');
    const nextThreadId = requestedThreadId && options?.preserveRequestedThreadId === true
      ? requestedThreadId
      : readThreadId(response) ?? requestedThreadId;
    if (!nextThreadId) {
      throw new Error('Codex app-server thread/start returned no thread id');
    }
    threadId = nextThreadId;
    startedEmptyThreadWithoutExplicitModel = !requestedThreadId && !Object.prototype.hasOwnProperty.call(commonFields, 'model');
    startedEmptyThreadPolicyKey = requestedThreadId ? null : policyKey;
    currentModelId = readModelId(response) ?? currentModelId;
    currentServiceTier = readServiceTier(response) ?? (hasServiceTierOverride ? currentServiceTier : null);
    publishThreadIdentity(nextThreadId);
    return nextThreadId;
  };

  const ensureThreadId = async (requestedSessionId?: string | null): Promise<string> => {
    const requested = trimSessionId(requestedSessionId);
    if (threadId && (!requested || requested === threadId)) return threadId;
    return await startOrLoadSession(requested ? { existingSessionId: requested, importHistory: false } : undefined);
  };

  const startTurnPromptAttempt = async (
    prompt: string,
    options?: RuntimeSendOptionsV1,
  ): Promise<void> => {
    const activeThreadId = await ensureThreadId();
    if (pendingTurn) throw new Error('Codex app-server already has a turn in flight');
    const appServerClient = await ensureClient();
    const pendingProviderPrompt = trackPendingProviderPrompt(prompt, options);
    turnSeq += 1;
    const activeTurn = createPendingTurn(
      activeThreadId,
      readRuntimeTurnId(options) ?? createCodexAppServerTurnId(),
      pendingProviderPrompt,
    );
    pendingTurn = activeTurn;
    activeTurnHadMeaningfulActivity = false;
    deferredTemporaryRecoverableFailure = null;
    terminalPendingTurnFailure = null;
    void activeTurn.promise.catch(() => undefined);
    setActive(true);
    publishRuntimeEvent({
      kind: 'turn-start',
      turnId: activeTurn.sessionTurnId,
      startedBy: 'user',
    });
    try {
      const policy = resolveCurrentPolicy();
      const requestParams: Record<string, unknown> = {
        ...buildCodexAppServerPermissionParams({
          policy,
          support: permissionSupport,
          target: 'turn',
        }),
        threadId: activeThreadId,
        input: buildCodexAppServerTurnInput({ text: prompt }),
        ...(currentModelId ? { model: currentModelId } : {}),
        ...(currentReasoningEffort ? { effort: currentReasoningEffort } : {}),
        ...(hasServiceTierOverride
          ? (currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null })
          : {}),
      };
      const response = await appServerClient.request('turn/start', requestParams)
        .then((result) => {
          if (Object.prototype.hasOwnProperty.call(requestParams, 'permissions')) {
            permissionSupport = 'supported';
          }
          return result;
        })
        .catch(async (error: unknown) => {
          if (!policy || !shouldRetryWithoutCodexAppServerPermissionProfile(error, requestParams)) {
            throw error;
          }
          permissionSupport = 'legacy';
          const retryParams = { ...requestParams };
          delete retryParams.permissions;
          return await appServerClient.request('turn/start', {
            ...retryParams,
            ...buildCodexAppServerLegacyPermissionParams({ policy, target: 'turn' }),
          });
        });
      const agentTurnId = readTurnId(response);
      activeTurn.providerStartAcknowledged = true;
      if (agentTurnId && activeTurn.interruptWhenProviderTurnIdArrives) {
        await appServerClient.request('turn/interrupt', {
          threadId: activeTurn.threadId,
          turnId: agentTurnId,
        }).catch((error: unknown) => {
          params.ctx.logger?.debug?.('Codex app-server late turn interrupt failed after cancellation', {
            errorName: error instanceof Error ? error.name : typeof error,
          });
        });
        return;
      }
      if (agentTurnId && activeTurn.agentTurnId !== agentTurnId) {
        activeTurn.agentTurnId = agentTurnId;
        publishRuntimeEvent({
          kind: 'turn-agent-id-observed',
          turnId: activeTurn.sessionTurnId,
          agentTurnId,
        });
      }
      replayDeferredTerminalNotification(activeTurn);
      markPendingProviderPromptAccepted(pendingProviderPrompt);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const deferBackendError = shouldDeferTemporaryRecoverableFailure(failure);
      failPendingTurn(failure, {
        deferBackendError,
        emitUndeliverablePrompt: deferBackendError ? false : undefined,
      });
      throw failure;
    }
  };

  const resolveTemporaryRecoverableRetryPrompt = (failure: Error): string | null => {
    if (!isCodexAppServerTemporaryRecoverableTurnFailureError(failure)) return null;
    const originalPrompt = promptForTemporaryRecoverableRetry;
    if (!originalPrompt) return null;
    const decision = resolveRecoverableTurnFailureRetryDecision({
      attemptCount: temporaryRecoverableRetryAttemptCount,
      maxRetries: 1,
      providerWillRetry: false,
      failureRetryAfterMs: null,
      failedTurnHadMeaningfulActivity: activeTurnHadMeaningfulActivity,
      promptMode: 'activity_aware',
      originalPrompt,
      continuationPrompt: temporaryRecoverableTurnContinuationPrompt,
    });
    if (decision.action !== 'retry') return null;
    if (!originalTemporaryRecoverableFailure) {
      originalTemporaryRecoverableFailure = failure;
    }
    if (decision.consumeRetryBudget) {
      temporaryRecoverableRetryAttemptCount += 1;
    }
    return decision.prompt;
  };

  const sendTurnPrompt = async (
    prompt: string,
    options?: RuntimeSendOptionsV1,
  ): Promise<void> => {
    promptForTemporaryRecoverableRetry = prompt;
    temporaryRecoverableRetryAttemptCount = 0;
    originalTemporaryRecoverableFailure = null;
    providerPromptForDeferredTemporaryRecoverableRetry = null;
    terminalPendingTurnFailure = null;
    await startTurnPromptAttempt(prompt, options);
  };

  const waitForTurnCompletion = async (): Promise<void> => {
    while (true) {
      const activeTurn = pendingTurn;
      if (!activeTurn) {
        const terminalFailure = terminalPendingTurnFailure;
        if (terminalFailure) {
          terminalPendingTurnFailure = null;
          throw terminalFailure;
        }
        const deferredFailure = deferredTemporaryRecoverableFailure;
        if (!deferredFailure) return;
        deferredTemporaryRecoverableFailure = null;
        const retryPrompt = resolveTemporaryRecoverableRetryPrompt(deferredFailure);
        const retryProviderPrompt = providerPromptForDeferredTemporaryRecoverableRetry;
        providerPromptForDeferredTemporaryRecoverableRetry = null;
        if (!retryPrompt) throw resolveTerminalPendingTurnFailure(deferredFailure);
        await startTurnPromptAttempt(
          retryPrompt,
          buildRuntimeSendOptionsForPendingProviderPrompt(retryProviderPrompt),
        );
        continue;
      }
      try {
        await activeTurn.promise;
        return;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const retryPrompt = resolveTemporaryRecoverableRetryPrompt(failure);
        const retryProviderPrompt = providerPromptForDeferredTemporaryRecoverableRetry;
        providerPromptForDeferredTemporaryRecoverableRetry = null;
        if (!retryPrompt) throw resolveTerminalPendingTurnFailure(failure);
        await startTurnPromptAttempt(
          retryPrompt,
          buildRuntimeSendOptionsForPendingProviderPrompt(retryProviderPrompt),
        );
      }
    }
  };

  const observeCompletionInBackground = (submitted: Promise<void>): void => {
    backgroundCompletion = submitted.then(() => waitForTurnCompletion());
    void backgroundCompletion.catch((error: unknown) => {
      params.ctx.logger?.debug?.(
        'Codex app-server background turn completion failed',
        buildCodexAppServerBackgroundCompletionFailureDiagnostics(error),
      );
    });
  };

  const waitForActiveProviderTurnId = async (activeTurn: PendingTurn): Promise<string | null> => {
    let agentTurnId = activeTurn.agentTurnId;
    if (agentTurnId) return agentTurnId;
    const waitStartedAt = Date.now();
    while (
      !agentTurnId
      && pendingTurn === activeTurn
      && Date.now() - waitStartedAt < CODEX_APP_SERVER_PROVIDER_TURN_ID_WAIT_TIMEOUT_MS
    ) {
      await delay(CODEX_APP_SERVER_PROVIDER_TURN_ID_WAIT_POLL_MS);
      agentTurnId = activeTurn.agentTurnId;
    }
    return agentTurnId ?? null;
  };

  const steerInFlightTurn = async (
    message: string,
    options?: RuntimeSendOptionsV1,
  ): Promise<void> => {
    const activeTurn = pendingTurn;
    if (!activeTurn) throw new Error('Codex app-server steer requires an active turn');
    const agentTurnId = activeTurn.agentTurnId ?? await waitForActiveProviderTurnId(activeTurn);
    if (!agentTurnId) throw new Error('Codex app-server steer requires an active provider turn id');
    const appServerClient = await ensureClient();
    const userMessageSeq = readRuntimeUserMessageSeq(options);
    const pendingProviderPrompt = trackPendingProviderPrompt(message, options);
    try {
      await appServerClient.request('turn/steer', {
        threadId: activeTurn.threadId,
        input: buildCodexAppServerTurnInput({ text: message }),
        expectedTurnId: agentTurnId,
      });
    } catch (error) {
      emitPendingProviderPromptAsUndeliverable(pendingProviderPrompt);
      throw error;
    }
    markPendingProviderPromptAccepted(pendingProviderPrompt);
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
      clearPendingTurnCompletionTimer();
      flushAssistantReasoningProjection('abort');
      pendingTurn = null;
      clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
      emitPendingProviderPromptAsUndeliverable(activeTurn.providerPrompt);
      activeTurn.resolve();
      setActive(false);
      return;
    }
    const appServerClient = await ensureClient();
    await appServerClient.request('turn/interrupt', {
      threadId: activeTurn.threadId,
      turnId: agentTurnId,
    });
    await activeTurn.promise.catch(() => undefined);
  };

  const rollbackConversation = async (
    request: CodexAppServerRollbackConversationRequest,
  ): Promise<CodexAppServerRollbackConversationResult> => {
    const target = readRollbackTarget(request.target);
    if (!target) {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        errorMessage: 'Codex app-server rollback target is invalid.',
      };
    }
    const activeThreadId = threadId;
    if (!activeThreadId) {
      return {
        ok: false,
        errorCode: 'thread_not_started',
        errorMessage: 'Codex app-server thread has not started.',
      };
    }
    if (pendingTurn || turnCompletionSettling) {
      return {
        ok: false,
        errorCode: 'turn_in_progress',
        errorMessage: 'Codex app-server cannot roll back while a turn is in flight.',
      };
    }
    const rollbackPlan = rollbackTracker.resolveRollbackPlan(target);
    if (!rollbackPlan) {
      return {
        ok: false,
        errorCode: 'invalid_parameters',
        errorMessage: 'No completed Codex app-server turn is available for the rollback target.',
      };
    }
    const appServerClient = await ensureClient();
    try {
      await appServerClient.request('thread/rollback', {
        threadId: activeThreadId,
        numTurns: rollbackPlan.numTurns,
      });
    } catch (error) {
      const unsupportedMessage = readRollbackUnsupportedErrorMessage(error);
      if (unsupportedMessage) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          errorMessage: unsupportedMessage,
        };
      }
      return {
        ok: false,
        errorCode: 'provider_rollback_failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const restoredToTurnId = rollbackPlan.affectedTurnIds[0] ?? 'unknown';
    for (const turnId of rollbackPlan.affectedTurnIds) {
      const agentTurnId = rollbackProviderTurnIdsBySessionTurnId.get(turnId);
      publishRuntimeEvent({
        kind: 'turn-rollback-applied',
        turnId,
        restoredToTurnId,
        ...(agentTurnId ? { agentTurnId } : {}),
      });
    }

    return {
      ok: true,
      target,
      threadId: activeThreadId,
    };
  };

  const resetOrDisposeRuntime = async (): Promise<void> => {
    disposed = true;
    emitAllPendingProviderPromptsAsUndeliverable();
    const activeTurn = pendingTurn;
    clearPendingTurnCompletionTimer();
    flushAssistantReasoningProjection('abort');
    pendingTurn = null;
    if (activeTurn) clearPendingHappierTitleToolNamesForTurn(activeTurn.sessionTurnId);
    activeTurn?.resolve();
    terminalPendingTurnFailure = null;
    deferredTemporaryRecoverableFailure = null;
    originalTemporaryRecoverableFailure = null;
    providerPromptForDeferredTemporaryRecoverableRetry = null;
    publishedToolEventKeys.clear();
    pendingHappierTitleToolNamesByCallId.clear();
    runtimeSubscribers.clear();
    threadId = null;
    active = false;
    lastActivityAtMs = null;
    backgroundCompletion = null;
    activeChatGptAuthTokensRefreshSelection = null;
    latestConnectedServiceRuntimeIdentity = null;
    const currentClient = client;
    client = null;
    clientPromise = null;
    publishedThreadId = null;
    startedEmptyThreadPolicyKey = null;
    await currentClient?.dispose();
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
  });

  const readAccountLabelForAppliedAccount = async (
    providerAccountId: string,
  ): Promise<string | null> => {
    try {
      const activeAccount = readCodexActiveProviderAccount(await (await ensureClient()).request('account/read'));
      if (activeAccount.providerAccountId !== providerAccountId) return null;
      return activeAccount.providerEmail;
    } catch (error) {
      params.ctx.logger?.debug?.('Codex app-server live account read failed after connected-service auth apply (ignored)', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return null;
    }
  };

  const applyConnectedServiceAuthGeneration = async (
    rawRequest: SessionConnectedServiceAuthApplyGenerationRequestV1,
  ): Promise<SessionConnectedServiceAuthApplyGenerationResponseV1> => {
    const request = normalizeCodexConnectedServiceAuthGenerationRequest(rawRequest);
    if (!request) {
      return {
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      };
    }
    const codexHome = resolveCodexHome(readRuntimeProcessEnv());
    const appServerClient = await ensureClient();
    const applied = await applyCodexConnectedServiceAuthGeneration({
      client: appServerClient,
      candidate: request.credential,
      forcedWorkspaceId: request.forcedWorkspaceId,
      forcedLoginMethod: request.forcedLoginMethod,
      persistAuthStore: async () => {
        await writeCodexConnectedServiceAuthStore({
          codexHome,
          credential: request.credential,
        });
      },
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
        ...(applied.recovery ? { recovery: applied.recovery } : {}),
      };
    }

    latestConnectedServiceRuntimeIdentity = buildConnectedServiceRuntimeIdentity(
      request,
      applied.activeAccountId,
      null,
    );
    if (applied.durability.persisted === false) {
      return {
        ok: false,
        errorCode: applied.durability.errorCode,
        error: applied.durability.errorCode,
        appliedVia: applied.appliedVia,
        activeAccountId: applied.activeAccountId,
        verification: {
          activeAccountId: applied.activeAccountId,
          proofStrength: 'exact',
          source: 'applied_credential',
        },
        durability: applied.durability,
      };
    }

    const accountLabel = await readAccountLabelForAppliedAccount(applied.activeAccountId);
    latestConnectedServiceRuntimeIdentity = buildConnectedServiceRuntimeIdentity(
      request,
      applied.activeAccountId,
      accountLabel,
    );
    try {
      const result = await readCodexRuntimeRateLimitsSnapshot(appServerClient);
      await recordProviderAccountUsageSnapshot(result.rawSnapshot, { includeLiveAccountIdentity: true });
    } catch (error) {
      params.ctx.logger?.debug?.('Codex app-server quota snapshot failed after connected-service auth apply', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return {
        ok: false,
        errorCode: 'post_apply_quota_probe_failed',
        error: 'post_apply_quota_probe_failed',
        appliedVia: applied.appliedVia,
        activeAccountId: applied.activeAccountId,
        verification: {
          activeAccountId: applied.activeAccountId,
          proofStrength: 'exact',
          source: 'applied_credential',
        },
        durability: applied.durability,
      };
    }

    return {
      ok: true,
      appliedVia: applied.appliedVia,
      activeAccountId: applied.activeAccountId,
      verification: {
        activeAccountId: applied.activeAccountId,
        proofStrength: 'exact',
        source: 'applied_credential',
        durability: applied.durability,
        ...(accountLabel ? { accountLabel } : {}),
      },
      durability: applied.durability,
      ...(accountLabel ? { accountLabel } : {}),
    };
  };

  const readConnectedServiceRuntimeIdentity = async (
    request: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  ): Promise<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1> => {
    const record = readRecord(request);
    if (record?.serviceId !== 'openai-codex') {
      return {
        ok: false,
        errorCode: 'runtime_identity_probe_unavailable',
        error: 'runtime_identity_probe_unavailable',
      };
    }
    const expected = readCodexConnectedServiceExpected(record.expected);
    const fanoutExpectedContext = record.reason === 'same_provider_account_exhausted'
      ? expected
      : undefined;
    let identity = latestConnectedServiceRuntimeIdentity;
    if (identity && !runtimeIdentityMatchesActiveSelection(identity)) {
      identity = await refreshLiveAccountRuntimeIdentity(fanoutExpectedContext);
    }
    if (!identity) {
      identity = await refreshLiveAccountRuntimeIdentity(fanoutExpectedContext);
      if (!identity) {
        return {
          ok: false,
          errorCode: 'runtime_identity_probe_unavailable',
          error: 'runtime_identity_probe_unavailable',
        };
      }
    }
    if (!codexRuntimeIdentityMatchesExpected({ identity, expected })) {
      return {
        ok: false,
        errorCode: 'runtime_identity_probe_account_mismatch',
        error: 'runtime_identity_probe_account_mismatch',
      };
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
        safeToApply: pendingTurn === null,
        inProviderTurn: pendingTurn !== null,
        profileId: identity.profileId,
        ...(identity.groupId ? { groupId: identity.groupId } : {}),
        ...(identity.generation === null ? {} : { generation: identity.generation }),
      },
    };
  };

  const runtime: CodexAppServerRuntime = {
    identity: {
      read() {
        return { providerSessionId: threadId };
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
    async send(input, options?: RuntimeSendOptionsV1) {
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
      if (options?.deliverAs === 'steer') {
        await steerInFlightTurn(text, options);
        return acceptedSendResult();
      }
      const submitted = sendTurnPrompt(text, options);
      observeCompletionInBackground(submitted);
      await submitted;
      return acceptedSendResult();
    },
    async cancel() {
      const hadActiveTurn = pendingTurn !== null;
      await cancelTurn();
      return cancelledResult(hadActiveTurn ? 'cancelled' : 'not_running');
    },
    rollbackConversation,
    applyConnectedServiceAuthGeneration,
    readConnectedServiceRuntimeIdentity,
    permissions: { capability: 'inline' },
    async updateConfig(update) {
      const updateRecord = readRecord(update);
      const nextPermissionMode = trimStringValue(updateRecord?.permissionMode);
      if (nextPermissionMode) {
        const nextPolicy = resolveCodexTerminalPermissionPolicy(nextPermissionMode);
        const nextPolicyKey = serializeCodexAppServerPolicy(nextPolicy);
        if (
          threadId
          && turnSeq === 0
          && pendingTurn === null
          && startedEmptyThreadPolicyKey !== null
          && startedEmptyThreadPolicyKey !== nextPolicyKey
        ) {
          threadId = null;
          publishedThreadId = null;
          startedEmptyThreadPolicyKey = null;
          startedEmptyThreadWithoutExplicitModel = false;
        }
        currentPermissionPolicyOverride = nextPolicy;
      }
      const nextModelId = trimStringValue(update.modelId);
      if (nextModelId) {
        if (
          threadId
          && turnSeq === 0
          && pendingTurn === null
          && startedEmptyThreadWithoutExplicitModel
          && currentModelId !== nextModelId
        ) {
          threadId = null;
          publishedThreadId = null;
          startedEmptyThreadPolicyKey = null;
          startedEmptyThreadWithoutExplicitModel = false;
        }
        currentModelId = nextModelId;
      }
      const configOption = readRecord(update.configOption);
      const configOptionId = normalizeCodexAppServerConfigOptionId(configOption?.id);
      const configOptionValue = trimStringValue(configOption?.value);
      if (configOptionId === CODEX_APP_SERVER_REASONING_EFFORT_CONFIG_OPTION_ID) {
        currentReasoningEffort = configOptionValue ?? currentReasoningEffort;
      }
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
      const localInputId = typeof options?.localId === 'string' && options.localId.trim().length > 0
        ? options.localId
        : null;
      const localInputIds = [
        ...(localInputId ? [localInputId] : []),
        ...(options?.localIds ?? []),
      ].filter((localId, index, values) => localId.trim().length > 0 && values.indexOf(localId) === index);
      const userMessageSeq = typeof options?.userMessageSeq === 'number' && Number.isFinite(options.userMessageSeq)
        ? Math.trunc(options.userMessageSeq)
        : null;
      const userMessageSeqs = [
        ...(userMessageSeq === null ? [] : [userMessageSeq]),
        ...(options?.userMessageSeqs ?? []),
      ].filter((seq, index, values) => Number.isSafeInteger(seq) && seq >= 0 && values.indexOf(seq) === index);
      await steerInFlightTurn(prompt, {
        deliverAs: 'steer',
        ...(localInputId ? { localInputId } : {}),
        ...(localInputIds.length === 0 ? {} : { localInputIds }),
        ...(userMessageSeq === null ? {} : { userMessageSeq }),
        ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
      });
    },
    setOnPromptAcceptedByProvider(callback) {
      onPromptAcceptedByProvider = callback;
    },
    setOnUndeliverablePrompts(callback) {
      onUndeliverablePrompts = callback;
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

  codexAppServerRuntimeStarters.set(runtime, startOrLoadSession);
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
