import { createClaudeRuntimeAuthIdentity } from '../../../auth/services/runtime/requestIdentity.js';

import {
    AgentRuntimeJsonValueSchema,
    canPublishSessionResumeIdentity,
    type AgentSessionHostServices,
    type AgentExecutionRunHooksServiceV1,
    type AgentSessionHookServerStartRequest,
    type AgentSessionProviderBinding,
    type AgentSessionRuntime,
    type AgentSessionRuntimeEvent,
    type AgentSessionSkillDelivery,
    type AgentSessionMcpToolPolicy,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { HappierStructuredInputV1Schema } from '@happier-dev/plugin-sdk/sessions';
import type { AgentSessionInputFilesService } from '@happier-dev/plugin-sdk/agents/runtime';
import { createClaudeMcpUsageWitness } from './mcpUsage.js';
import { createClaudeSkillUsageWitness } from './skillUsage.js';
import { CLAUDE_MCP_CONFIG_UNAVAILABLE_CODE, readClaudeMcpStartupFailure } from '../../../mcp/managedPolicy.js';
import { parseMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildClaudeMcpConfigArgs, materializeClaudeMcpConfigArgsForSpawn } from '../../../mcp/materializeConfigArgs.js';
import {
    redactBugReportSensitiveText,
    PluginError,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import type { SessionGoalControlFailureV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createClaudeRuntimeActivityPublisher } from '../../shared/runtimeActivityPublisher.js';
import {
    readClaudePendingLocalId,
} from '../../providerOperations.js';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';
import { projectSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
    createClaudePermissionEngine,
    type ClaudePermissionEngine,
} from '../../../permissions/createClaudePermissionEngine.js';
import {
    buildClaudeHookPluginHooks,
    buildClaudeHookPluginManifest,
} from '../../../hooks/settings.js';
import { buildDefaultPermissionHookResponse } from '../../../hooks/protocol.js';
import { resolveClaudePermissionHookCeilingMs, resolveClaudePermissionHookTimeoutSeconds } from '../../../hooks/permissionHookTimeout.js';
import {
    createClaudeSdkNoResultError,
    queryWithContext,
    type ClaudeSdkQueryContext,
} from '../../../sdk/query.js';
import { ClaudeSdkQuery, type ClaudeSdkPromptTransportOutcome } from '../../../sdk/query.js';
import type {
    CanCallToolCallback,
    PermissionResult,
    SDKAssistantMessage,
    SDKMessage,
    SDKResultMessage,
    SDKSystemMessage,
    SDKUserMessage,
} from '../../../sdk/types.js';
import { createClaudeTaskNotificationToolResultProjector, readClaudeTaskLifecycleEnvelope } from '../../../transcripts/taskNotification.js';
import { readClaudeNativePeerMessage } from '../../../transcripts/nativeSemanticProjection.js';
import { readClaudeToolResultMediaRequests } from '../../../transcripts/toolResultMedia.js';
import { buildClaudeJsonlProviderFactLocalIdFromParts } from '../../../transcripts/providerFactIdentity.js';
import { readClaudeJsonlRowTimestampMs } from '../../../transcripts/jsonlReplaySuppression.js';
import { recordClaudeRuntimeProviderAccountUsageSnapshot } from '../../accountUsage.js';
import { buildClaudeLiveContextUsageSnapshot } from '../../../usage/liveContextSnapshot.js';
import { buildClaudeAssistantUsageObservation } from '../../../usage/buildAssistantObservation.js';
import { readClaudeCompactionMetadata } from '../../../transcripts/compactionMetadata.js';
import { buildClaudeSdkResultUsageObservation, resolveClaudeSdkResultMainModelId } from '../../../usage/buildSdkResultObservation.js';
import type {
    ClaudeTokenUsage,
    ClaudeUsageObservation,
    ClaudeUsageObservationSubscription,
} from '../../../usage/types.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';
import type {
    ClaudeProviderPromptDeliveryOutcomeCallback,
    ClaudeRuntimePromptSubmissionOutcome,
    ClaudeRuntimeTurnOperations,
} from '../../providerOperations.js';
import {
    ClaudeProviderEventSchema,
    readClaudeProviderEvent,
    type ClaudeProviderEvent,
} from '../../providerEvents.js';
import {
    buildClaudeSessionRuntimeIssue,
    mapClaudeProviderFailureToUsageDetails,
    type ClaudeSessionRuntimeIssueSource,
    type ClaudeSessionRuntimeUsageLimitDetails,
} from '../../issues/runtimeIssues.js';
import {
    createClaudeUnifiedWorkflowRuntime,
} from '../../../workflowRecords/index.js';
import { createClaudeUnifiedGoalRuntime } from '../../terminal/unified/goalRuntime.js';
import { computeClaudeSubscriptionAccessTokenFingerprint } from '../../../auth/services/cloud/refreshBridge.js';
import { readClaudeSubscriptionRuntimeAuthSelectionFromEnv } from '../../../auth/services/runtime/index.js';
import {
    createClaudeAgentSdkGoalStatusTail,
    type ClaudeAgentSdkGoalStatusTail,
} from './goalStatusTail.js';
import {
    extractTextDeltaFromStreamEvent,
    extractTextStartFromStreamEvent,
    extractToolResultBlocksFromSdkMessage,
    extractToolUseBlocksFromSdkMessage,
    hasClaudeAgentSdkDefinitiveSubagentRuntimeAuthFailureEvidence,
    readClaudeAgentSdkResultFailure,
    shouldSurfaceClaudeAgentSdkRuntimeFailure,
} from './streamEvents.js';
import { createClaudeAgentSdkRetryProgress } from './retryProgress.js';
import { buildClaudeSdkQueryLaunchOptions } from './launchOptions.js';
import { createClaudeSdkCompactionControl } from './compactionControl.js';
import {
    createClaudeProviderActivityLedger,
    isClaudeProviderActivityHookObservationLoss,
    isReplayClaudeAgentSdkMessage,
    normalizeClaudeProviderTaskEvent,
    readClaudeProviderTaskToolTarget,
    type ClaudeProviderTaskActivity,
} from './providerActivity.js';
import {
    applyClaudeProviderTaskActivity,
    publishClaudeProviderTaskInventory,
    readClaudeRuntimeConfigEffortUpdate,
    readClaudeRuntimeConfigModelUpdate,
    readClaudeRuntimeConfigUltracodeUpdate,
    readClaudeRuntimeString,
    respondToClaudePermission,
} from '../../shared/runtimeHelpers.js';
import { createClaudePermissionHookHandler } from '../../shared/permissionHookHandler.js';
import { isClaudePrimaryNativeActivity } from '../../nativeActivity.js';
import { buildClaudeHookSettingsOverlay } from '../../../hooks/settings.js';
import type { ClaudeSettingSourceV2 } from '@happier-dev/protocol/agents/claude/settings-policy';
import { readClaudeNativeCommands } from '../../../transcripts/nativeCommands.js';
import { resolveClaudeLaunchSettingsOverlayArgs, type ClaudeHelperModelEnv } from '../../launchSettings.js';
import { buildClaudePluginDirArgs } from '../../pluginDirArgs.js';
import { buildClaudeEffortCliArgs } from '../../reasoningEffort.js';
import { buildClaudePermissionModeArgs, mapToClaudePermissionMode } from '../../permissionMode.js';
import { materializeClaudeStartupInstructions } from '../../startupInstructions.js';
import { prepareClaudeTerminalConfigHome } from '../../terminal/configHome.js';
import { createClaudeAgentSdkResumeIdentityOwner } from './resumeIdentity.js';
import type { ClaudeUnifiedTerminalContext } from '../../terminal/unified/turnOperations.js';
import {
    readClaudeAssistantModelId,
    readClaudeMainChainAssistantModelId,
    type ClaudeEffectiveModelEvidence,
    type ClaudeEffectiveModelEvidenceSubscription,
} from '../../effectiveModelEvidence.js';
import type {
    ClaudeRemoteAdvancedOptions,
} from '../../../../protocol/remoteSettings.js';

function readAgentToolInputRecord(value: unknown): Readonly<Record<string, JsonValue>> | null {
    const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
    return parsed.success && parsed.data !== null && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
        ? parsed.data as Readonly<Record<string, JsonValue>>
        : null;
}

function deniedToolInterception(message: string): PermissionResult {
    return { behavior: 'deny', message, interrupt: true };
}

type ClaudeAgentSdkContextBase = Readonly<{
    logger: ClaudeUnifiedTerminalContext['logger'];
    agentRuntime: Readonly<{
        exec: ClaudeSdkQueryContext;
        toolExecution: ClaudeUnifiedTerminalContext['agentRuntime']['toolExecution'];
        nativeHome?: ClaudeUnifiedTerminalContext['agentRuntime']['nativeHome'];
        inputFiles?: AgentSessionInputFilesService;
        hooks?: AgentExecutionRunHooksServiceV1;
    }>;
}>;

export type ClaudeAgentSdkSessionContext = ClaudeAgentSdkContextBase & Readonly<{
    agentRuntime: ClaudeAgentSdkContextBase['agentRuntime'] & Readonly<{
        awaitTurnPublication?: (turnId: string, signal?: AbortSignal) => Promise<void>;
        /** The host's `adoptsHeldAgent`: this runner adopts the Agent its crashed predecessor left running. */
        adoptsHeldAgent?: boolean;
        /** The host's `startsRemote`: the first prompt of this new Session arrives through the host. */
        startsRemote?: boolean;
        modes?: ClaudeUnifiedTerminalContext['agentRuntime']['modes'];
        sessionHooks: ClaudeUnifiedTerminalContext['agentRuntime']['sessionHooks'];
        transcripts: ClaudeUnifiedTerminalContext['agentRuntime']['transcripts'];
        accountUsage: ClaudeUnifiedTerminalContext['agentRuntime']['accountUsage'];
    }>;
    sessions: ClaudeUnifiedTerminalContext['sessions'];
}>;

export type ClaudeAgentSdkExecutionRunContext = ClaudeAgentSdkContextBase & Readonly<{
    agentRuntime: ClaudeAgentSdkContextBase['agentRuntime'] & Readonly<{
        fileFollow: ClaudeUnifiedTerminalContext['agentRuntime']['transcripts']['fileFollow'];
    }>;
    sessions?: never;
}>;

export type ClaudeAgentSdkContext = ClaudeAgentSdkSessionContext | ClaudeAgentSdkExecutionRunContext;

type ProviderEventMessage = ClaudeProviderEvent;
type ClaudeProviderFailureEvidence = Readonly<{
    code: string;
    source: ClaudeSessionRuntimeIssueSource;
    preview: string | null;
    occurredAtMs?: number;
    usageLimit?: ClaudeSessionRuntimeUsageLimitDetails | null;
}>;
import { readClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';
const readString = readClaudeRuntimeString;
const CLAUDE_CONTEXT_USAGE_REFRESH_CONFIG_OPTION_ID = 'context_usage_refresh';

function isSdkSystemMessage(message: SDKMessage): message is SDKSystemMessage {
    return message.type === 'system';
}

function isSdkAssistantMessage(message: unknown): message is SDKAssistantMessage {
    return isRecord(message) && message.type === 'assistant'
        && typeof message.message === 'object'
        && message.message !== null
        && !Array.isArray(message.message);
}

function isSdkResultMessage(message: SDKMessage): message is SDKResultMessage {
    return message.type === 'result';
}

function readSdkAssistantModelId(message: SDKMessage): string | null {
    return readClaudeMainChainAssistantModelId(message);
}

function readSdkAssistantUsage(message: SDKMessage): ClaudeTokenUsage | null {
    if (!isSdkAssistantMessage(message)) return null;
    const rawUsage = (message.message as Readonly<Record<string, unknown>>).usage;
    const usage = isRecord(rawUsage) ? rawUsage : null;
    if (!usage) return null;
    const inputTokens = readNonnegativeInteger(usage.input_tokens);
    const outputTokens = readNonnegativeInteger(usage.output_tokens);
    const cacheCreationTokens = readNonnegativeInteger(usage.cache_creation_input_tokens);
    const cacheReadTokens = readNonnegativeInteger(usage.cache_read_input_tokens);
    const creation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
    const longWrite = readNonnegativeInteger(creation?.ephemeral_1h_input_tokens);
    const shortWrite = readNonnegativeInteger(creation?.ephemeral_5m_input_tokens);
    if (
        inputTokens === null
        && outputTokens === null
        && cacheCreationTokens === null
        && cacheReadTokens === null
    ) return null;
    return {
        ...(inputTokens !== null ? { input_tokens: inputTokens } : {}),
        ...(outputTokens !== null ? { output_tokens: outputTokens } : {}),
        ...(cacheCreationTokens !== null
            ? { cache_creation_input_tokens: cacheCreationTokens }
            : {}),
        ...(cacheReadTokens !== null ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(longWrite !== null || shortWrite !== null ? { cache_creation: {
            ...(longWrite !== null ? { ephemeral_1h_input_tokens: longWrite } : {}),
            ...(shortWrite !== null ? { ephemeral_5m_input_tokens: shortWrite } : {}),
        } } : {}),
    };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonnegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : null;
}

function readRefreshedAccessToken(value: unknown): string | null {
    if (!isRecord(value) || value.status !== 'refreshed' || !isRecord(value.result)) return null;
    return readString(value.result.accessToken);
}

function createDeferred(publishTurnTerminal = true): Readonly<{
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
    /**
     * One canonical terminal event per turn. The claim lives on the turn, not on the message
     * loop, so the stream owner and the local cancellation owner cannot both publish one.
     */
    claimTerminalPublication(): boolean;
}> {
    let resolvePromise: (() => void) | null = null;
    let rejectPromise: ((error: Error) => void) | null = null;
    // Native controls have a transport completion, but do not own a host turn.
    let terminalPublished = !publishTurnTerminal;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        resolve() {
            resolvePromise?.();
        },
        reject(error) {
            rejectPromise?.(error);
        },
        claimTerminalPublication() {
            if (terminalPublished) return false;
            terminalPublished = true;
            return true;
        },
    };
}

type DeferredCompletion = ReturnType<typeof createDeferred>;

const PROVIDER_ERROR_PREVIEW_MAX_LENGTH = 800;

function projectPromptTransportOutcome(outcome: ClaudeSdkPromptTransportOutcome): ClaudeRuntimePromptSubmissionOutcome {
    if (outcome.kind === 'accepted') return outcome;
    const reason = sanitizeProviderErrorPreview(outcome.error.message) ?? 'Claude SDK prompt transport failed.';
    const startupFailure = readClaudeMcpStartupFailure(outcome.error);
    const failureCause = projectSessionRuntimeFailureCause(outcome.error, startupFailure ? 'client_start' : 'turn_start', 'agent.turn');
    return { kind: outcome.kind, reason, failureCause, ...startupFailure };
}

function sanitizeProviderErrorPreview(value: unknown): string | null {
    const raw = readString(value);
    if (!raw) return null;
    const redacted = redactBugReportSensitiveText(raw)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
        .replace(/\bsk-ant-[A-Za-z0-9._~+/=-]+/giu, 'sk-ant-[redacted]');
    return redacted.length > PROVIDER_ERROR_PREVIEW_MAX_LENGTH
        ? `${redacted.slice(0, PROVIDER_ERROR_PREVIEW_MAX_LENGTH)}...`
        : redacted;
}

function normalizeProviderErrorCode(value: string | null): string {
    const normalized = value
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '_')
        .replace(/^_+|_+$/gu, '');
    if (!normalized) return 'claude_sdk_result_error';
    if (normalized === 'authentication_failed') return 'claude_authentication_failed';
    if (normalized.startsWith('claude_')) return normalized;
    return `claude_${normalized}`;
}

function summarizeFailureStderr(stderr: string | undefined): string | null {
    if (!stderr?.trim()) return null;
    // Native stderr can echo prompts as well as credentials. Emit only a bounded
    // classification, never an excerpt or the missing native session identity.
    if (/\bNo (?:conversation|session) found\b/iu.test(stderr)) {
        return 'Native resume state not found (details redacted)';
    }
    return 'Native stderr present (details redacted)';
}

function readFailureDiagnosticCode(code: string): string {
    // The provider's error field is free-form; normalization alone does not make
    // it safe to log. Retain known machine codes, not arbitrary provider text.
    switch (code) {
        case 'claude_authentication_failed':
        case 'claude_error_during_execution':
        case 'claude_error_max_turns':
        case 'claude_sdk_result_error':
        case 'claude_sdk_no_result':
        case 'claude_sdk_stream_error':
        case 'claude_agent_sdk_resume_identity_mismatch':
        case CLAUDE_MCP_CONFIG_UNAVAILABLE_CODE:
            return code;
        default:
            return 'Unrecognized failure code (details redacted)';
    }
}

function classifyFailureSource(params: Readonly<{
    code: string;
    preview: string | null;
}>): ClaudeSessionRuntimeIssueSource {
    if (
        params.code === 'claude_authentication_failed'
        || params.preview?.match(/\b(not logged in|login|auth(?:entication)? failed|unauthorized)\b/iu)
    ) {
        return 'auth_error';
    }
    return 'agent_session_error';
}

function readAssistantText(message: SDKAssistantMessage): string | null {
    const content = message.message.content;
    if (!Array.isArray(content)) return null;
    const text = content
        .map((block) => block.type === 'text' ? readString(block.text) : null)
        .filter((part): part is string => part !== null)
        .join('\n\n')
        .trim();
    return text.length > 0 ? text : null;
}

function readMessageId(message: unknown, fallback: string): string {
    const record = isRecord(message) ? message : null;
    return readString(record?.uuid)
        ?? readString(record?.id)
        ?? readString(record?.request_id)
        ?? fallback;
}

function readProviderFailureEvidence(message: SDKMessage): ClaudeProviderFailureEvidence | null {
    if (!isSdkAssistantMessage(message)) return null;
    const record = message as Readonly<Record<string, unknown>>;
    const providerErrorCode = readString(record.error);
    const isApiErrorMessage = record.isApiErrorMessage === true;
    if (!providerErrorCode && !isApiErrorMessage) return null;
    if (!shouldSurfaceClaudeAgentSdkRuntimeFailure(message)) return null;
    const preview = sanitizeProviderErrorPreview(readAssistantText(message));
    const code = normalizeProviderErrorCode(providerErrorCode ?? 'provider_error');
    return {
        code,
        occurredAtMs: readClaudeJsonlRowTimestampMs(record) ?? Date.now(),
        source: classifyFailureSource({ code, preview }),
        preview,
        usageLimit: mapClaudeProviderFailureToUsageDetails(message),
    };
}

function buildResultFailureEvidence(
    message: SDKResultMessage,
    providerFailure: ClaudeProviderFailureEvidence | null,
): ClaudeProviderFailureEvidence {
    const resultPreview = sanitizeProviderErrorPreview(readClaudeAgentSdkResultFailure(message) ?? message.result);
    const code = providerFailure?.code
        ?? normalizeProviderErrorCode(readString(message.subtype) ?? 'result_error');
    const preview = providerFailure?.preview ?? resultPreview;
    return {
        code,
        occurredAtMs: providerFailure?.occurredAtMs ?? readClaudeJsonlRowTimestampMs(message as Readonly<Record<string, unknown>>) ?? Date.now(),
        source: providerFailure?.source ?? classifyFailureSource({ code, preview }),
        preview,
        usageLimit: providerFailure?.usageLimit ?? mapClaudeProviderFailureToUsageDetails(message),
    };
}

function createResultError(message: SDKResultMessage, providerFailure: ClaudeProviderFailureEvidence | null): Error {
    const subtype = readString(message.subtype) ?? 'unknown';
    const failure = buildResultFailureEvidence(message, providerFailure);
    const details = [
        `is_error=${message.is_error === true ? 'true' : 'false'}`,
        `code=${failure.code}`,
        failure.preview ? `preview=${failure.preview}` : null,
    ].filter((part): part is string => part !== null);
    return new Error(`Claude Agent SDK turn failed with result subtype ${subtype} (${details.join(', ')})`);
}

function createProviderFailureError(failure: ClaudeProviderFailureEvidence): Error {
    const details = [
        `code=${failure.code}`,
        failure.preview ? `preview=${failure.preview}` : null,
    ].filter((part): part is string => part !== null);
    return new Error(`Claude Agent SDK provider failure (${details.join(', ')})`);
}

function readTimeoutMs(value: unknown): number | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const timeoutMs = (value as Readonly<Record<string, unknown>>).timeoutMs;
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.trunc(timeoutMs)
        : null;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number | null): Promise<T> {
    if (timeoutMs === null) return await operation;
    const result = await raceWithTimeout(operation, timeoutMs);
    switch (result.type) {
        case 'resolved':
            return result.value;
        case 'rejected':
            throw result.error;
        case 'timeout':
            throw new Error(`Timed out after ${timeoutMs}ms`);
    }
}

const readEffortFromRuntimeConfigUpdate = readClaudeRuntimeConfigEffortUpdate;
const readUltracodeFromRuntimeConfigUpdate = readClaudeRuntimeConfigUltracodeUpdate;

async function* createPromptStream(prompt: SDKUserMessage['message']['content'], uuid: string): AsyncIterable<SDKUserMessage> {
    yield {
        type: 'user',
        uuid,
        message: {
            role: 'user',
            content: prompt,
        },
    };
}

class ClaudeBrowserImageUnavailableError extends Error {
    readonly code = 'browser_media_unavailable' as const;
    constructor() { super('Browser image bytes could not be verified by the Session host'); }
}

async function resolvePromptContent(
    prompt: string,
    structuredInput: unknown,
    inputFiles?: AgentSessionInputFilesService,
): Promise<SDKUserMessage['message']['content']> {
    if (!isRecord(structuredInput) || !Array.isArray(structuredInput.imageInputs) || structuredInput.imageInputs.length === 0) return prompt;
    const parsed = HappierStructuredInputV1Schema.safeParse(structuredInput);
    if (!parsed.success || !inputFiles) throw new ClaudeBrowserImageUnavailableError();
    const content: Exclude<SDKUserMessage['message']['content'], string> = [{ type: 'text', text: prompt }];
    for (const image of parsed.data.imageInputs ?? []) {
        const verified = await inputFiles.readVerifiedImage(image);
        if (!verified) throw new ClaudeBrowserImageUnavailableError();
        const prefix = `data:${verified.mimeType};base64,`;
        if (!verified.url.startsWith(prefix)) throw new ClaudeBrowserImageUnavailableError();
        content.push({ type: 'image', source: { type: 'base64', media_type: verified.mimeType, data: verified.url.slice(prefix.length) } });
    }
    return content;
}

function createIdlePromptStream(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next: async (): Promise<IteratorResult<SDKUserMessage>> => {
                    if (signal.aborted) return { done: true, value: undefined };
                    await new Promise<void>((resolve) => {
                        signal.addEventListener('abort', () => resolve(), { once: true });
                    });
                    return { done: true, value: undefined };
                },
            };
        },
    };
}

function readSdkSidechainId(value: unknown): string | undefined {
    return isRecord(value) ? readClaudeProviderIdentityValue(value.parent_tool_use_id) ?? undefined : undefined;
}

function mapSdkRuntimeEvent(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    turnId: string | null;
    providerFailure?: ClaudeProviderFailureEvidence | null;
}>): ProviderEventMessage | null {
    const text = extractTextDeltaFromStreamEvent(params.message)
        ?? extractTextStartFromStreamEvent(params.message);
    if (text) {
        return ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'message-delta',
            ...(readSdkSidechainId(params.message) ? { sidechainId: readSdkSidechainId(params.message) } : {}),
            ...(params.turnId && !isReplayClaudeAgentSdkMessage(params.message) && !readSdkSidechainId(params.message)
                ? { turnId: params.turnId } : {}),
            delta: { text },
        });
    }
    if (isSdkResultMessage(params.message) && !params.turnId) return null;
    if (isSdkResultMessage(params.message) && params.message.subtype === 'success' && params.message.is_error !== true) {
        return ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'turn-complete',
            turnId: params.turnId,
            summary: {
                agentId: 'claude',
                result: params.message.result ?? null,
            },
        });
    }
    if (isSdkResultMessage(params.message)) {
        const failure = buildResultFailureEvidence(params.message, params.providerFailure ?? null);
        return ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'turn-failed',
            turnId: params.turnId,
            issue: buildClaudeSessionRuntimeIssue({
                code: failure.code,
                source: failure.source,
                occurredAt: Date.now(),
                agentId: 'claude',
                sanitizedPreview: failure.preview,
                usageLimit: failure.usageLimit,
            }),
        });
    }
    return readClaudeProviderEvent(params.message);
}

function mapSdkTranscriptEvent(params: Readonly<{
    message: unknown;
    sessionId: string;
    sequence: number;
    turnId: string | null;
}>): ProviderEventMessage | null {
    const peerMessage = readClaudeNativePeerMessage(params.message);
    const text = peerMessage?.text
        ?? (isSdkAssistantMessage(params.message) ? readAssistantText(params.message) : null);
    if (!text) return null;
    const record = params.message as Readonly<Record<string, unknown>>;
    // Main-chain native text is also observed by ordered JSONL follow. Both
    // readers must publish the same fact identity. SDK-only error diagnostics
    // and child messages do not have that main-chain text projection.
    const sourceLocalId = record.isSidechain !== true && !readSdkSidechainId(params.message)
        && record.isApiErrorMessage !== true
        ? buildClaudeJsonlProviderFactLocalIdFromParts({
            type: readString(record.type) ?? '',
            id: readString(record.uuid) ?? '',
        })
        : null;
    return ClaudeProviderEventSchema.parse({
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'transcript-agent-message-committed',
        ...(params.turnId && isSdkAssistantMessage(params.message)
            && !isReplayClaudeAgentSdkMessage(params.message) && !readSdkSidechainId(params.message)
            ? { turnId: params.turnId } : {}),
        ...(readSdkSidechainId(params.message) ? { sidechainId: readSdkSidechainId(params.message) } : {}),
        agentId: 'claude',
        localId: sourceLocalId ?? `claude-sdk-${readMessageId(params.message, `assistant-${params.sequence}`)}`,
        body: {
            type: 'message',
            message: text,
            ...(peerMessage ? { peer: peerMessage.peer } : {}),
        },
        meta: {
            source: 'claude-agent-sdk',
        },
    });
}

function mapResultTranscriptEvent(params: Readonly<{
    message: SDKResultMessage;
    sessionId: string;
    sequence: number;
    turnId: string | null;
}>): ProviderEventMessage | null {
    const text = params.message.structured_output === undefined
        ? readString(params.message.result)
        : JSON.stringify(params.message.structured_output);
    if (!text) return null;
    return ClaudeProviderEventSchema.parse({
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'transcript-agent-message-committed',
        ...(params.turnId ? { turnId: params.turnId } : {}),
        agentId: 'claude',
        localId: `claude-sdk-result-${readMessageId(params.message, `result-${params.sequence}`)}`,
        body: {
            type: 'message',
            message: text,
        },
        meta: {
            source: 'claude-agent-sdk-result',
        },
    });
}

function mapSdkResultUsageTranscriptEvent(params: Readonly<{
    message: SDKResultMessage;
    sessionId: string;
    sequence: number;
    modelId: string | null;
}>): ProviderEventMessage | null {
    const usage = isRecord(params.message.usage) ? params.message.usage : null;
    const modelUsage = isRecord(params.message.modelUsage) ? params.message.modelUsage : null;
    const providerSessionId = readClaudeProviderIdentityValue(params.message.session_id);
    const subtype = readString(params.message.subtype);
    if (!usage || !modelUsage || !providerSessionId || !subtype) return null;
    const messageId = readMessageId(params.message, `result-${params.sequence}`);
    return ClaudeProviderEventSchema.parse({
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'transcript-agent-message-committed',
        agentId: 'claude',
        localId: `claude-sdk-result-usage-${messageId}`,
        body: {
            type: 'result',
            subtype,
            uuid: messageId,
            session_id: providerSessionId,
            usage,
            modelUsage,
            total_cost_usd: params.message.total_cost_usd,
        },
        meta: {
            source: 'claude-agent-sdk-result-usage',
            ...(params.modelId ? { modelId: params.modelId } : {}),
        },
    });
}

function mapSdkToolResultRuntimeEvents(params: Readonly<{
    message: unknown;
    resultMessage: unknown;
    sessionId: string;
    turnId: string | null;
    toolNameByCallId?: ReadonlyMap<string, string>;
    emittedAtMs?: number;
}>): ProviderEventMessage[] {
    const result = isRecord(params.resultMessage) ? params.resultMessage : null;
    const sidechainId = readSdkSidechainId(params.message) ?? readClaudeProviderIdentityValue(result?.sidechainId);
    return extractToolResultBlocksFromSdkMessage(params.resultMessage).map(block => {
        const toolName = params.toolNameByCallId?.get(block.toolUseId);
        return ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: params.emittedAtMs ?? Date.now(),
            kind: 'tool-result',
            ...(sidechainId ? { sidechainId } : {}),
            ...(params.turnId && !isReplayClaudeAgentSdkMessage(params.message) ? { turnId: params.turnId } : {}),
            toolCallId: block.toolUseId,
            output: block.output,
            ...(block.isError === undefined ? {} : { isError: block.isError }),
            ...(toolName ? { toolName } : {}),
        });
    });
}

function mapSdkToolRuntimeEvents(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    turnId: string | null;
    toolNameByCallId: Map<string, string>;
    taskNotificationProjector: ReturnType<typeof createClaudeTaskNotificationToolResultProjector>;
}>): Readonly<{ events: ProviderEventMessage[]; projectedTaskResult: boolean }> {
    const events: ProviderEventMessage[] = [];
    const sidechainId = readSdkSidechainId(params.message);
    for (const block of extractToolUseBlocksFromSdkMessage(params.message)) {
        params.toolNameByCallId.set(block.id, block.name);
        events.push(ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'tool-call',
            ...(sidechainId ? { sidechainId } : {}),
            ...(params.turnId && !isReplayClaudeAgentSdkMessage(params.message) ? { turnId: params.turnId } : {}),
            toolCallId: block.id,
            toolName: block.name,
            toolInput: block.input,
        }));
    }
    const taskProjection = params.taskNotificationProjector.project(params.message, sidechainId ? { sidechainId } : undefined);
    events.push(...mapSdkToolResultRuntimeEvents({
        message: params.message,
        resultMessage: taskProjection ? taskProjection.message : params.message,
        sessionId: params.sessionId,
        turnId: params.turnId,
        toolNameByCallId: params.toolNameByCallId,
    }));
    return { events, projectedTaskResult: taskProjection !== null };
}

export type ClaudeAgentSdkTurnOperationsParams = Readonly<{
    ctx: ClaudeAgentSdkContext;
    queryContext?: ClaudeSdkQueryContext;
    permissionEngine?: ClaudePermissionEngine;
    directory: string;
    launchEnv: Readonly<Record<string, string>>;
    helperModelEnv?: ClaudeHelperModelEnv;
    advancedOptions?: ClaudeRemoteAdvancedOptions;
    settingSources?: readonly ClaudeSettingSourceV2[];
    permissionMode: string;
    allowedTools?: readonly string[];
    unlistedTools?: 'ask' | 'deny';
    workspaceWrites?: 'allow' | 'deny';
    nativeSandbox?: 'on' | 'off';
    happierSessionId?: string | null;
    executionRunId?: string;
    abortSignal?: AbortSignal;
    initialModelId?: string | null;
    supportsEffort?: boolean;
    supportsSystemPromptSnapshotOff?: boolean;
    startupInstructions?: string;
    initialEffort?: string | null;
    initialUltracode?: boolean;
    providerModel?: AgentSessionProviderBinding['model'];
    initialProviderSessionId?: string | null;
    mcpServers?: Readonly<Record<string, unknown>> | null;
    mcpToolPolicy?: Readonly<Record<string, AgentSessionMcpToolPolicy>>;
    skills?: AgentSessionSkillDelivery;
    publishSdkMessages?: boolean;
    publishTranscriptMessages?: boolean;
    /**
     * Opt-in goal + Dynamic Workflow work-state ingress (session/UI path only). When `true` the
     * runner feeds every `SDKMessage` to the workflow activity runtime (durable
     * `activity/workflow_run.v1` records + headline) and the goal source (the system-init
     * `slash_commands` `/goal` capability), and tails the persisted transcript JSONL for the
     * file-only `goal_status` attachments. Execution runs leave it off (no session work-state).
     */
    enableSessionWorkState?: boolean;
    /**
     * Session-bound runtimes install authenticated Claude lifecycle hooks and only promote the
     * native transcript after the submitted prompt is proven as provider-accepted and materialized.
     * Execution runtimes intentionally leave this off because they do not own resumable sessions.
     */
    enableSessionResumability?: boolean;
    /** Native AgentRuntime work-state projection; omitting it preserves the legacy metadata owner. */
    publishGoalWorkState?: (snapshot: SessionWorkStateV1) => void | Promise<void>;
}>;

export type ClaudeAgentSdkNativeOperations = ClaudeRuntimeTurnOperations & Readonly<{
    setGoal?: ReturnType<typeof createClaudeUnifiedGoalRuntime>['setGoal'];
    clearGoal?: ReturnType<typeof createClaudeUnifiedGoalRuntime>['clearGoal'];
    compact: NonNullable<AgentSessionRuntime['compact']>;
    isTurnInFlight(): boolean;
    refreshSkills: NonNullable<AgentSessionRuntime['refreshSkills']>;
    observeSourceTranscript: NonNullable<AgentSessionRuntime['observeSourceTranscript']>;
    subscribeCanonicalAgentSessionEvents: ReturnType<typeof createClaudeRuntimeActivityPublisher>['subscribe'];
    subscribeEffectiveModel: ClaudeEffectiveModelEvidenceSubscription;
    subscribeUsageObservation: ClaudeUsageObservationSubscription;
    setOnPromptDeliveryOutcome(handler: ClaudeProviderPromptDeliveryOutcomeCallback | null): void;
    /** Once the runtime is watched: adopt a held Agent when the host handed one over (no-op otherwise). */
    startHeldAgentAdoption(): void;
}>;

function isClaudeAgentSdkSessionContext(
    context: ClaudeAgentSdkContext,
): context is ClaudeAgentSdkSessionContext {
    return context.sessions !== undefined;
}

export function createClaudeAgentSdkTurnOperations(
    params: ClaudeAgentSdkTurnOperationsParams,
): ClaudeAgentSdkNativeOperations {
    const runtimeAuthIdentity = createClaudeRuntimeAuthIdentity({launchEnv: params.launchEnv, nativeHome: params.ctx.agentRuntime.nativeHome, logger: params.ctx.logger});
    const mcpServerKeys = new Set(Object.keys(params.mcpServers ?? {}));
    let currentSkills = params.skills;
    const skillOverrides = Object.fromEntries((params.skills?.nativeDisables ?? []).map(item => [item.name, 'off' as const]));
    const sessionContext = isClaudeAgentSdkSessionContext(params.ctx) ? params.ctx : null;
    if (params.unlistedTools === 'deny' && !params.happierSessionId && !params.ctx.agentRuntime.hooks
        && (params.allowedTools ?? []).some(rule => !rule.startsWith('mcp__') && rule.includes('('))) {
        throw new PluginError({ code: 'claude_scoped_tool_policy_requires_session_hooks', retryable: false,
            message: 'Scoped Claude tools require the Session-owned permission hook.' });
    }
    const permissionEngine = params.permissionEngine
        ?? (sessionContext
            ? createClaudePermissionEngine(sessionContext)
            : (() => { throw new Error('Claude detached execution requires an explicit permission engine.'); })());
    const listeners = new Set<(event: ClaudeProviderEvent) => void>();
    const effectiveModelListeners = new Set<(evidence: ClaudeEffectiveModelEvidence) => void>();
    const usageObservationListeners = new Set<(observation: ClaudeUsageObservation) => void>();
    let providerSessionId: string | null = null;
    let resumableProviderSessionId: string | null = null;
    let pendingResumeProviderSessionId: string | null = readClaudeProviderIdentityValue(params.initialProviderSessionId);
    let activeQuery: ClaudeSdkQuery | null = null;
    // Held-Agent adoption (`adoptHeldAgent`) or the start at open (`startAgentBeforeFirstPrompt`): `adopting` while `agentStartAtOpen` is
    // pending, then `adopted` (its turn runs as the active query, or the idle Agent is
    // retained for the next prompt) or `none`. Prompts and control requests wait for it.
    let agentStartAtOpen: Promise<void> | null = null;
    // The adopted Agent's query until a turn or a prompt claims it.
    let adoptedQuery: ClaudeSdkQuery | null = null;
    let disposeQuery: ClaudeSdkQuery | null = null;
    // `startedAtOpen`: launched ahead of the Session's first prompt and not yet prompted.
    let retainedIdleQuery: Readonly<{ query: ClaudeSdkQuery; unpublishedLaunchEffort: string | null; startedAtOpen?: true }> | null = null;
    let activeProviderTask: Readonly<{ taskId: string; ownerScope?: object }> | null = null;
    const cancelledQueries = new WeakMap<ClaudeSdkQuery, string>();
    let activeCompletion: DeferredCompletion | null = null;
    let lastTurnCompletionFailure: Error | null = null;
    const backgroundQueries = new Set<ClaudeSdkQuery>();
    let turnInFlight = false;
    let pendingSubmission: { cancelled: boolean } | null = null;
    let turnSequence = 0;
    let currentTurnId: string | null = null;
    let currentPermissionMode = params.permissionMode;
    let permissionModeUpdate = Promise.resolve();
    let currentWorkspaceWrites = params.workspaceWrites ?? 'allow';
    let currentModelId: string | null = readString(params.initialModelId);
    let currentProviderModel = params.providerModel;
    let currentFallbackModel: string | null = null;
    const supportsEffort = params.supportsEffort !== false;
    let currentEffort: string | null = supportsEffort ? readString(params.initialEffort) : null;
    let currentUltracode = supportsEffort && params.initialUltracode === true;
    let currentOutputSchema: Parameters<AgentSessionRuntime['send']>[0]['input']['outputSchema'];

    /** Keeps a settled query's live process for the next prompt; only the newest live query qualifies. */
    function retainIdleQueryForNextTurn(query: ClaudeSdkQuery, unpublishedLaunchEffort: string | null): boolean {
        if (runtimeDisposed || disposeQuery !== query || query.readExitResult() !== null) return false;
        // A cancellation belonged to the settled turn; the next turn on this process starts clean.
        cancelledQueries.delete(query);
        retainedIdleQuery = { query, unpublishedLaunchEffort };
        return true;
    }

    /** The retained idle query while its process lives; an exited one is retired here. */
    function readLiveRetainedQuery(): ClaudeSdkQuery | null {
        const retained = retainedIdleQuery;
        if (!retained || retained.query.readExitResult() === null) return retained?.query ?? null;
        retainedIdleQuery = null;
        if (adoptedQuery === retained.query) adoptedQuery = null;
        void retained.query.dispose().catch(() => undefined);
        return null;
    }

    async function invalidateRetainedQueryReuse(): Promise<void> {
        if (adoptedQuery && adoptedQuery === retainedIdleQuery?.query) adoptedQuery = null;
        // disposeQuery is also the existing eligibility witness for a trailing cancellation
        // result. Clear it so an old query cannot become reusable after this setting change.
        disposeQuery = null;
        const retained = retainedIdleQuery;
        retainedIdleQuery = null;
        await retained?.query.dispose();
    }

    /** Retires the Claude started at open while it is still unprompted (a turn never reused it). */
    async function retireAgentStartedAtOpen(): Promise<void> {
        if (retainedIdleQuery?.startedAtOpen) await invalidateRetainedQueryReuse();
    }

    let contextUsageRefreshPromise: Promise<boolean> | null = null;
    const noTools = params.unlistedTools === 'deny' && params.allowedTools?.length === 0;
    const noToolsLaunchOptions = noTools
        ? { tools: [], allowedTools: [], unlistedTools: 'deny' as const, strictMcpConfig: true }
        : null;
    const mcpServers = noTools ? undefined : params.mcpServers;
    // Claude Code's non-interactive SDK omits interaction tools such as AskUserQuestion unless
    // the process has a native permission host. Ordinary Sessions therefore use the SDK callback;
    // confined launches retain the hook bridge because its PreToolUse owner enforces scoped rules.
    const permissionHooksEnabled = params.unlistedTools === 'deny';
    const sessionWorkStateEnabled = params.enableSessionWorkState === true;
    const happierSessionId = readString(params.happierSessionId);
    let promotedTranscriptPath: string | null = null;
    type SessionHookBinding = Readonly<{ pluginDir: string; dispose(): Promise<void> }>;
    type LocalTerminalHookBinding = Readonly<{
        plan: Extract<Awaited<ReturnType<NonNullable<AgentSessionRuntime['prepareTerminalPresentation']>>>, { kind: 'terminal_launch' }>['plan'];
        hooks: SessionHookBinding;
    }>;
    let sessionHookBinding: SessionHookBinding | null = null;
    let sessionHookSetupPromise: Promise<SessionHookBinding | null> | null = null;
    let preparedLocalHookBinding: LocalTerminalHookBinding | null = null;

    let runtimeDisposed = false;
    let runtimeDisposePromise: Promise<void> | null = null;
    const pendingNativeStarts: Array<Readonly<{
        providerSessionId: string; payload: Readonly<Record<string, unknown>>; observedAt: number;
    }>> = [];
    let orderedSourceBinding: {
        providerSessionId: string;
        replay: 'historical' | 'fresh';
        handle: Readonly<{ dispose(): Promise<void> }> | null;
        acquisition: Promise<void> | null;
    } | null = null;
    const providerActivityLedger = createClaudeProviderActivityLedger();
    const taskNotificationProjector = createClaudeTaskNotificationToolResultProjector();
    const runtimeActivityPublisher = createClaudeRuntimeActivityPublisher({
        sessionId: happierSessionId ?? 'claude-agent-sdk',
    });
    // Centralized Dynamic Workflow ACTIVITY runtime (mirrors the unified runner). Turns the
    // `Workflow`/`Task`/`task_*`/`workflow_progress` events on the live SDK stream into durable
    // `activity/workflow_run.v1` records (record-FIRST via the private host-owned System Records port)
    // plus the compact typed workflow headline.
    const workflowFileFollow = sessionContext?.agentRuntime.transcripts.fileFollow;
    if (sessionWorkStateEnabled && (!sessionContext || !workflowFileFollow)) {
        throw new Error('Claude Session work-state requires Session-owned services.');
    }
    const workflowRuntime = sessionWorkStateEnabled
        ? createClaudeUnifiedWorkflowRuntime({
            backendId: 'claude',
            agentId: 'claude',
            getCurrentClaudeSessionId: () => providerSessionId,
            writeSystemRecord: async (request) =>
                await sessionContext!.sessions.current.writeSystemRecord(request),
            readSystemRecord: async (request) =>
                await sessionContext!.sessions.current.readSystemRecord(request),
            publishHeadlines: async (bundle) => {
                await sessionContext!.sessions.current.workflowActivity.publishHeadlines(bundle);
            },
            fileFollow: workflowFileFollow!,
            onProviderTaskActivity: (activity) => {
                const didChange = applyProviderTaskActivity(activity);
                if (didChange && activity.type === 'terminal' && activeProviderTask?.taskId === activity.taskId) {
                    reconcileActiveProviderTask();
                }
            },
            logError: (message, error) => { params.ctx.logger.debug(`[ClaudeAgentSdk] ${message}`, { error }); },
            // On `warn`, not `debug`: a session process runs at `info`, so a debug line here could
            // never be seen in the situation it exists to report.
            reportShapeDrift: (message) => { params.ctx.logger.warn(`[ClaudeAgentSdk] ${message}`); },
        })
        : null;
    // Centralized native `/goal` runtime. The SOURCE observes the live SDK stream (system-init
    // `slash_commands` => `/goal` capability) AND the file-only `goal_status` attachments via the
    // narrow JSONL tail below; the effector injects a literal `/goal …` user turn.
    const goalControlObservations = new Set<(snapshot: SessionWorkStateV1, publication: Promise<void>, afterGoalCommandAdmission: boolean) => void>();
    const goalRuntime = sessionWorkStateEnabled
        ? createClaudeUnifiedGoalRuntime({
            backendId: 'claude',
            agentId: 'claude',
            getCurrentClaudeSessionId: () => providerSessionId,
            ...(params.publishGoalWorkState
                ? { publishWorkStateSnapshot: (snapshot: SessionWorkStateV1, afterGoalCommandAdmission = false) => {
                    const publication = Promise.resolve().then(() => params.publishGoalWorkState!(snapshot));
                    for (const observe of goalControlObservations) observe(snapshot, publication, afterGoalCommandAdmission);
                    return publication;
                } }
                : {}),
            injectGoalCommand: async (message) => {
                const outcome = await operations.sendProviderTurnPrompt(message, undefined, false);
                if (outcome.kind !== 'accepted') {
                    throw new Error('Claude SDK did not accept the native Goal command');
                }
            },
            logError: (message, error) => { params.ctx.logger.debug(`[ClaudeAgentSdk] ${message}`, { error }); },
        })
        : null;
    let goalStatusTail: ClaudeAgentSdkGoalStatusTail | null = null;
    let goalStatusTranscriptPath: string | null = null;
    const retiringGoalStatusTails = new Set<Promise<void>>();
    let lastEffectiveModelEvidenceKey: string | null = null;

    async function settleGoalControl(
        effect: () => Promise<unknown>,
        matches: (snapshot: SessionWorkStateV1) => boolean,
        waitForNativeCompletion = false,
    ): Promise<unknown> {
        // Let the transport's existing busy refusal decide without retiring the
        // in-flight command's observation boundary.
        if (turnInFlight) return await effect();
        goalRuntime?.source.beginGoalCommandObservation(null);
        let observed = false;
        let confirm!: () => void;
        let refuse!: (error: unknown) => void;
        class SettlementError extends Error {
            constructor(readonly phase: SessionGoalControlFailureV1['phase'], cause: unknown) {
                super('session_goal_control_work_state_unavailable', { cause });
            }
        }
        const inPhase = async <T>(phase: SessionGoalControlFailureV1['phase'], run: () => Promise<T>): Promise<T> => {
            try { return await run(); } catch (cause) { throw new SettlementError(phase, cause); }
        };
        const acknowledgement = new Promise<void>((resolve, reject) => { confirm = resolve; refuse = reject; });
        // Native file evidence may arrive while the transport is still admitting
        // the command; retain its exact host publication receipt for this caller.
        acknowledgement.catch(() => undefined);
        const observe = (snapshot: SessionWorkStateV1, publication: Promise<void>, afterGoalCommandAdmission: boolean) => {
            if (observed || (!waitForNativeCompletion && !afterGoalCommandAdmission) || !matches(snapshot)) return;
            observed = true;
            void publication.then(confirm, cause => refuse(new SettlementError('host_publication_rejected', cause)));
        };
        goalControlObservations.add(observe);
        // Confirm the native Goal publication, even while Claude continues its
        // resulting work. Native completion is only a failure/drain boundary.
        try {
            const result = await inPhase('native_effect', effect);
            if (isRecord(result) && result.ok === false) return { ...result,
                goalControlFailure: { phase: 'native_effect' } satisfies SessionGoalControlFailureV1 };
            const completion = inPhase('provider_completion', () => operations.waitForProviderTurnCompletion()).then(async () => {
                if (!observed) await inPhase('tail_drain', async () => { await goalStatusTail?.drainNow(); });
                if (!observed) throw new SettlementError('missing_matching_publication', new Error('Native Goal state was not published'));
                await acknowledgement;
            });
            await (waitForNativeCompletion ? completion : Promise.race([acknowledgement, completion]));
            return result;
        } catch (cause) {
            return { ok: false, errorCode: 'session_goal_control_work_state_unavailable', error: 'session_goal_control_work_state_unavailable',
                goalControlFailure: { phase: cause instanceof SettlementError ? cause.phase : 'native_effect' } satisfies SessionGoalControlFailureV1 };
        } finally {
            goalControlObservations.delete(observe);
            goalRuntime?.source.beginGoalCommandObservation(null);
        }
    }

    function publishEffectiveModel(evidence: ClaudeEffectiveModelEvidence): void {
        const modelId = readString(evidence.modelId);
        if (!modelId) return;
        const contextWindowTokens = readNonnegativeInteger(evidence.contextWindowTokens);
        const reasoningEffort = readString(evidence.reasoningEffort);
        const key = `${modelId}|${contextWindowTokens ?? ''}|${reasoningEffort ?? ''}`;
        if (key === lastEffectiveModelEvidenceKey) return;
        lastEffectiveModelEvidenceKey = key;
        const published = Object.freeze({
            modelId,
            ...(contextWindowTokens && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
        });
        for (const listener of effectiveModelListeners) listener(published);
    }

    function retireGoalStatusTail(tail: ClaudeAgentSdkGoalStatusTail): Promise<void> {
        const retirement = tail.dispose().catch(() => undefined).finally(() => {
            retiringGoalStatusTails.delete(retirement);
        });
        retiringGoalStatusTails.add(retirement);
        return retirement;
    }

    // Narrow side-follow of the persisted transcript JSONL for the file-only `goal_status`
    // attachments (not present on the live SDK stream). Native Goal reads consume
    // the identity owner's authenticated current SessionStart candidate. Resume
    // publication still requires its separate accepted-prompt proof: /goal is
    // persisted as command markup and cannot supply an exact person-prompt match.
    function ensureGoalStatusTail(candidatePath?: string): void {
        if (!goalRuntime) return;
        const transcriptPath = candidatePath ?? promotedTranscriptPath ?? (
            params.enableSessionResumability !== true && providerSessionId
                ? join(
                    getClaudeProjectPath(
                        params.directory,
                        undefined,
                        params.launchEnv,
                    ),
                    `${providerSessionId}.jsonl`,
                )
                : null
        );
        if (!transcriptPath) return;
        if (goalStatusTail && goalStatusTranscriptPath === transcriptPath) return;
        if (goalStatusTail) void retireGoalStatusTail(goalStatusTail);
        goalStatusTranscriptPath = transcriptPath;
        const goalSource = goalRuntime.source;
        goalSource.resetGoalCommandObservation();
        goalStatusTail = createClaudeAgentSdkGoalStatusTail({
            ctx: sessionContext!,
            transcriptPath,
            observeGoalStatusRow: (row) => goalSource.observeTranscriptMessage(row),
            resetGoalCommandObservation: () => goalSource.resetGoalCommandObservation(),
        });
    }

    const resumeIdentityOwner = (params.enableSessionResumability === true || sessionWorkStateEnabled) && happierSessionId
        ? createClaudeAgentSdkResumeIdentityOwner({
            ctx: sessionContext!,
            expectedInitialProviderSessionId: params.initialProviderSessionId,
            onProviderSessionId: observeProviderSessionId,
            onTranscriptCandidateActivated: ({ transcriptPath }) => {
                if (promotedTranscriptPath !== null && promotedTranscriptPath !== transcriptPath) {
                    resumableProviderSessionId = null;
                    pendingResumeProviderSessionId = null;
                    clearPromotedTranscriptForRekey();
                    // Retract only the old resume proof; the new authenticated
                    // candidate can already supply its own native Goal evidence.
                    if (providerSessionId) publishProviderSessionId(providerSessionId, true);
                }
                ensureGoalStatusTail(transcriptPath);
            },
            onTranscriptPromoted: async ({ providerSessionId: provenProviderSessionId, transcriptPath, isCurrent }) => {
                if (!isCurrent() || providerSessionId !== provenProviderSessionId) return;
                if (params.enableSessionResumability === true && promotedTranscriptPath !== transcriptPath) {
                    ensureGoalStatusTail(transcriptPath);
                }
                if (!isCurrent() || providerSessionId !== provenProviderSessionId) return;
                if (params.enableSessionResumability === true) {
                    resumableProviderSessionId = provenProviderSessionId;
                    pendingResumeProviderSessionId = null;
                    promotedTranscriptPath = transcriptPath;
                    // The accepted native prompt proves this matched identity. Publish
                    // it before follow admission, whose hosted reader consumes it.
                    publishProviderSessionId(provenProviderSessionId);
                }
                // A fresh SessionStart precedes creation of Claude's JSONL file.
                // This accepted-prompt proof supplies the materialized transcript.
                await bindOrderedSourceHistory(provenProviderSessionId, {}, true);
                if (!isCurrent() || providerSessionId !== provenProviderSessionId) return;
                if (params.enableSessionResumability !== true) return;
                ensureGoalStatusTail();
            },
        })
        : null;

    function observeNativeWorkflowHook(
        nativeSessionId: string,
        payload: Readonly<Record<string, unknown>>,
        observedAt: number,
        startupReplay?: true,
    ): void {
        workflowRuntime?.observeTranscriptMessage({ ...payload, session_id: nativeSessionId }, {
            authenticatedHook: true, observedAt, ...(startupReplay ? { startupReplay } : {}),
        });
    }

    async function bindOrderedSourceHistory(
        nativeSessionId: string,
        payload: Readonly<Record<string, unknown>>,
        transcriptMaterialized = false,
    ): Promise<void> {
        if (!workflowRuntime || runtimeDisposed) return;
        let binding = orderedSourceBinding;
        if (binding?.providerSessionId !== nativeSessionId) {
            if (binding) {
                await binding.acquisition;
                await binding.handle?.dispose();
                providerActivityLedger.noteSourceBaselineComplete(binding);
            }
            if (runtimeDisposed) return;
            binding = { providerSessionId: nativeSessionId,
                replay: payload.source === 'resume' || params.initialProviderSessionId === nativeSessionId ? 'historical' : 'fresh',
                handle: null, acquisition: null };
            orderedSourceBinding = binding;
            // An unacquired baseline is a scoped unknown observation, not a lost
            // native stream. Successful acquisition retires only this pending scope;
            // genuine observation-loss flags and outstanding tasks remain intact.
            providerActivityLedger.noteSourceBaselinePending(binding);
            reconcileProviderTaskRuntimeActivityForCurrentQuery('source-baseline-pending');
        }
        if (binding.handle || binding.acquisition) {
            await binding.acquisition;
            return;
        }
        if (binding.replay === 'fresh' && !transcriptMaterialized && payload.source !== 'resume') return;
        const currentBinding = binding;
        const acquisition = Promise.resolve().then(async () => {
            const followSource = sessionContext?.agentRuntime.transcripts.followSource;
            if (!followSource) throw new Error('Claude SDK work-state requires ordered source transcript following');
            const handle = await followSource({ providerSessionId: nativeSessionId,
                replay: currentBinding.replay });
            if (runtimeDisposed || orderedSourceBinding !== currentBinding) { await handle.dispose(); return; }
            currentBinding.handle = handle;
            const noteSourceLost = (): void => {
                if (runtimeDisposed || orderedSourceBinding !== currentBinding || currentBinding.handle !== handle) return;
                providerActivityLedger.noteObservationLost();
                reconcileProviderTaskRuntimeActivityForCurrentQuery('source-follow-lost');
            };
            void handle.failure?.then(noteSourceLost, noteSourceLost);
            for (const receipt of pendingNativeStarts.splice(0)) {
                if (receipt.providerSessionId !== nativeSessionId) continue;
                observeNativeWorkflowHook(nativeSessionId, receipt.payload, receipt.observedAt, true);
            }
            providerActivityLedger.noteSourceBaselineComplete(currentBinding);
            reconcileProviderTaskRuntimeActivityForCurrentQuery('source-baseline-acquired');
        }).catch((error) => {
            params.ctx.logger.warn('[ClaudeAgentSdk] ordered source transcript baseline failed', { error });
            reconcileProviderTaskRuntimeActivityForCurrentQuery('source-baseline-failed');
            // History observation does not decide the live SDK turn's outcome.
            // Keep its baseline pending; an authenticated SessionStart can retry
            // without turning accepted prompt proof into a JSONL read failure.
        });
        currentBinding.acquisition = acquisition;
        try { await acquisition; }
        finally { currentBinding.acquisition = null; }
    }

    async function observeSessionHook(providerSessionId: string, payload: Readonly<Record<string, unknown>>, ownerScope?: object): Promise<void> {
        if (runtimeDisposed) return;
        const observedAt = Date.now();
        const lifecycle = readClaudeTaskLifecycleEnvelope(payload);
        const bufferedNativeStart = lifecycle?.knownOnly === true && lifecycle.resumed === true
            && (orderedSourceBinding?.providerSessionId !== providerSessionId || !orderedSourceBinding.handle);
        if (bufferedNativeStart) {
            pendingNativeStarts.push({ providerSessionId, payload, observedAt });
        } else if (lifecycle) {
            observeNativeWorkflowHook(providerSessionId, payload, observedAt);
        }
        if (!bufferedNativeStart || ownerScope) observeProviderTaskActivity(payload, providerSessionId, ownerScope);
        await resumeIdentityOwner?.observeSessionHook(providerSessionId, payload, ownerScope ? 'local_terminal' : 'sdk');
        if (readString(payload.hook_event_name ?? payload.hookEventName ?? payload.eventName) === 'SessionStart') {
            // The native process must be able to continue while its ordered source
            // baseline is acquired. The binding owns acquisition and its disposal.
            void bindOrderedSourceHistory(providerSessionId, payload).catch(error => {
                params.ctx.logger.warn('[ClaudeAgentSdk] ordered source transcript baseline failed', { error });
            });
        }
        const explicitResumeFailure = resumeIdentityOwner?.readExplicitResumeFailure();
        if (explicitResumeFailure) {
            lastTurnCompletionFailure = explicitResumeFailure;
            activeCompletion?.reject(explicitResumeFailure);
        }
    }

    async function createSessionHookBinding(readOwnerScope?: () => object | null): Promise<SessionHookBinding | null> {
        const hookInstanceId = happierSessionId ?? (params.unlistedTools === 'deny' ? params.executionRunId : null);
        if (!hookInstanceId) return null;
        const sessionHooks = sessionContext?.agentRuntime.sessionHooks;
        const detachedHooks = params.ctx.agentRuntime.hooks;
        const hooks = sessionHooks ?? detachedHooks;
        if (!hooks) {
            if (!happierSessionId) return null;
            throw new Error('Claude Session hooks are unavailable for a Session-bound runtime.');
        }
        return await (async () => {
            const permissionHookTimeoutSeconds = resolveClaudePermissionHookTimeoutSeconds({ env: params.launchEnv });
            const handlePermissionHook = permissionHooksEnabled ? createClaudePermissionHookHandler({
                agentRuntime: params.ctx.agentRuntime,
                permissionEngine: { canCallTool: resolvePermissionAfterInterception },
            }) : null;
            const hookRequest: AgentSessionHookServerStartRequest = {
                ...(readOwnerScope ? { lifetime: 'invocation' as const } : {}),
                onSessionHook: async (providerSessionId, payload) => {
                    const ownerScope = readOwnerScope?.();
                    if (readOwnerScope && !ownerScope) return;
                    await observeSessionHook(providerSessionId, payload, ownerScope ?? undefined);
                },
                ...(handlePermissionHook ? {
                    onPermissionHook: handlePermissionHook,
                    defaultPermissionHookResponse: data => buildDefaultPermissionHookResponse(data, params.unlistedTools),
                    permissionRequestTimeoutMs: resolveClaudePermissionHookCeilingMs({ explicitSeconds: permissionHookTimeoutSeconds }),
                } : {}),
            };
            const server = sessionHooks && happierSessionId
                ? await sessionHooks.startServer({ ...hookRequest, providerId: 'claude', sessionId: happierSessionId,
                    lifecycle: { kind: 'session', sessionId: happierSessionId } })
                : await detachedHooks!.startServer(hookRequest);
            try {
                const assets = await hooks.resolveForwarderAssets();
                const hooksJson = buildClaudeHookPluginHooks({
                    permissionHookTimeoutSeconds,
                    transport: readOwnerScope ? 'terminal' : 'sdk',
                    port: server.port,
                    nodeExecutable: assets.nodeExecutable,
                    sessionForwarderScript: assets.sessionForwarderScript,
                    ...(permissionHooksEnabled ? {
                        permissionForwarderScript: assets.permissionForwarderScript,
                        enableLocalPermissionBridge: true,
                        unlistedTools: params.unlistedTools,
                    } : {}),
                    ...(server.sessionHookSecretFile
                        ? { sessionHookSecretFile: server.sessionHookSecretFile }
                        : {}),
                    ...(permissionHooksEnabled && server.permissionHookSecretFile
                        ? { permissionHookSecretFile: server.permissionHookSecretFile }
                        : {}),
                });
                const manifest = buildClaudeHookPluginManifest({ instanceId: hookInstanceId });
                const pluginRequest = {
                    ...(readOwnerScope ? { lifetime: 'invocation' as const } : {}),
                    files: [
                        { path: '.claude-plugin/plugin.json', json: manifest },
                        { path: 'hooks/hooks.json', json: hooksJson },
                    ],
                };
                const pluginDir = sessionHooks && happierSessionId
                    ? await sessionHooks.createPluginDir({ ...pluginRequest, providerId: 'claude',
                        lifecycle: { kind: 'session', sessionId: happierSessionId } })
                    : await detachedHooks!.createPluginDir(pluginRequest);
                return { pluginDir, async dispose() {
                    const results = await Promise.allSettled([hooks.disposePluginDir(pluginDir), server.dispose()]);
                    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
                    if (failures.length === 0) return;
                    params.ctx.logger.warn('[ClaudeAgentSdk] Session hook resource cleanup failed', {
                        error: 'claude_session_hook_cleanup_failed',
                    });
                    if (failures.length === 1) throw failures[0];
                    throw new AggregateError(failures, 'Claude Session hook resource cleanup failed', { cause: failures[0] });
                } };
            } catch (error) {
                try {
                    await server.dispose();
                } catch (cleanupError) {
                    params.ctx.logger.warn('[ClaudeAgentSdk] Session hook resource cleanup failed', {
                        error: 'claude_session_hook_cleanup_failed',
                    });
                    throw Object.assign(new AggregateError([error, cleanupError], 'Claude Session hook preparation and cleanup failed', { cause: error }), {
          failureCause: projectSessionRuntimeFailureCause(error, 'client_start', 'agent.launch'),
        });
                }
                throw error;
            }
        })();
    }

    async function ensureSessionHookPluginDir(): Promise<string | null> {
        // SessionStart precedes SDK initialization. The existing authenticated startup hook
        // admits the transcript for resume identity and Goal following; later hooks use stdio.
        if (!permissionHooksEnabled && !resumeIdentityOwner) return null;
        if (sessionHookBinding) return sessionHookBinding.pluginDir;
        sessionHookSetupPromise ??= createSessionHookBinding().then(binding => {
            sessionHookBinding = binding;
            return binding;
        }).finally(() => { sessionHookSetupPromise = null; });
        return (await sessionHookSetupPromise)?.pluginDir ?? null;
    }

    function observeSessionWorkStateMessage(message: SDKMessage): void {
        if (!sessionWorkStateEnabled) return;
        // ONE live channel, two provider-clean sources: workflow activity + goal capability.
        workflowRuntime?.observeTranscriptMessage(message, {
            historicalReplay: isReplayClaudeAgentSdkMessage(message),
        });
        goalRuntime?.source.observeTranscriptMessage(message);
    }

    function publishRuntimeEvent(event: ClaudeProviderEvent | null): void {
        if (!event) return;
        for (const listener of Array.from(listeners)) {
            listener(event);
        }
    }

    function publishUsageObservation(observation: ClaudeUsageObservation | null): void {
        if (!observation) return;
        for (const listener of usageObservationListeners) listener(observation);
    }

    function publishContextUsage(snapshot: SessionContextUsageSnapshotV1): void {
        publishRuntimeEvent(ClaudeProviderEventSchema.parse({
            sessionId: readRuntimeEventSessionId(),
            emittedAtMs: snapshot.observedAtMs,
            kind: 'transcript-agent-message-committed',
            agentId: 'claude',
            localId: `claude-context-usage-${snapshot.observedAtMs}`,
            body: {
                type: 'token_count',
                source: 'claude-sdk-context-usage',
                modelId: snapshot.modelId,
                context_used_tokens: snapshot.usedTokens,
                context_window_tokens: snapshot.windowTokens,
                contextSnapshot: snapshot,
            },
            meta: {
                source: 'claude-agent-sdk-context-usage',
            },
        }));
    }

    async function requestAndPublishContextUsage(turnQuery: ClaudeSdkQuery): Promise<boolean> {
        if (contextUsageRefreshPromise) return await contextUsageRefreshPromise;
        contextUsageRefreshPromise = (async () => {
            const response = await turnQuery.getContextUsage();
            const snapshot = buildClaudeLiveContextUsageSnapshot({
                response,
                observedAtMs: Date.now(),
            });
            if (!snapshot) return false;
            publishContextUsage(snapshot);
            return true;
        })().finally(() => {
            contextUsageRefreshPromise = null;
        });
        return await contextUsageRefreshPromise;
    }

    function buildQueryLaunchOptions(hookPluginDir: string | null) {
        return buildClaudeSdkQueryLaunchOptions(params, {
            skills: currentSkills, permissionMode: currentPermissionMode, workspaceWrites: currentWorkspaceWrites,
            modelId: currentModelId, providerModel: currentProviderModel, fallbackModel: currentFallbackModel,
            effort: currentEffort, ultracode: currentUltracode, hookPluginDir, mcpServers, skillOverrides,
            resolvePermission, getOAuthToken: getClaudeSdkOAuthToken,
        });
    }

    async function withControlQuery<T>(operation: (query: ClaudeSdkQuery) => Promise<T>): Promise<T | null> {
        // A second Agent launch would replace the held one the host keeps for the next runner.
        if (agentStartAtOpen) await agentStartAtOpen;
        const retainedQuery = readLiveRetainedQuery();
        const reusableQuery = activeQuery ?? compactionControl.readQuery() ?? adoptedQuery ?? retainedQuery;
        if (reusableQuery) return await operation(reusableQuery);
        const contextUsageProviderSessionId = params.enableSessionResumability === true
            ? resumableProviderSessionId ?? pendingResumeProviderSessionId
            : providerSessionId;
        if (!contextUsageProviderSessionId) return null;

        const hookPluginDir = await ensureSessionHookPluginDir();
        const idleController = new AbortController();
        const transientQuery = createOwnedQuery({
            prompt: createIdlePromptStream(idleController.signal),
            options: { ...buildQueryLaunchOptions(hookPluginDir).options, resume: contextUsageProviderSessionId },
        });
        try {
            return await operation(transientQuery);
        } finally {
            idleController.abort();
            await transientQuery.dispose().catch(() => undefined);
        }
    }

    async function requestContextUsageOnDemand(): Promise<boolean> {
        return await withControlQuery(requestAndPublishContextUsage) ?? false;
    }

    const sdkRequestClocks = new WeakMap<SDKMessage, number>();
    function createOwnedQuery(config: Parameters<typeof queryWithContext>[1], readTurnId?: () => string | null): ClaudeSdkQuery {
        if (runtimeDisposed) throw new Error('Claude Agent SDK runtime is disposed.');
        let inference: { id: string; sessionId: string | null; startedAtMs: number } | null = null;
        const turnQuery = queryWithContext(params.queryContext ?? params.ctx.agentRuntime.exec, {
            ...config,
            // Apply the Run ceiling after advanced/native options, including idle control queries.
            options: {
                ...config.options,
                ...noToolsLaunchOptions,
                beforePromptGeneration: async ({ signal }) => {
                    const turnId = readTurnId?.();
                    if (turnId) await sessionContext?.agentRuntime.awaitTurnPublication?.(turnId, signal);
                },
                onSessionHook: async payload => {
                    const nativeSessionId = readClaudeProviderIdentityValue(payload.session_id);
                    if (!nativeSessionId) return;
                    const hooks = sessionContext?.agentRuntime.sessionHooks ?? params.ctx.agentRuntime.hooks;
                    await hooks?.observeSessionHook({ providerSessionId: nativeSessionId, payload });
                    await observeSessionHook(nativeSessionId, payload);
                },
            },
            onMessageReceived(message) {
                if (isClaudePrimaryNativeActivity(message)) {
                    const nativeSessionId = readString(message.session_id);
                    const sameSession = !nativeSessionId || !providerSessionId || nativeSessionId === providerSessionId;
                    if (!sameSession && isSdkSystemMessage(message)
                        && (message.subtype === 'init' || message.subtype === 'compact_boundary')) inference = null;
                    if (sameSession && message.type === 'stream_event' && isRecord(message.event)
                        && message.event.type === 'message_start') {
                        const start = isRecord(message.event.message) ? message.event.message : null;
                        const id = readString(start?.id);
                        inference = id ? { id, sessionId: nativeSessionId, startedAtMs: Date.now() } : null;
                    }
                    if (sameSession && isSdkAssistantMessage(message) && inference
                        && readString(message.message.id) === inference.id
                        && nativeSessionId === inference.sessionId) {
                        sdkRequestClocks.set(message, inference.startedAtMs);
                    }
                }
                if (!isReplayClaudeAgentSdkMessage(message)) {
                    for (const block of extractToolUseBlocksFromSdkMessage(message)) {
                        providerActivityLedger.observeToolUse(turnQuery, block.id, readClaudeProviderTaskToolTarget(
                            block.name, block.input, readString(message.session_id) ?? providerSessionId,
                        ));
                    }
                }
                config.onMessageReceived?.(message);
            },
            onObservationLost(reason) {
                inference = null;
                if (retainedIdleQuery?.query === turnQuery) retainedIdleQuery = null;
                providerActivityLedger.noteObservationLost(turnQuery);
                reconcileProviderTaskRuntimeActivityForCurrentQuery(reason);
                if (reason === 'dispose_failed') {
                    params.ctx.logger.warn('[ClaudeAgentSdk] Owned process cleanup failed', {
                        code: 'CLAUDE_SDK_PROCESS_CLEANUP_FAILED', ...providerActivityLedger.getSnapshot(),
                    });
                }
                config.onObservationLost?.(reason);
            },
            onProcessExited(result) {
                if (retainedIdleQuery?.query === turnQuery) {
                    retainedIdleQuery = null;
                    void turnQuery.dispose().catch(() => undefined);
                }
                if (result.providerStopped === true) {
                    providerActivityLedger.noteProviderStopped(turnQuery);
                    if (activeProviderTask?.ownerScope === turnQuery) reconcileActiveProviderTask();
                } else {
                    providerActivityLedger.noteObservationLost(turnQuery);
                }
                reconcileProviderTaskRuntimeActivityForCurrentQuery('owned-process-exited');
                config.onProcessExited?.(result);
            },
        });
        providerActivityLedger.registerOwner(turnQuery);
        return turnQuery;
    }

    function applyProviderTaskActivity(activity: ClaudeProviderTaskActivity, ownerScope?: object): boolean {
        return applyClaudeProviderTaskActivity({
            activity,
            ...(ownerScope ? { ownerScope } : {}),
            ledger: providerActivityLedger,
            runtimeActivityPublisher,
            logger: params.ctx.logger,
            logPrefix: '[ClaudeAgentSdk]',
        });
    }

    function reconcileActiveProviderTask(): void {
        const identity = providerActivityLedger.getActiveProviderTasks().at(-1);
        const owner = identity ? providerActivityLedger.getProviderTaskOwner(identity) : undefined;
        activeProviderTask = identity ? {
            taskId: identity.taskId,
            ...(owner ? { ownerScope: owner } : {}),
        } : null;
    }

    function observeProviderTaskActivity(message: unknown, contextualSessionId?: string, ownerScope?: object): boolean {
        const event = normalizeClaudeProviderTaskEvent(
            message,
            contextualSessionId ?? providerSessionId ?? undefined,
        );
        if (event.activity && ownerScope === undefined && isRecord(message)
            && readString(message.hook_event_name ?? message.hookEventName ?? message.eventName)) {
            const toolUseId = readString(message.tool_use_id ?? message.toolUseId);
            const toolCall = toolUseId ? providerActivityLedger.resolveToolUse(toolUseId) : null;
            const exactOwner = event.activity.type === 'terminal' && toolCall?.target
                ? toolCall.target.sessionId === event.activity.sessionId && toolCall.target.taskId === event.activity.taskId
                    ? toolCall.targetOwner : undefined
                : toolCall?.ownerScope;
            if (exactOwner instanceof ClaudeSdkQuery) ownerScope = exactOwner;
        }
        let didObserveActivity = false;
        if (event.activity) {
            didObserveActivity = applyProviderTaskActivity(event.activity, ownerScope);
            if (!didObserveActivity && event.activity.type === 'terminal') return false;
        }

        if (event.interruptTarget?.type === 'active') {
            const taskOwner = event.activity ? providerActivityLedger.getProviderTaskOwner(event.activity) : undefined;
            if (taskOwner) ownerScope = taskOwner;
            activeProviderTask = { taskId: event.interruptTarget.taskId, ...(ownerScope ? { ownerScope } : {}) };
        } else if (
            event.interruptTarget?.type === 'terminal'
            && activeProviderTask?.taskId === event.interruptTarget.taskId
            && (activeProviderTask.ownerScope === undefined || activeProviderTask.ownerScope === ownerScope)
        ) {
            reconcileActiveProviderTask();
        }
        return didObserveActivity;
    }

    function reconcileProviderTaskRuntimeActivityForCurrentQuery(reason: string): void {
        publishClaudeProviderTaskInventory({
            ledger: providerActivityLedger,
            runtimeActivityPublisher,
            logger: params.ctx.logger,
            logPrefix: '[ClaudeAgentSdk]',
            reason,
        });
    }

    type ResultTurn = Readonly<{
        completion: DeferredCompletion;
        message: SDKResultMessage;
        messageSequence: number;
        providerFailure: ClaudeProviderFailureEvidence | null;
        publishedTranscriptText: boolean;
        turnQuery: ClaudeSdkQuery;
        turnId: string | null;
        modelId: string | null;
    }>;

    function publishResultUsage(message: SDKResultMessage, observedAtMs: number, modelId: string | null): void {
        const observation = buildClaudeSdkResultUsageObservation({
            modelId,
            ...(currentProviderModel ? { modelSource: 'provider' } : {}),
            observedAtMs,
            result: message,
        });
        publishUsageObservation(observation);
        if (params.publishTranscriptMessages === true && observation?.contextSnapshot) {
            publishContextUsage(observation.contextSnapshot);
        }
    }

    function publishResultEvidence(turn: ResultTurn): void {
        const observedAtMs = Date.now();
        if (params.publishTranscriptMessages === true) {
            publishRuntimeEvent(mapSdkResultUsageTranscriptEvent({
                message: turn.message,
                sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                sequence: turn.messageSequence,
                modelId: turn.modelId,
            }));
        }
        publishResultUsage(turn.message, observedAtMs, turn.modelId);
        if ((params.publishTranscriptMessages === true || params.publishSdkMessages === true)
            && (!turn.publishedTranscriptText || turn.message.structured_output !== undefined)) {
            const resultTranscriptEvent = mapResultTranscriptEvent({
                message: turn.message,
                sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                sequence: turn.messageSequence,
                turnId: activeCompletion === turn.completion && !cancelledQueries.has(turn.turnQuery) ? turn.turnId : null,
            });
            if (resultTranscriptEvent) publishRuntimeEvent(resultTranscriptEvent);
        }
    }

    function completeSuccessfulTurn(
        turn: ResultTurn,
        publishTerminal: (event: ClaudeProviderEvent) => void,
    ): void {
        publishResultEvidence(turn);
        if (activeQuery === turn.turnQuery) activeQuery = null;
        if (activeCompletion === turn.completion) {
            activeCompletion = null;
            turnInFlight = false;
        }
        publishTerminal(mapSdkRuntimeEvent({
            message: turn.message,
            sessionId: readRuntimeEventSessionId(),
            turnId: turn.turnId ?? 'claude-agent-sdk-turn',
            providerFailure: turn.providerFailure,
        })!);
        reconcileProviderTaskRuntimeActivityForCurrentQuery('foreground-result');
        turn.completion.resolve();
    }

    function completeProviderBackgroundObservation(turnQuery: ClaudeSdkQuery): void {
        providerActivityLedger.completeQueryObservation(turnQuery);
        backgroundQueries.delete(turnQuery);
        if (backgroundQueries.size === 0) {
            reconcileProviderTaskRuntimeActivityForCurrentQuery('background-observation-complete');
        }
    }

    /**
     * Publishes the resume id and, when this generation already materialized
     * one, the transcript path holding that id's conversation.
     * `promotedTranscriptPath` is only set by `onTranscriptPromoted`, which
     * fires after a submitted prompt materialized in that exact transcript for
     * that exact id — so the pair published here is matched by construction, and
     * a re-key clears the path before the new id is published.
     */
    function publishProviderSessionId(nextSessionId: string, isExistingResume = false): void {
        const nativeSessionLogPath = providerSessionId === nextSessionId
            ? promotedTranscriptPath
            : null;
        if (!canPublishSessionResumeIdentity({
            isExistingResume: isExistingResume
                || pendingResumeProviderSessionId === nextSessionId
                || params.initialProviderSessionId === nextSessionId,
            // Without native resumability, identity comes from the SDK's
            // running prompt query, not an idle SessionStart hook.
            hasResumeEvidence: Boolean(nativeSessionLogPath) || params.enableSessionResumability !== true,
        })) return;
        publishRuntimeEvent(ClaudeProviderEventSchema.parse({
            sessionId: readString(params.happierSessionId) ?? nextSessionId,
            emittedAtMs: Date.now(),
            kind: 'session-id-publish',
            publishedSessionId: nextSessionId,
            source: 'claude-agent-sdk',
            ...(nativeSessionLogPath ? { nativeSessionLogPath } : {}),
        }));
    }

    function clearPromotedTranscriptForRekey(): void {
        const previousTranscriptPath = promotedTranscriptPath;
        if (!previousTranscriptPath) return;
        promotedTranscriptPath = null;
        const previousGoalStatusTail = goalStatusTail;
        goalStatusTail = null;
        goalStatusTranscriptPath = null;
        if (previousGoalStatusTail) void retireGoalStatusTail(previousGoalStatusTail);
    }

    function observeProviderSessionId(value: unknown): void {
        const nextSessionId = readClaudeProviderIdentityValue(value);
        if (!nextSessionId) return;
        const identityChanged = providerSessionId !== nextSessionId;
        if (identityChanged) {
            resumableProviderSessionId = null;
            if (pendingResumeProviderSessionId !== nextSessionId) {
                pendingResumeProviderSessionId = null;
            }
        }
        providerSessionId = nextSessionId;
        if (identityChanged) clearPromotedTranscriptForRekey();
        publishProviderSessionId(nextSessionId);
        if (params.enableSessionResumability !== true) ensureGoalStatusTail();
    }

    function readRuntimeEventSessionId(): string {
        if (params.publishTranscriptMessages === true) {
            return readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk';
        }
        return providerSessionId ?? readString(params.happierSessionId) ?? 'claude-agent-sdk';
    }

    async function resolvePermission(
        toolName: string,
        input: unknown,
        options: { signal: AbortSignal; requestId?: string },
    ): Promise<PermissionResult> {
        const parsedInput = readAgentToolInputRecord(input);
        if (!parsedInput) return deniedToolInterception('Claude supplied invalid tool input.');
        let interception: Awaited<ReturnType<AgentSessionHostServices['toolExecution']['before']>>;
        try {
            interception = await params.ctx.agentRuntime.toolExecution.before({
                callId: options.requestId ?? `claude-sdk:${randomUUID()}`,
                name: toolName,
                input: parsedInput,
            }, { signal: options.signal });
        } catch {
            return deniedToolInterception('Tool interception failed.');
        }
        if (interception.status === 'rejected') {
            return deniedToolInterception(interception.message ?? 'Tool execution was rejected.');
        }
        if (interception.status === 'failed') {
            return deniedToolInterception('Tool interception failed.');
        }
        const transformedInput = readAgentToolInputRecord(interception.input);
        if (!transformedInput) {
            return deniedToolInterception('Tool interception returned invalid input.');
        }
        return resolvePermissionAfterInterception(toolName, transformedInput, options);
    }

    async function resolvePermissionAfterInterception(
        toolName: string,
        input: unknown,
        options: Parameters<ClaudePermissionEngine['canCallTool']>[2] = {},
    ): Promise<PermissionResult> {
        if (noTools) {
            return { behavior: 'deny', message: 'Tools are disabled for this execution run.', interrupt: true };
        }
        return permissionEngine.canCallTool(toolName, input, options);
    }

    const claudeSubscriptionRuntimeAuthSelection = readClaudeSubscriptionRuntimeAuthSelectionFromEnv(params.launchEnv);
    const claudeSubscriptionRuntimeAuthSelectionJson = readAgentToolInputRecord(
        claudeSubscriptionRuntimeAuthSelection,
    );
    const refreshRuntimeAuth = sessionContext?.sessions.current.auth?.services?.refreshRuntimeAuth;
    let lastClaudeSdkOAuthTokenFingerprint: string | null = null;
    let pendingClaudeSdkOAuthRefreshAttempt: Readonly<{
        expectedCredentialRevision: string;
        refreshAttemptId: string;
    }> | null = null;
    const requestClaudeSdkRuntimeAuthRefresh = (
        claudeSubscriptionRuntimeAuthSelection
        && claudeSubscriptionRuntimeAuthSelectionJson
        && typeof refreshRuntimeAuth === 'function'
    )
        ? async (input: Readonly<{
            reason: string;
            signal?: AbortSignal;
            failingAccessTokenFingerprint?: string | null;
        }>): Promise<unknown> => {
            // The SDK calls this again after a delivered token fails; carry only the previous
            // token fingerprint so the daemon can adopt a newer stored token before forcing rotation.
            const expectedCredentialRevision = claudeSubscriptionRuntimeAuthSelection.credentialRevision;
            const refreshAttempt = pendingClaudeSdkOAuthRefreshAttempt?.expectedCredentialRevision === expectedCredentialRevision
                ? pendingClaudeSdkOAuthRefreshAttempt
                : Object.freeze({
                    expectedCredentialRevision,
                    refreshAttemptId: `claude-auth-refresh-${randomUUID()}`,
                });
            pendingClaudeSdkOAuthRefreshAttempt = refreshAttempt;
            const refreshRequest = {
                agentId: 'claude',
                serviceId: 'claude-subscription',
                refreshAttemptId: refreshAttempt.refreshAttemptId,
                targetId: readString(params.happierSessionId),
                selection: claudeSubscriptionRuntimeAuthSelectionJson,
                expectedCredentialRevision,
                reason: input.reason,
                ...(input.failingAccessTokenFingerprint !== undefined
                    ? { failingAccessTokenFingerprint: input.failingAccessTokenFingerprint }
                    : {}),
            };
            const result = await refreshRuntimeAuth(refreshRequest, { signal: input.signal });
            const accessToken = readRefreshedAccessToken(result);
            if (accessToken) {
                pendingClaudeSdkOAuthRefreshAttempt = null;
                lastClaudeSdkOAuthTokenFingerprint = computeClaudeSubscriptionAccessTokenFingerprint(accessToken);
            }
            return result;
        }
        : null;
    const getClaudeSdkOAuthToken = requestClaudeSdkRuntimeAuthRefresh
        ? async (options: { signal: AbortSignal }): Promise<string | null> => {
            const result = await requestClaudeSdkRuntimeAuthRefresh({
                reason: 'claude_agent_sdk_oauth_token_refresh',
                signal: options.signal,
                failingAccessTokenFingerprint: lastClaudeSdkOAuthTokenFingerprint,
            });
            return readRefreshedAccessToken(result);
        }
        : null;

    function publishCancelledTurnTerminal(completion: DeferredCompletion, reason: string, turnId: string | null): void {
        if (!completion.claimTerminalPublication()) return;
        publishRuntimeEvent(ClaudeProviderEventSchema.parse({
            sessionId: readRuntimeEventSessionId(),
            emittedAtMs: Date.now(),
            kind: 'turn-cancelled',
            turnId: turnId ?? 'claude-agent-sdk-turn',
            reason,
        }));
    }

    /**
     * A user cancellation is a local authority decision, not a provider observation: the turn ends
     * as soon as the interrupt is dispatched. Waiting for the provider's trailing interruption
     * result left `waitForProviderTurnCompletion` unsettled and `turnInFlight` latched whenever a
     * wedged CLI never answered, so the session could never accept another prompt. The interrupted
     * query keeps draining so its trailing result can still retain the process for the next turn.
     */
    function settleUserCancelledTurn(turnQuery: ClaudeSdkQuery): void {
        if (activeQuery !== turnQuery) return;
        const completion = activeCompletion;
        if (!completion) return;
        activeCompletion = null;
        turnInFlight = false;
        lastTurnCompletionFailure = null;
        reconcileProviderTaskRuntimeActivityForCurrentQuery('user-cancelled');
        publishCancelledTurnTerminal(completion, 'user_request', currentTurnId);
        completion.resolve();
    }

    async function consumeTurnMessages(turnQuery: ClaudeSdkQuery, completion: DeferredCompletion, turnId: string | null, launchEffort?: string | null): Promise<void> {
        const mcpUsage = createClaudeMcpUsageWitness(Object.keys(params.mcpServers ?? {}).filter(name => name !== 'happier'), Date.now());
        const skillUsage = createClaudeSkillUsageWitness();
        let sawResult = false;
        let retainQueryForNextTurn = false;
        let messageSequence = 0;
        let publishedTranscriptText = false;
        let providerFailure: ClaudeProviderFailureEvidence | null = null;
        let foregroundCompleted = false;
        const projectRetryProgress = createClaudeAgentSdkRetryProgress();
        const readForegroundTurnId = (): string | null => !foregroundCompleted
            && !cancelledQueries.has(turnQuery) && activeCompletion === completion ? turnId : null;
        let sdkResultSubtype: string | null = null;
        let observedMainModelId: string | null = null;
        let unpublishedLaunchEffort = launchEffort ?? null;
        const toolNameByCallId = new Map<string, string>();
        const publishTerminal = (event: ClaudeProviderEvent): void => {
            if (!completion.claimTerminalPublication()) return;
            if (event.kind === 'turn-failed') {
                const exit = turnQuery.readExitResult();
                params.ctx.logger.warn('[ClaudeAgentSdk] Turn failed', {
                    sessionId: readString(params.happierSessionId) ?? event.sessionId,
                    turnId: event.turnId,
                    code: readFailureDiagnosticCode(event.issue.code),
                    source: event.issue.source,
                    sdkResultSubtype,
                    processExitObserved: exit !== null,
                    exitCode: exit?.exitCode ?? null,
                    signal: exit?.signal ?? null,
                    stderrSummary: summarizeFailureStderr(exit?.stderr),
                });
            }
            publishRuntimeEvent(event);
        };
        const publishFailedTerminal = (
            error: Error,
            source: ClaudeSessionRuntimeIssueSource,
            code: string,
        ): void => {
            const startupFailure = readClaudeMcpStartupFailure(error);
            publishTerminal(ClaudeProviderEventSchema.parse({
                sessionId: readRuntimeEventSessionId(),
                emittedAtMs: Date.now(),
                kind: 'turn-failed',
                turnId: turnId ?? 'claude-agent-sdk-turn',
                issue: buildClaudeSessionRuntimeIssue({
                    code: startupFailure?.code ?? code,
                    source,
                    occurredAt: Date.now(),
                    agentId: 'claude',
                    sanitizedPreview: sanitizeProviderErrorPreview(error.message),
                    failureCause: projectSessionRuntimeFailureCause(error, startupFailure ? 'client_start' : 'turn', 'agent.turn'),
                }),
            }));
        };
        const publishProviderFailureTerminal = (failure: ClaudeProviderFailureEvidence): void => {
            publishTerminal(ClaudeProviderEventSchema.parse({
                sessionId: readRuntimeEventSessionId(),
                emittedAtMs: Date.now(),
                kind: 'turn-failed',
                turnId: turnId ?? 'claude-agent-sdk-turn',
                issue: buildClaudeSessionRuntimeIssue({
                    code: failure.code,
                    source: failure.source,
                    occurredAt: failure.occurredAtMs ?? Date.now(),
                    agentId: 'claude',
                    sanitizedPreview: failure.preview,
                    usageLimit: failure.usageLimit,
                }),
            }));
        };
        const publishCancelledTerminal = (reason: string): void => {
            publishCancelledTurnTerminal(completion, reason, turnId);
        };
        try {
            while (true) {
                const nextMessage = await turnQuery.next();
                if (nextMessage.done) break;
                const message = nextMessage.value;
                const retryProgress = projectRetryProgress(message, readForegroundTurnId(), readRuntimeEventSessionId());
                if (retryProgress) publishRuntimeEvent(ClaudeProviderEventSchema.parse(retryProgress));
                if (isSdkResultMessage(message)) {
                    sdkResultSubtype = message.subtype === 'success'
                        || message.subtype === 'error_max_turns'
                        || message.subtype === 'error_during_execution'
                        ? message.subtype : 'Unrecognized result subtype (details redacted)';
                }
                if (!isReplayClaudeAgentSdkMessage(message)) {
                    mcpUsage.observe(message);
                    skillUsage.observe(message);
                }
                const commands = readClaudeNativeCommands(message);
                if (commands !== null) {
                    publishRuntimeEvent(ClaudeProviderEventSchema.parse({
                        kind: 'available-commands', sessionId: readRuntimeEventSessionId(),
                        emittedAtMs: Date.now(), commands,
                    }));
                }
                messageSequence += 1;
                const assistantModelId = readSdkAssistantModelId(message);
                if (assistantModelId) {
                    observedMainModelId = assistantModelId;
                    if (activeQuery === turnQuery) {
                        publishEffectiveModel({ modelId: assistantModelId,
                            ...(unpublishedLaunchEffort ? { reasoningEffort: unpublishedLaunchEffort } : {}) });
                        unpublishedLaunchEffort = null;
                    }
                }
                if (isClaudeProviderActivityHookObservationLoss(message, providerSessionId)) {
                    providerActivityLedger.noteObservationLost(turnQuery);
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('hook-response-observation-lost');
                }
                if (
                    requestClaudeSdkRuntimeAuthRefresh
                    && hasClaudeAgentSdkDefinitiveSubagentRuntimeAuthFailureEvidence(message)
                ) {
                    await requestClaudeSdkRuntimeAuthRefresh({
                        reason: 'claude_agent_sdk_subagent_oauth_revoked',
                    }).catch(() => undefined);
                }
                const nextProviderFailure = readProviderFailureEvidence(message);
                if (nextProviderFailure) {
                    providerFailure = nextProviderFailure;
                }
                observeSessionWorkStateMessage(message);
                if (isSdkSystemMessage(message) && message.subtype === 'compact_boundary'
                    && !isReplayClaudeAgentSdkMessage(message)) {
                    const compactMetadata = isRecord(message.compact_metadata) ? message.compact_metadata : null;
                    publishRuntimeEvent(ClaudeProviderEventSchema.parse({
                        kind: 'context-compaction', sessionId: readRuntimeEventSessionId(), emittedAtMs: Date.now(),
                        compactionId: readString(message.uuid) ?? randomUUID(), phase: 'completed',
                        trigger: compactMetadata?.trigger === 'auto' ? 'automatic'
                            : compactMetadata?.trigger === 'manual' ? 'manual' : 'unknown',
                        ...readClaudeCompactionMetadata(message),
                        ...(readForegroundTurnId() ? { turnId: readForegroundTurnId() } : {}),
                    }));
                }
                const completedBackgroundTasks = observeProviderTaskActivity(message, undefined, turnQuery)
                    && sawResult
                    && !providerActivityLedger.hasUnsettledProviderTasks(turnQuery);
                const isSuccessfulResultMessage = isSdkResultMessage(message)
                    && message.subtype === 'success'
                    && message.is_error !== true;
                if (nextProviderFailure || (isSdkResultMessage(message) && !isSuccessfulResultMessage)) {
                    // Recovery needs the same persisted conversation proof as a
                    // successful turn. Drain pending native rows before failure
                    // publication, so a fresh quota turn can retain its identity.
                    await resumeIdentityOwner?.settleCurrentCandidate();
                }
                if (!isSdkResultMessage(message) && (params.publishSdkMessages === true
                    || (params.publishTranscriptMessages === true && message.type === 'stream_event'))) {
                    const runtimeEvent = mapSdkRuntimeEvent({
                        message,
                        sessionId: providerSessionId ?? readString(params.happierSessionId) ?? 'claude-agent-sdk',
                        turnId: readForegroundTurnId(),
                        providerFailure,
                    });
                    publishRuntimeEvent(runtimeEvent);
                }
                // The task projector decides first: a correlated hand-back waits for its terminal
                // notification instead of becoming peer text. Publication order stays text before tool events.
                const toolRuntimeEvents = params.publishSdkMessages === true || params.publishTranscriptMessages === true
                    ? mapSdkToolRuntimeEvents({
                        message,
                        sessionId: readRuntimeEventSessionId(),
                        turnId: readForegroundTurnId(),
                        toolNameByCallId,
                        taskNotificationProjector,
                    })
                    : null;
                if ((params.publishTranscriptMessages === true || params.publishSdkMessages === true)
                    && toolRuntimeEvents?.projectedTaskResult !== true) {
                    const transcriptEvent = mapSdkTranscriptEvent({
                        message,
                        sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                        sequence: messageSequence,
                        turnId: readForegroundTurnId(),
                    });
                    if (transcriptEvent) {
                        if (isSdkAssistantMessage(message) && !isReplayClaudeAgentSdkMessage(message)
                            && !readSdkSidechainId(message)) publishedTranscriptText = true;
                        publishRuntimeEvent(transcriptEvent);
                    }
                }
                if (isSdkAssistantMessage(message)) {
                    const usage = readSdkAssistantUsage(message);
                    publishUsageObservation(buildClaudeAssistantUsageObservation({
                        nativeRecordId: readString(message.uuid),
                        inferenceId: readString(message.message.id),
                        nativeSessionId: readString(message.session_id),
                        turnId: !isReplayClaudeAgentSdkMessage(message) && !readString(message.parent_tool_use_id)
                            ? readForegroundTurnId() : null,
                        modelId: readClaudeAssistantModelId(message),
                        ...(currentProviderModel ? { modelSource: 'provider' } : {}),
                        observedAtMs: Date.now(),
                        ...(!isReplayClaudeAgentSdkMessage(message) && isClaudePrimaryNativeActivity(message)
                            && readForegroundTurnId() && sdkRequestClocks.has(message)
                            ? { requestStartedAtMs: sdkRequestClocks.get(message) } : {}),
                        usage: usage ?? {},
                    }));
                }
                if (params.publishSdkMessages === true || params.publishTranscriptMessages === true) {
                    for (const { request: media } of readClaudeToolResultMediaRequests(message)) {
                        const publisher = params.ctx.sessions?.current.media;
                        if (!publisher?.publishToolResultMedia) {
                            params.ctx.logger.warn('[ClaudeAgentSdk] Session tool-result media capability is unavailable');
                            continue;
                        }
                        try {
                            await publisher.publishToolResultMedia(media);
                        } catch {
                            // The media owner records diagnostics; preserve the tool's text and lifecycle.
                            params.ctx.logger.warn('[ClaudeAgentSdk] Tool-result media publication failed');
                        }
                    }
                    for (const runtimeEvent of toolRuntimeEvents?.events ?? []) {
                        publishRuntimeEvent(runtimeEvent);
                    }
                }
                if (completedBackgroundTasks) {
                    completeProviderBackgroundObservation(turnQuery);
                    return;
                }
                if (nextProviderFailure) {
                    if (activeQuery === turnQuery) activeQuery = null;
                    if (activeCompletion === completion) {
                        activeCompletion = null;
                        turnInFlight = false;
                    }
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('provider-error');
                    publishProviderFailureTerminal(nextProviderFailure);
                    const providerError = createProviderFailureError(nextProviderFailure);
                    lastTurnCompletionFailure = providerError;
                    completion.reject(providerError);
                    return;
                }
                if (!isSdkResultMessage(message)) continue;
                const explicitResumeFailure = resumeIdentityOwner
                    ?.validateSdkResultProviderSessionId(message.session_id);
                if (explicitResumeFailure) {
                    publishFailedTerminal(
                        explicitResumeFailure,
                        'stream_error',
                        explicitResumeFailure.code,
                    );
                    lastTurnCompletionFailure = explicitResumeFailure;
                    completion.reject(explicitResumeFailure);
                    return;
                }
                const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : null;
                // Aggregate usage may include children. Only this query's main assistant, or
                // one unambiguous usage model, can identify the main model and its context.
                const resultModelId = resolveClaudeSdkResultMainModelId({ observedMainModelId, modelUsage });
                if (modelUsage) {
                    if (activeQuery === turnQuery && resultModelId) {
                        const usage = isRecord(modelUsage[resultModelId]) ? modelUsage[resultModelId] : null;
                        publishEffectiveModel({
                            modelId: resultModelId,
                            contextWindowTokens: readNonnegativeInteger(usage?.contextWindow),
                        });
                    }
                }
                // Drain any pending workflow activity at turn end so durable records + headline
                // land promptly (best-effort; a publish failure must not affect turn completion).
                if (workflowRuntime) void workflowRuntime.flush().catch(() => undefined);
                const resultTurn = {
                    completion,
                    message,
                    messageSequence,
                    providerFailure,
                    publishedTranscriptText,
                    turnQuery,
                    turnId,
                    modelId: resultModelId,
                };
                // Query owns native prompt attribution; this ordered consumer owns turn lifecycle.
                const retainForeground = turnQuery.shouldRetainForegroundForResult(message);
                if (
                    !foregroundCompleted
                    && !cancelledQueries.has(turnQuery)
                    && retainForeground
                ) {
                    publishResultEvidence(resultTurn);
                    if (!isSuccessfulResultMessage) {
                        params.ctx.logger.warn('[ClaudeAgentSdk] Earlier result failed while user turns remain queued', {
                            error: createResultError(message, providerFailure),
                        });
                    }
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('result-with-queued-user-turns');
                    continue;
                }
                const usedSkills = skillUsage.finish();
                const foregroundTurnId = readForegroundTurnId();
                if (foregroundTurnId && usedSkills.length) {
                    publishRuntimeEvent(ClaudeProviderEventSchema.parse({ kind: 'skill-usage',
                        sessionId: readRuntimeEventSessionId(), turnId: foregroundTurnId, emittedAtMs: Date.now(), skills: usedSkills }));
                }
                if (isSuccessfulResultMessage) {
                    sawResult = true;
                    const shouldContinueForBackgroundTasks = providerActivityLedger.hasUnsettledProviderTasks(turnQuery);
                    if (!shouldContinueForBackgroundTasks) providerActivityLedger.completeQueryObservation(turnQuery);
                    if (foregroundTurnId
                        && Object.keys(params.mcpServers ?? {}).length > 0) {
                        publishRuntimeEvent(ClaudeProviderEventSchema.parse({ kind: 'mcp-tool-usage',
                            sessionId: readRuntimeEventSessionId(), turnId: foregroundTurnId, emittedAtMs: Date.now(),
                            ...mcpUsage.finish(Date.now(), !shouldContinueForBackgroundTasks) }));
                    }
                    // Native persistence can settle after SessionStart without another hook.
                    // Publish the existing candidate's durable proof before completing this turn.
                    await resumeIdentityOwner?.settleCurrentCandidate();
                    // One Claude process serves the Session (streaming input, as 0.2 did). Retain it
                    // before the turn settles so the next prompt is written into it, unless a newer
                    // query superseded it or a launch-only setting change invalidates it
                    // (`invalidateRetainedQueryReuse`).
                    if (!shouldContinueForBackgroundTasks) {
                        retainQueryForNextTurn = retainIdleQueryForNextTurn(turnQuery, unpublishedLaunchEffort);
                    }
                    completeSuccessfulTurn(resultTurn, publishTerminal);
                    foregroundCompleted = true;
                    if (shouldContinueForBackgroundTasks) {
                        backgroundQueries.add(turnQuery);
                        continue;
                    }
                } else {
                    sawResult = true;
                    publishResultUsage(message, Date.now(), resultModelId);
                    const cancellationReason = cancelledQueries.get(turnQuery);
                    if (cancellationReason === 'user_request') {
                        cancelledQueries.delete(turnQuery);
                        if (activeQuery === turnQuery) activeQuery = null;
                        if (activeCompletion === completion) {
                            activeCompletion = null;
                            turnInFlight = false;
                        }
                        reconcileProviderTaskRuntimeActivityForCurrentQuery('result-cancelled');
                        publishCancelledTerminal(cancellationReason);
                        lastTurnCompletionFailure = null;
                        completion.resolve();
                        // The local cancellation already ended this turn, so a next prompt may have
                        // opened a newer query before this trailing result landed. Only the newest
                        // query may be retained; an already-superseded one is disposed below.
                        retainQueryForNextTurn = retainIdleQueryForNextTurn(turnQuery, unpublishedLaunchEffort);
                        return;
                    }
                    if (activeQuery === turnQuery) activeQuery = null;
                    if (activeCompletion === completion) {
                        activeCompletion = null;
                        turnInFlight = false;
                    }
                    providerActivityLedger.completeQueryObservation(turnQuery);
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('result-error');
                    publishTerminal(mapSdkRuntimeEvent({
                        message,
                        sessionId: readRuntimeEventSessionId(),
                        turnId: turnId ?? 'claude-agent-sdk-turn',
                        providerFailure,
                    })!);
                    const resultError = createResultError(message, providerFailure);
                    lastTurnCompletionFailure = resultError;
                    completion.reject(resultError);
                }
                return;
            }
            if (!sawResult || providerActivityLedger.hasUnsettledProviderTasks(turnQuery)) {
                providerActivityLedger.noteObservationLost(turnQuery);
                reconcileProviderTaskRuntimeActivityForCurrentQuery('query-observation-lost');
            }
            if (!sawResult) {
                const noResultError = createClaudeSdkNoResultError(turnQuery.readExitResult());
                const cancellationReason = cancelledQueries.get(turnQuery);
                if (cancellationReason) publishCancelledTerminal(cancellationReason);
                else publishFailedTerminal(noResultError, 'agent_process_exit', 'claude_sdk_no_result');
                lastTurnCompletionFailure = noResultError;
                completion.reject(noResultError);
            }
        } catch (error) {
            providerActivityLedger.noteObservationLost(turnQuery);
            reconcileProviderTaskRuntimeActivityForCurrentQuery('query-error-observation-lost');
            if (foregroundCompleted) {
                backgroundQueries.delete(turnQuery);
                if (backgroundQueries.size === 0) {
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('background-query-error');
                }
                return;
            }
            reconcileProviderTaskRuntimeActivityForCurrentQuery('turn-error');
            const turnError = error instanceof Error ? error : new Error(String(error));
            const cancellationReason = cancelledQueries.get(turnQuery);
            if (cancellationReason) publishCancelledTerminal(cancellationReason);
            else publishFailedTerminal(turnError, 'stream_error', 'claude_sdk_stream_error');
            lastTurnCompletionFailure = turnError;
            completion.reject(turnError);
        } finally {
            if (backgroundQueries.has(turnQuery)) {
                backgroundQueries.delete(turnQuery);
                if (backgroundQueries.size === 0 && !turnInFlight) {
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('turn-finally');
                }
            }
            // A retained query may already run the next turn: only its own completion is cleared.
            if (activeQuery === turnQuery && !retainQueryForNextTurn) activeQuery = null;
            if (activeCompletion === completion) {
                activeCompletion = null;
                turnInFlight = false;
            }
            if (!retainQueryForNextTurn && !backgroundQueries.has(turnQuery)) {
                await turnQuery.dispose().catch(() => undefined);
            }
        }
    }

    /** Session-level observation for a query that serves Session turns (launched per prompt or adopted). */
    function observeSessionQueryMessage(query: ClaudeSdkQuery, message: SDKMessage): void {
        const nativeSessionId = readClaudeProviderIdentityValue(message.session_id);
        const establishesIdentity = isSdkSystemMessage(message)
            && (message.subtype === 'init' || message.subtype === 'compact_boundary');
        if (activeQuery === query && isClaudePrimaryNativeActivity(message)
            && (establishesIdentity || !nativeSessionId || !providerSessionId || nativeSessionId === providerSessionId)) {
            if (params.enableSessionResumability !== true
                && ((isSdkSystemMessage(message) && message.subtype !== 'hook_response')
                    || isSdkResultMessage(message))) {
                observeProviderSessionId(message.session_id);
            }
        }
        if (!sessionContext) return;
        const primaryFailure = readProviderFailureEvidence(message)
            ?? (isSdkResultMessage(message)
                && (message.subtype !== 'success' || message.is_error === true)
                && shouldSurfaceClaudeAgentSdkRuntimeFailure(message)
                ? buildResultFailureEvidence(message, null) : null);
        void recordClaudeRuntimeProviderAccountUsageSnapshot({
            ctx: sessionContext,
            evidence: message,
            sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
            launchEnv: params.launchEnv,
            ...(primaryFailure?.usageLimit ? { policyDisposition: 'evidence_only' } as const : {}),
        });
    }

    /**
     * Runner respawn after a crash (`agentRuntime.adoptsHeldAgent`): the Agent the crashed
     * runner started still runs in the Session holder, maybe mid-turn. Its query starts now,
     * so this runner's first Agent launch is the one that adopts it. Whether a turn is still
     * running comes from the holder's stored state (`readHeldAgentTurn`), never from output
     * or time:
     * - `turn`: the rest of that turn is read outside a prompt as a provider-started turn
     *   (the host maps it onto the Session turn the crashed runner admitted);
     * - otherwise the live Agent is retained, and the next prompt reuses it.
     */
    async function adoptHeldAgent(): Promise<void> {
        const hookPluginDir = await ensureSessionHookPluginDir();
        if (runtimeDisposed) return;
        const resume = readCurrentResumeProviderSessionId();
        const { options, launchEffort } = buildQueryLaunchOptions(hookPluginDir);
        const idle = new AbortController();
        const query = createOwnedQuery({
            prompt: createIdlePromptStream(idle.signal),
            options: { ...options, ...(resume ? { resume } : {}) },
            // The adopted Agent keeps serving this Session's later turns.
            onMessageReceived: message => observeSessionQueryMessage(query, message),
            onObservationLost: () => {
                idle.abort();
                if (adoptedQuery === query) adoptedQuery = null;
            },
        }, () => currentTurnId);
        adoptedQuery = query;
        disposeQuery = query;
        const held = await query.readHeldAgentTurn();
        if (runtimeDisposed || adoptedQuery !== query) return;
        if (held !== 'turn') {
            retainedIdleQuery = { query, unpublishedLaunchEffort: launchEffort };
            return;
        }
        adoptedQuery = null;
        turnSequence += 1;
        currentTurnId = `claude-agent-sdk-turn-${turnSequence}`;
        publishRuntimeEvent(ClaudeProviderEventSchema.parse({
            sessionId: readRuntimeEventSessionId(),
            emittedAtMs: Date.now(),
            kind: 'turn-start',
            turnId: currentTurnId,
            startedBy: 'provider',
        }));
        turnInFlight = true;
        lastTurnCompletionFailure = null;
        const completion = createDeferred();
        completion.promise.catch(() => undefined);
        activeCompletion = completion;
        activeQuery = query;
        void consumeTurnMessages(query, completion, currentTurnId, launchEffort);
    }

    let onPromptDeliveryOutcome: ClaudeProviderPromptDeliveryOutcomeCallback | null = null;
    async function reserveHostPromptEcho(): Promise<string> {
        // Claude stream-json preserves the supplied UUID in its native user row.
        // Reserve it before transport: ordered source catch-up can start as soon
        // as Claude admits this prompt, including host-only WorkerUpdate context.
        const uuid = randomUUID();
        const localId = buildClaudeJsonlProviderFactLocalIdFromParts({ type: 'user', id: uuid });
        if (localId) await sessionContext?.agentRuntime.transcripts.markSourceFactConsumed?.({ localId, reason: 'host_prompt_echo' });
        return uuid;
    }
    const compactionListeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    const compactionControl = createClaudeSdkCompactionControl({
        sessionId: readRuntimeEventSessionId(),
        signal: params.abortSignal,
        isUnavailable: () => runtimeDisposed,
        isBusy: () => turnInFlight || backgroundQueries.size > 0,
        readResumeIdentity: () => params.enableSessionResumability === true
            ? resumableProviderSessionId ?? pendingResumeProviderSessionId
            : providerSessionId ?? pendingResumeProviderSessionId,
        async launch(prompt, resume, signal) {
            await invalidateRetainedQueryReuse();
            const hookPluginDir = await ensureSessionHookPluginDir();
            const uuid = await reserveHostPromptEcho();
            if (signal.aborted || runtimeDisposed) throw new Error('Claude compact query was cancelled before launch.');
            await runtimeAuthIdentity.captureRequest();
            if (signal.aborted || runtimeDisposed) throw new Error('Claude compact query was cancelled before launch.');
            const compactQuery = createOwnedQuery({ prompt: createPromptStream(prompt, uuid),
                options: { ...buildQueryLaunchOptions(hookPluginDir).options, resume,
                    abort: signal },
                onMessageReceived(message) {
                    if (isSdkResultMessage(message) && isClaudePrimaryNativeActivity(message)
                        && (!message.session_id || message.session_id === resume)) {
                        providerActivityLedger.completeQueryObservation(compactQuery);
                    }
                },
            });
            return compactQuery;
        },
        publish: event => { for (const listener of compactionListeners) listener(event); },
    });
    let terminalStartupInstructions: ReturnType<typeof materializeClaudeStartupInstructions> | undefined;
    let terminalMcpConfig: ReturnType<typeof materializeClaudeMcpConfigArgsForSpawn> | undefined;
    /**
     * A new Session the host starts under remote control (`agentRuntime.startsRemote`) gets its
     * first prompt through the host only after the host's remaining startup (runtime publication,
     * pending-queue materialization, turn preparation and admission). Claude Code boots for about
     * a second before it reads a prompt, so it starts here on an idle prompt stream, with the same
     * launch options a first turn would use, and is retained: the first prompt reuses it like any
     * retained Agent. A launch-setting change disposes it before that prompt (the turn launches a
     * fresh one, as before); a resume id or a local terminal start retires it.
     */
    async function startAgentBeforeFirstPrompt(): Promise<void> {
        const hookPluginDir = await ensureSessionHookPluginDir();
        if (runtimeDisposed || readCurrentResumeProviderSessionId() || turnInFlight || pendingSubmission
            || disposeQuery || readLiveRetainedQuery()) return;
        const { options, launchEffort } = buildQueryLaunchOptions(hookPluginDir);
        const idle = new AbortController();
        const query = createOwnedQuery({
            prompt: createIdlePromptStream(idle.signal),
            options,
            onMessageReceived: message => observeSessionQueryMessage(query, message),
            onObservationLost: () => idle.abort(),
        }, () => currentTurnId);
        disposeQuery = query;
        retainedIdleQuery = { query, unpublishedLaunchEffort: launchEffort, startedAtOpen: true };
    }

    const readCurrentResumeProviderSessionId = () => params.enableSessionResumability === true
        ? resumableProviderSessionId ?? pendingResumeProviderSessionId
        : providerSessionId ?? pendingResumeProviderSessionId;
    const operations: ClaudeAgentSdkNativeOperations & Readonly<{
        sendProviderTurnPrompt(
            prompt: string,
            meta?: Parameters<ClaudeRuntimeTurnOperations['sendProviderTurnPrompt']>[1],
            publishTurnTerminal?: boolean,
        ): Promise<ClaudeRuntimePromptSubmissionOutcome>;
        prepareTerminalPresentation: NonNullable<AgentSessionRuntime['prepareTerminalPresentation']>;
        observeTerminalExecution: NonNullable<AgentSessionRuntime['observeTerminalExecution']>;
    }> = {
        runtimeAuthIdentity,
        ...(goalRuntime ? {
            setGoal: (objective: string | undefined, options?: Readonly<{ status?: string; tokenBudget?: number | null }>) =>
                settleGoalControl(() => goalRuntime.setGoal(objective, options), snapshot =>
                    snapshot.items.some(item => item.kind === 'goal' && item.status === 'active' && item.title === objective?.trim())),
            clearGoal: () => settleGoalControl(() => goalRuntime.clearGoal(), snapshot =>
                // Clear has no native goal_status: its command completion is the
                // native ACK, while the source owns removal of the published item.
                !snapshot.items.some(item => item.kind === 'goal'), true),
        } : {}),
        async refreshSkills(request, options) {
            if (runtimeDisposed) throw new Error('Claude Agent SDK runtime is disposed.');
            options?.signal?.throwIfAborted();
            const nextSkills = { ...request.skills, nativeDisables: params.skills?.nativeDisables ?? [] };
            if (nextSkills.pluginRoot !== currentSkills?.pluginRoot) {
                await invalidateRetainedQueryReuse();
            }
            currentSkills = nextSkills;
            // A fresh query loads currentSkills at launch. Reload only the live
            // query; an idle refresh needs no additional Claude process.
            const query = activeQuery ?? retainedIdleQuery?.query;
            if (query) await query.reloadSkills(options);
            return { kind: 'applied' };
        },
        async prepareTerminalPresentation() {
            if (runtimeDisposed) throw new Error('Claude Agent SDK runtime is disposed.');
            await resumeIdentityOwner?.settleCurrentCandidate();
            const resumeFailure = resumeIdentityOwner?.readExplicitResumeFailure();
            if (resumeFailure) throw resumeFailure;
            let binding: LocalTerminalHookBinding | null = null;
            const hooks = await createSessionHookBinding(() => binding && providerActivityLedger.isTerminalOwnerObserved(binding) ? binding : null);
            if (runtimeDisposed) {
                await hooks?.dispose();
                throw new Error('Claude Agent SDK runtime is disposed.');
            }
            const hookPluginDir = hooks?.pluginDir ?? null;
            try {
                await prepareClaudeTerminalConfigHome(params.launchEnv);
                const resumeId = readCurrentResumeProviderSessionId();
                terminalStartupInstructions ??= params.startupInstructions
                    ? materializeClaudeStartupInstructions(params.startupInstructions) : undefined;
                terminalMcpConfig ??= materializeClaudeMcpConfigArgsForSpawn(buildClaudeMcpConfigArgs(mcpServers), message => params.ctx.logger.warn(message));
                const plan: LocalTerminalHookBinding['plan'] = {
                    requiredFiles: [...terminalMcpConfig.requiredFiles, ...(terminalStartupInstructions?.requiredFiles ?? [])],
                    argv: resolveClaudeLaunchSettingsOverlayArgs({
                        args: [
                            ...(resumeId ? ['--resume', resumeId] : []),
                            ...(terminalStartupInstructions?.args ?? []),
                            ...(params.supportsSystemPromptSnapshotOff === true ? ['--system-prompt-snapshot', 'off'] : []),
                            ...buildClaudePluginDirArgs({ hookPluginDir, skills: currentSkills }),
                            ...(currentModelId ? ['--model', currentModelId] : []),
                            ...buildClaudeEffortCliArgs({ modelId: currentModelId, effort: currentEffort,
                                ...(currentProviderModel ? { providerModel: currentProviderModel } : {}) }),
                            ...buildClaudePermissionModeArgs(currentPermissionMode),
                            ...terminalMcpConfig.args,
                            ...(noToolsLaunchOptions ? ['--strict-mcp-config'] : []),
                        ],
                        interactionKind: 'interactive_terminal',
                        launchEnv: params.launchEnv,
                        cwd: params.directory,
                        skillOverrides,
                        mcpToolPolicy: params.mcpToolPolicy,
                        permissionMode: mapToClaudePermissionMode(currentPermissionMode),
                        launchSettings: currentUltracode && isClaudeUltracodeSupportedModelId(currentModelId, currentProviderModel)
                            ? { ultracode: true } : {},
                        workspaceWrites: currentWorkspaceWrites,
                        nativeSandbox: params.nativeSandbox,
                        helperModelEnv: params.helperModelEnv,
                        allowedTools: noToolsLaunchOptions?.allowedTools ?? params.allowedTools,
                        unlistedTools: noToolsLaunchOptions?.unlistedTools ?? params.unlistedTools,
                    }),
                    environment: { values: params.launchEnv, unset: [] },
                    process: { stdio: 'inherit', windowsHide: true },
                    presentation: {
                        onLaunch: { target: 'local', reason: 'claude_sdk_terminal_start' },
                        onExit: { target: 'remote', reason: 'claude_sdk_terminal_exit' },
                    },
                };
                if (hooks) {
                    const previousPrepared = preparedLocalHookBinding;
                    binding = { plan, hooks };
                    preparedLocalHookBinding = binding;
                    await previousPrepared?.hooks.dispose();
                }
                return { kind: 'terminal_launch', plan };
            } catch (error) {
                if (binding && preparedLocalHookBinding === binding) preparedLocalHookBinding = null;
                try {
                    await hooks?.dispose();
                } catch (cleanupError) {
                    throw Object.assign(new AggregateError([error, cleanupError], 'Claude terminal preparation and cleanup failed', { cause: error }), {
          failureCause: projectSessionRuntimeFailureCause(error, 'client_start', 'agent.launch'),
        });
                }
                throw error;
            }
        },
        async observeTerminalExecution(input) {
            const pending = preparedLocalHookBinding?.plan === input.plan ? preparedLocalHookBinding : null;
            // Only this factory registers terminal scopes; its object retains the resources and plan.
            const owned = providerActivityLedger.getRegisteredTerminalOwners()
                .map(scope => scope as LocalTerminalHookBinding).find(scope => scope.plan === input.plan);
            const binding = pending ?? owned;
            if (!binding || (owned && input.kind === 'launch_failed')) return;
            if (input.kind === 'started') {
                if (runtimeDisposed || !pending) return;
                preparedLocalHookBinding = null;
                providerActivityLedger.registerTerminalOwner(binding);
                // The local terminal Agent owns the conversation now; an unprompted SDK Agent is no one's.
                await retireAgentStartedAtOpen();
                return;
            }
            if (pending) preparedLocalHookBinding = null;
            if (owned) {
                if (input.kind === 'provider_stopped' && (input.exitCode !== null || input.signal !== null)) {
                    providerActivityLedger.noteProviderStopped(binding);
                } else {
                    providerActivityLedger.noteObservationLost(binding);
                }
                reconcileProviderTaskRuntimeActivityForCurrentQuery(`local-terminal-${input.kind}`);
            }
            await binding.hooks.dispose();
        },
        async observeSourceTranscript(input) {
            if (runtimeDisposed || input.phase !== 'initial_replay'
                || input.providerSessionId !== orderedSourceBinding?.providerSessionId) return;
            const projection = taskNotificationProjector.project(input.row);
            const replayRow = projection?.message ?? input.row;
            const emittedAtMs = isRecord(replayRow) ? readClaudeJsonlRowTimestampMs(replayRow) ?? Date.now() : Date.now();
            const publishTranscript = params.publishTranscriptMessages === true || params.publishSdkMessages === true;
            if (publishTranscript && projection?.message) {
                for (const event of mapSdkToolResultRuntimeEvents({
                    message: input.row, resultMessage: projection.message,
                    sessionId: readRuntimeEventSessionId(), turnId: null, emittedAtMs,
                })) publishRuntimeEvent(event);
            } else if (publishTranscript && !projection && readClaudeNativePeerMessage(input.row)?.peer.handback) {
                const event = mapSdkTranscriptEvent({
                    message: input.row, sessionId: readRuntimeEventSessionId(), sequence: 0, turnId: null,
                });
                if (event) publishRuntimeEvent({ ...event, emittedAtMs });
            }
            workflowRuntime?.observeTranscriptMessage(input.row, { historicalReplay: true });
        },
        compact: compactionControl.compact,
        isTurnInFlight: () => turnInFlight,
        subscribeCanonicalAgentSessionEvents(listener) {
            compactionListeners.add(listener);
            const unsubscribe = runtimeActivityPublisher.subscribe(listener);
            return () => { compactionListeners.delete(listener); unsubscribe(); };
        },
        subscribeEffectiveModel(listener) {
            effectiveModelListeners.add(listener);
            return () => effectiveModelListeners.delete(listener);
        },
        subscribeUsageObservation(listener) {
            usageObservationListeners.add(listener);
            return () => usageObservationListeners.delete(listener);
        },
        startHeldAgentAdoption() {
            if (agentStartAtOpen || sessionContext?.agentRuntime.adoptsHeldAgent !== true) return;
            agentStartAtOpen = adoptHeldAgent().catch((error: unknown) => {
                params.ctx.logger.warn('[ClaudeAgentSdk] Held Agent adoption failed', { error });
            });
        },
        beginProviderTurn(turnId) {
            currentTurnId = readString(turnId);
            if (!currentTurnId) {
                turnSequence += 1;
                currentTurnId = `claude-agent-sdk-turn-${turnSequence}`;
            }
            publishRuntimeEvent(ClaudeProviderEventSchema.parse({
                sessionId: readRuntimeEventSessionId(),
                emittedAtMs: Date.now(),
                kind: 'turn-start',
                turnId: currentTurnId,
                startedBy: 'host',
            }));
        },
        async startProviderSession(opts) {
            const requestedResumeId = readClaudeProviderIdentityValue(opts?.resumeId);
            if (requestedResumeId && providerSessionId === null) {
                pendingResumeProviderSessionId = requestedResumeId;
                // A Claude started at open began a new conversation, not this one.
                if (agentStartAtOpen) await agentStartAtOpen;
                await retireAgentStartedAtOpen();
            }
            return providerSessionId;
        },
        async sendProviderTurnPrompt(prompt, meta, publishTurnTerminal: boolean = true) {
            // While adopting, a held turn may still be running: decide after the holder said.
            if (agentStartAtOpen) await agentStartAtOpen;
            const compactionCompletion = compactionControl.readCompletion();
            if (compactionCompletion) await compactionCompletion;
            if (runtimeDisposed) {
                return {
                    kind: 'rejected_before_effect',
                    reason: 'Claude Agent SDK runtime is disposed.',
                };
            }
            if (turnInFlight) {
                return {
                    kind: 'rejected_before_effect',
                    reason: 'Claude Agent SDK turn is already running.',
                };
            }
            turnInFlight = true;
            const submittedTurnId = publishTurnTerminal ? currentTurnId : null;
            const submission = { cancelled: false };
            pendingSubmission = submission;
            try {
                lastTurnCompletionFailure = null;
                const promptContent = await resolvePromptContent(prompt, meta?.structuredInput, params.ctx.agentRuntime.inputFiles);
                reconcileProviderTaskRuntimeActivityForCurrentQuery('new-turn');
                const completion = createDeferred(publishTurnTerminal);
                completion.promise.catch(() => undefined);
                const hookPluginDir = await ensureSessionHookPluginDir();
                if (submission.cancelled) {
                    throw new Error('Claude Agent SDK turn was cancelled before provider submission.');
                }
                if (runtimeDisposed) {
                    throw new Error('Claude Agent SDK runtime is disposed.');
                }
                await resumeIdentityOwner?.settleCurrentCandidate();
                if (submission.cancelled) {
                    throw new Error('Claude Agent SDK turn was cancelled before provider submission.');
                }
                if (runtimeDisposed) {
                    throw new Error('Claude Agent SDK runtime is disposed.');
                }
                resumeIdentityOwner?.recordSubmittedPrompt(prompt);
                const resumeProviderSessionId = readCurrentResumeProviderSessionId();
                const publishTransportOutcome = (
                    outcome: ClaudeRuntimePromptSubmissionOutcome,
                ): void => {
                    const localIds = [
                        ...(readClaudePendingLocalId(meta?.localId)
                            ? [readClaudePendingLocalId(meta?.localId)!]
                            : []),
                        ...(meta?.localIds ?? [])
                            .map(readClaudePendingLocalId)
                            .filter((value): value is string => value !== null),
                    ].filter((value, index, values) => values.indexOf(value) === index);
                    if (localIds.length !== 1) return;
                    const userMessageSeq = Number.isSafeInteger(meta?.userMessageSeq) && meta!.userMessageSeq! >= 0
                        ? meta!.userMessageSeq!
                        : null;
                    const userMessageSeqs = (meta?.userMessageSeqs ?? [])
                        .filter((seq, index, values) => Number.isSafeInteger(seq) && seq >= 0 && values.indexOf(seq) === index);
                    const identity = {
                        localInputId: localIds[0]!,
                        userMessageSeq,
                        ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
                    };
                    if (outcome.kind === 'accepted') {
                        onPromptDeliveryOutcome?.({
                            type: 'input-accepted',
                            ...identity,
                            delivery: { kind: 'newTurn', turnId: submittedTurnId ?? 'claude-agent-sdk-turn' },
                        });
                    } else if (outcome.kind === 'rejected_before_effect') {
                        const message = sanitizeProviderErrorPreview(outcome.reason);
                        onPromptDeliveryOutcome?.({
                            type: 'input-rejected',
                            ...identity,
                            diagnostic: {
                                code: outcome.code ?? 'claude_sdk_prompt_rejected_before_transport',
                                severity: 'error',
                                ...(message ? { message } : {}),
                            },
                            retryable: outcome.retryable ?? true,
                        });
                    } else if (outcome.kind === 'effect_may_have_occurred') {
                        const message = sanitizeProviderErrorPreview(outcome.reason);
                        onPromptDeliveryOutcome?.({
                            type: 'input-custody-unknown',
                            ...identity,
                            issue: {
                                code: outcome.code ?? 'claude_sdk_prompt_transport_ambiguous',
                                severity: 'error',
                                ...(message ? { message } : {}),
                            },
                        });
                    }
                };
                while (true) {
                    const pendingPermissionModeUpdate = permissionModeUpdate;
                    await pendingPermissionModeUpdate;
                    if (pendingPermissionModeUpdate === permissionModeUpdate) break;
                }
                if (submission.cancelled) {
                    throw new Error('Claude Agent SDK turn was cancelled before provider submission.');
                }
                if (runtimeDisposed) {
                    throw new Error('Claude Agent SDK runtime is disposed.');
                }
                const nativeUserMessageId = await reserveHostPromptEcho();
                if (!publishTurnTerminal) goalRuntime?.source.beginGoalCommandObservation(nativeUserMessageId);
                if (submission.cancelled || runtimeDisposed) {
                    throw new Error('Claude Agent SDK turn was cancelled before provider submission.');
                }
                await runtimeAuthIdentity.captureRequest();
                if (submission.cancelled || runtimeDisposed) {
                    throw new Error('Claude Agent SDK turn was cancelled before provider submission.');
                }
                // Native schema constraints are launch options, so a changed or removed
                // constraint uses the existing Session process-replacement owner.
                if (JSON.stringify(currentOutputSchema) !== JSON.stringify(meta?.outputSchema)) {
                    await invalidateRetainedQueryReuse();
                    currentOutputSchema = meta?.outputSchema;
                }
                readLiveRetainedQuery();
                const retained = retainedIdleQuery;
                if (retained) {
                    if (adoptedQuery === retained.query) adoptedQuery = null;
                    const retainedQuery = retained.query;
                    const transportOutcome = await retainedQuery.sendUserMessage(promptContent, nativeUserMessageId);
                    const outcome = projectPromptTransportOutcome(transportOutcome);
                    if (outcome.kind !== 'rejected_before_effect') {
                        publishTransportOutcome(outcome);
                        if (retainedIdleQuery === retained) retainedIdleQuery = null;
                        activeCompletion = completion;
                        activeQuery = retainedQuery;
                        if (pendingSubmission === submission) pendingSubmission = null;
                        disposeQuery = retainedQuery;
                        void consumeTurnMessages(retainedQuery, completion, submittedTurnId, retained.unpublishedLaunchEffort);
                        // A retained process emits no new SessionStart, which is where a relaunch
                        // retried an unacquired ordered-source baseline; retry it at this prompt instead.
                        const pendingSource = orderedSourceBinding;
                        if (pendingSource && !pendingSource.handle && !pendingSource.acquisition) {
                            void bindOrderedSourceHistory(pendingSource.providerSessionId, {}, true).catch(error => {
                                params.ctx.logger.warn('[ClaudeAgentSdk] ordered source transcript baseline failed', { error });
                            });
                        }
                        return outcome;
                    }
                    // The retained process refused the prompt before any effect (it closed or
                    // exited while idle): retire it and launch a process for this prompt.
                    if (retainedIdleQuery === retained) retainedIdleQuery = null;
                    await retainedQuery.dispose().catch(() => undefined);
                    if (submission.cancelled || runtimeDisposed) {
                        throw new Error('Claude Agent SDK turn was cancelled before provider submission.');
                    }
                }
                const { options, launchEffort } = buildQueryLaunchOptions(hookPluginDir);
                const turnQuery = createOwnedQuery({
                    prompt: createPromptStream(promptContent, nativeUserMessageId),
                    options: { ...options, ...(resumeProviderSessionId ? { resume: resumeProviderSessionId } : {}),
                        ...(currentOutputSchema === undefined ? {} : { outputFormat: { type: 'json_schema', schema: currentOutputSchema } }) },
                    onMessageReceived: message => observeSessionQueryMessage(turnQuery, message),
                }, () => currentTurnId);
                activeCompletion = completion;
                activeQuery = turnQuery;
                if (pendingSubmission === submission) pendingSubmission = null;
                disposeQuery = turnQuery;
                void consumeTurnMessages(turnQuery, completion, submittedTurnId, launchEffort);
                const transportOutcome = await turnQuery.promptTransportOutcome;
                const outcome = projectPromptTransportOutcome(transportOutcome);
                publishTransportOutcome(outcome);
                return outcome;
            } catch (error) {
                turnInFlight = false;
                if (pendingSubmission === submission) pendingSubmission = null;
                const startupFailure = readClaudeMcpStartupFailure(error);
                const outcome: ClaudeRuntimePromptSubmissionOutcome = {
                    kind: 'rejected_before_effect',
                    ...(error instanceof ClaudeBrowserImageUnavailableError ? { code: error.code } : {}),
                    ...startupFailure,
                    failureCause: projectSessionRuntimeFailureCause(error, startupFailure ? 'client_start' : 'turn_start', 'agent.turn'),
                    reason: sanitizeProviderErrorPreview(
                        error instanceof Error ? error.message : String(error),
                    ) ?? 'Claude SDK prompt setup failed.',
                };
                return outcome;
            }
        },
        async steerProviderTurn(message, meta) {
            if (runtimeDisposed) {
                return {
                    kind: 'rejected_before_effect',
                    reason: 'Claude Agent SDK runtime is disposed.',
                };
            }
            const turnQuery = activeQuery;
            if (!turnInFlight || !turnQuery) {
                return {
                    kind: 'rejected_before_effect',
                    reason: 'Claude Agent SDK has no active turn to steer.',
                };
            }
            let content: SDKUserMessage['message']['content'];
            try { content = await resolvePromptContent(message, meta?.structuredInput, params.ctx.agentRuntime.inputFiles); }
            catch (error) {
                if (!(error instanceof ClaudeBrowserImageUnavailableError)) throw error;
                return { kind: 'rejected_before_effect', code: error.code, reason: error.message };
            }
            const uuid = await reserveHostPromptEcho();
            if (runtimeDisposed || !turnInFlight || activeQuery !== turnQuery) {
                return { kind: 'rejected_before_effect', reason: 'Claude Agent SDK turn settled before steer submission.' };
            }
            const outcome = await turnQuery.sendUserMessage(content, uuid);
            return projectPromptTransportOutcome(outcome);
        },
        async waitForProviderTurnCompletion(opts) {
            const timeoutMs = readTimeoutMs(opts);
            if (!activeCompletion && lastTurnCompletionFailure) throw lastTurnCompletionFailure;
            await withTimeout(activeCompletion?.promise ?? Promise.resolve(), timeoutMs);
        },
        subscribeProviderEvents(handler) {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
            };
        },
        setOnPromptDeliveryOutcome(handler) {
            onPromptDeliveryOutcome = handler;
        },
        async respondToProviderPermission(requestId, approved) {
            return sessionContext
                ? respondToClaudePermission({ ctx: sessionContext, provider: 'claude', requestId, approved })
                : { delivered: false, reason: 'no_active_session' };
        },
        async cancelProviderTurn(expectedTurnId?: string) {
            if (expectedTurnId !== undefined && currentTurnId !== expectedTurnId) return false;
            if (pendingSubmission) {
                pendingSubmission.cancelled = true;
                currentTurnId = null;
                return true;
            }
            const turnQuery = (turnInFlight ? activeQuery : null) ?? activeProviderTask?.ownerScope;
            if (!(turnQuery instanceof ClaudeSdkQuery)) return false;
            const cancelledProviderTask = activeProviderTask;
            const cancelledTurnId = currentTurnId;
            cancelledQueries.set(turnQuery, 'user_request');
            const providerTaskId = !turnInFlight && activeProviderTask
                && activeProviderTask.ownerScope === turnQuery
                ? activeProviderTask.taskId : undefined;
            if (providerTaskId) {
                try {
                    await turnQuery.stopTask(providerTaskId);
                    if (activeProviderTask === cancelledProviderTask) activeProviderTask = null;
                    if (activeQuery === turnQuery) activeQuery = null;
                    if (currentTurnId === cancelledTurnId) currentTurnId = null;
                    backgroundQueries.delete(turnQuery);
                    return true;
                } catch (error) {
                    params.ctx.logger.debug(
                        '[ClaudeAgentSdk] Targeted provider task cancellation failed; interrupting query',
                        { error },
                    );
                }
            }
            await turnQuery.interrupt();
            backgroundQueries.delete(turnQuery);
            settleUserCancelledTurn(turnQuery);
            if (currentTurnId === cancelledTurnId) currentTurnId = null;
            return true;
        },
        readProviderIdentity() {
            return { sessionId: providerSessionId };
        },
        async updateProviderConfiguration(update) {
            const configOption = isRecord(update.configOption) ? update.configOption : null;
            const configOptionId = readString(configOption?.id);
            if (
                !supportsEffort
                && (configOptionId === 'reasoning_effort' || configOptionId === 'effort' || configOptionId === 'ultracode')
            ) {
                return { status: 'unsupported' as const, reason: 'effort_unsupported_by_installed_cli' };
            }
            let launchSettingsChanged = false;
            if ((update.workspaceWrites === 'allow' || update.workspaceWrites === 'deny')
                && update.workspaceWrites !== currentWorkspaceWrites) {
                if (turnInFlight || pendingSubmission || backgroundQueries.size > 0) {
                    return { status: 'requires_restart' as const, reason: 'role_policy_restart_required' };
                }
                const previousQuery = disposeQuery !== retainedIdleQuery?.query ? disposeQuery : null;
                await invalidateRetainedQueryReuse();
                await previousQuery?.dispose();
                currentWorkspaceWrites = update.workspaceWrites;
                launchSettingsChanged = true;
            }
            if (readString(configOption?.id) === CLAUDE_CONTEXT_USAGE_REFRESH_CONFIG_OPTION_ID) {
                try {
                    const refreshed = await requestContextUsageOnDemand();
                    return refreshed
                        ? { status: 'applied' as const }
                        : { status: 'unsupported' as const, reason: 'context_usage_unavailable' };
                } catch (error) {
                    params.ctx.logger.debug(
                        '[ClaudeAgentSdk] On-demand context usage refresh failed (non-fatal)',
                        { error },
                    );
                    return { status: 'failed' as const, reason: 'context_usage_refresh_failed' };
                }
            }
            const nextProviderModel = update.providerBinding === undefined
                ? undefined
                : update.providerBinding.model;
            const effectiveProviderModel = nextProviderModel ?? currentProviderModel;
            const permissionMode = readString(update.permissionMode);
            if (permissionMode) {
                const updatePermissionMode = permissionModeUpdate.then(async (): ReturnType<ClaudeRuntimeTurnOperations['updateProviderConfiguration']> => {
                    // Live processes run the current mode already (launched with it or set after it was applied).
                    if (permissionMode === currentPermissionMode) return;
                    const liveQueries = new Set([
                        activeQuery,
                        readLiveRetainedQuery(),
                        ...backgroundQueries,
                    ].filter((query): query is ClaudeSdkQuery => query !== null));
                    try {
                        await Promise.all([...liveQueries].map(query =>
                            query.setPermissionMode(params.unlistedTools === 'deny'
                                ? 'dontAsk' : mapToClaudePermissionMode(permissionMode))));
                    } catch (error) {
                        params.ctx.logger.warn('[ClaudeAgentSdk] Live permission mode update failed', { error });
                        return { status: 'failed' as const, reason: 'permission_mode_update_failed',
                            failureCause: projectSessionRuntimeFailureCause(error, 'turn_start', 'agent.turn') };
                    }
                    currentPermissionMode = permissionMode;
                });
                permissionModeUpdate = updatePermissionMode.then(() => undefined, () => undefined);
                const outcome = await updatePermissionMode;
                if (outcome) return outcome;
            }

            const ultracodeWasActive = currentUltracode && isClaudeUltracodeSupportedModelId(currentModelId, currentProviderModel);
            const modelId = readClaudeRuntimeConfigModelUpdate(update.modelId, effectiveProviderModel);
            if (modelId !== undefined) {
                launchSettingsChanged ||= currentModelId !== modelId;
                currentModelId = modelId;
            }

            const fallbackModel = readClaudeRuntimeConfigModelUpdate(update.fallbackModel, effectiveProviderModel);
            if (fallbackModel !== undefined) {
                launchSettingsChanged ||= currentFallbackModel !== fallbackModel;
                currentFallbackModel = fallbackModel;
            }

            const effort = readEffortFromRuntimeConfigUpdate(update);
            if (effort) {
                launchSettingsChanged ||= currentEffort !== effort;
                currentEffort = effort;
            } else if (effort === null) {
                launchSettingsChanged ||= currentEffort !== null;
                currentEffort = null;
            }

            const ultracode = readUltracodeFromRuntimeConfigUpdate(update);
            if (ultracode !== undefined) {
                currentUltracode = ultracode;
            }
            if (nextProviderModel) {
                currentProviderModel = nextProviderModel;
            }
            launchSettingsChanged ||= ultracodeWasActive !== (
                currentUltracode && isClaudeUltracodeSupportedModelId(currentModelId, currentProviderModel)
            );
            if (launchSettingsChanged) {
                await invalidateRetainedQueryReuse();
            }
            // Launch controls describe the next query even when the requested value is unchanged.
            if (launchSettingsChanged || modelId !== undefined || fallbackModel !== undefined
                || effort !== undefined || ultracode !== undefined) {
                return { status: 'applied' as const, timing: 'before_next_prompt' as const };
            }
            return undefined;
        },
        async disposeProviderSession() {
            if (runtimeDisposePromise) return await runtimeDisposePromise;
            runtimeDisposed = true;
            runtimeDisposePromise = (async () => {
                await compactionControl.dispose();
                const queriesToDispose = new Set(
                    providerActivityLedger.getRegisteredQueryOwners()
                        .filter((owner): owner is ClaudeSdkQuery => owner instanceof ClaudeSdkQuery),
                );
                const cleanupErrors: unknown[] = [];
                const pendingLocalHooks = preparedLocalHookBinding;
                preparedLocalHookBinding = null;
                const localHooksToDispose = providerActivityLedger.getRegisteredTerminalOwners()
                    .map(scope => scope as LocalTerminalHookBinding);
                for (const scope of localHooksToDispose) providerActivityLedger.noteObservationLost(scope);
                if (localHooksToDispose.length > 0) reconcileProviderTaskRuntimeActivityForCurrentQuery('local-terminal-disposed');
                try {
                    if (activeQuery) {
                        cancelledQueries.set(activeQuery, 'runtime_disposed');
                        queriesToDispose.add(activeQuery);
                    }
                    if (disposeQuery) queriesToDispose.add(disposeQuery);
                    if (retainedIdleQuery) queriesToDispose.add(retainedIdleQuery.query);
                    for (const queryToDispose of backgroundQueries) {
                        queriesToDispose.add(queryToDispose);
                    }
                    activeQuery = null;
                    adoptedQuery = null;
                    disposeQuery = null;
                    retainedIdleQuery = null;
                    activeProviderTask = null;
                    activeCompletion = null;
                    lastTurnCompletionFailure = null;
                    backgroundQueries.clear();
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('runtime-dispose');
                    turnInFlight = false;
                    pendingSubmission = null;
                    await sessionHookSetupPromise?.catch(() => undefined);
                    pendingNativeStarts.length = 0;
                    const sourceBinding = orderedSourceBinding;
                    orderedSourceBinding = null;
                    await sourceBinding?.acquisition?.catch((error: unknown) => {
                        params.ctx.logger.warn('[ClaudeAgentSdk] ordered source transcript baseline failed during disposal', { error });
                    });
                    await sourceBinding?.handle?.dispose();
                    if (workflowRuntime) {
                        // Workflow runs, their agents and their `Task` children all live INSIDE this
                        // query, so this teardown is the observation that they are over — resolve them
                        // BEFORE the drain that publishes the query's last rows, or they stay painted
                        // live until some later process's reconcile grace expires.
                        try {
                            workflowRuntime.finalizeInterruptedActivityOnShutdown();
                        } catch {
                            // Non-fatal: the startup reconcile still resolves these rows later.
                        }
                        await workflowRuntime.flush().catch(() => undefined);
                        workflowRuntime.dispose();
                    }
                    await resumeIdentityOwner?.dispose().catch(() => undefined);
                    const tail = goalStatusTail;
                    goalStatusTail = null;
                    if (tail) await retireGoalStatusTail(tail);
                    await Promise.all(Array.from(retiringGoalStatusTails));
                } catch (error) {
                    cleanupErrors.push(error);
                } finally {
                    const hooksToDispose = sessionHookBinding;
                    sessionHookBinding = null;
                    const hookDisposals = await Promise.allSettled([
                        ...(pendingLocalHooks ? [pendingLocalHooks.hooks.dispose()] : []),
                        ...localHooksToDispose.map(scope => scope.hooks.dispose()),
                        ...(hooksToDispose ? [hooksToDispose.dispose()] : []),
                    ]);
                    cleanupErrors.push(...hookDisposals.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
                    await terminalStartupInstructions?.cleanup().catch(() => {
                        params.ctx.logger.warn('[ClaudeAgentSdk] Terminal startup instruction cleanup failed', {
                            error: 'terminal_startup_instruction_cleanup_failed',
                        });
                    });
                    terminalStartupInstructions = undefined;
                    const queryDisposals = await Promise.allSettled(
                        Array.from(queriesToDispose, queryToDispose => queryToDispose.dispose()),
                    );
                    cleanupErrors.push(...queryDisposals.flatMap(result =>
                        result.status === 'rejected' ? [result.reason] : []));
                    effectiveModelListeners.clear();
                    usageObservationListeners.clear();
                    try {
                        await terminalMcpConfig?.cleanup();
                    } catch (error) {
                        cleanupErrors.push(error);
                    } finally {
                        terminalMcpConfig = undefined;
                    }
                }
                if (cleanupErrors.length === 1) throw cleanupErrors[0];
                if (cleanupErrors.length > 1) {
                    throw new AggregateError(cleanupErrors, 'Claude SDK session cleanup failed', {
                        cause: cleanupErrors[0],
                    });
                }
            })();
            await runtimeDisposePromise;
        },
    };

    // Opened now, not when watched: the host watches only after its own remaining startup.
    if (sessionContext?.agentRuntime.startsRemote === true && sessionContext.agentRuntime.adoptsHeldAgent !== true) {
        agentStartAtOpen = startAgentBeforeFirstPrompt().catch((error: unknown) => {
            params.ctx.logger.warn('[ClaudeAgentSdk] Agent start before the first prompt failed', { error });
        });
    }
    return operations;
}
