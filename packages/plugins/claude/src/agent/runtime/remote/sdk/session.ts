import type {
    AgentSessionHookServerHandle,
    AgentSessionProviderBinding,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/experimental/sessions/workState';
import { createClaudeRuntimeActivityPublisher } from '../../shared/runtimeActivityPublisher.js';
import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk/experimental/diagnostics';
import {
    readClaudePendingLocalId,
} from '../../providerOperations.js';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/experimental/timeout';
import {
    ConnectedServiceCredentialRevisionV1Schema,
    type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
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
import {
    createClaudeSdkNoResultError,
    queryWithContext,
    type ClaudeSdkQueryContext,
} from '../../../sdk/query.js';
import type { ClaudeSdkQuery } from '../../../sdk/query.js';
import type {
    PermissionResult,
    SDKAssistantMessage,
    SDKMessage,
    SDKResultMessage,
    SDKSystemMessage,
    SDKUserMessage,
} from '../../../sdk/types.js';
import { recordClaudeRuntimeProviderAccountUsageSnapshot } from '../../accountUsage.js';
import { buildClaudeLiveContextUsageSnapshot } from '../../../usage/liveContextSnapshot.js';
import { buildClaudeAssistantUsageObservation } from '../../../usage/buildAssistantObservation.js';
import { buildClaudeSdkResultUsageObservation } from '../../../usage/buildSdkResultObservation.js';
import type {
    ClaudeTokenUsage,
    ClaudeUsageObservation,
    ClaudeUsageObservationSubscription,
} from '../../../usage/types.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import { getClaudeProjectPath, resolveClaudeConfigDirOverride } from '../../../surfaces/sessions/handoff/path.js';
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
    type ClaudeSessionRuntimeIssueSource,
} from '../../issues/runtimeIssues.js';
import {
    createClaudeUnifiedWorkflowRuntime,
    registerClaudeWorkflowOwnedToolUseIds,
} from '../../../workflowRecords/index.js';
import { createClaudeUnifiedGoalRuntime } from '../../terminal/unified/goalRuntime.js';
import { computeClaudeSubscriptionAccessTokenFingerprint } from '../../../auth/services/cloud/refreshBridge.js';
import {
    createClaudeAgentSdkGoalStatusTail,
    type ClaudeAgentSdkGoalStatusTail,
} from './goalStatusTail.js';
import {
    extractToolResultBlocksFromSdkMessage,
    extractToolUseBlocksFromSdkMessage,
} from './streamEvents.js';
import {
    createClaudeProviderActivityLedger,
    isClaudeProviderActivityHookObservationLoss,
    isReplayClaudeAgentSdkMessage,
    normalizeClaudeProviderTaskEvent,
    type ClaudeProviderTaskActivity,
} from './providerActivity.js';
import {
    applyClaudeProviderTaskActivity,
    publishClaudeProviderTaskInventory,
    readClaudeRuntimeConfigEffortUpdate,
    readClaudeRuntimeConfigUltracodeUpdate,
    readClaudeRuntimeString,
    respondToClaudePermission,
} from '../../shared/runtimeHelpers.js';
import { createClaudeAgentSdkResumeIdentityOwner } from './resumeIdentity.js';
import type { ClaudeUnifiedTerminalContext } from '../../terminal/unified/turnOperations.js';
import type {
    ClaudeEffectiveModelEvidence,
    ClaudeEffectiveModelEvidenceSubscription,
} from '../../effectiveModelEvidence.js';
import type { ClaudeRemoteAdvancedOptions } from '../../../../protocol/remoteSettings.js';

export type ClaudeAgentSdkToolPermissionPolicy =
    | 'no_tools'
    | 'read_only'
    | 'workspace_write'
    | 'parent_session_prompt';

export type ClaudeAgentSdkContext = Readonly<{
    logger: ClaudeUnifiedTerminalContext['logger'];
    agentRuntime: Readonly<{
        exec: ClaudeSdkQueryContext;
        sessionHooks: ClaudeUnifiedTerminalContext['agentRuntime']['sessionHooks'];
        transcripts: Readonly<{
            fileFollow: ClaudeUnifiedTerminalContext['agentRuntime']['transcripts']['fileFollow'];
        }>;
        accountUsage: ClaudeUnifiedTerminalContext['agentRuntime']['accountUsage'];
    }>;
    sessions: ClaudeUnifiedTerminalContext['sessions'];
}>;

type ProviderEventMessage = ClaudeProviderEvent;
type ClaudeProviderFailureEvidence = Readonly<{
    code: string;
    source: ClaudeSessionRuntimeIssueSource;
    preview: string | null;
}>;
type ClaudeSubscriptionRuntimeAuthSelection =
    | Readonly<{
        kind: 'profile';
        serviceId: 'claude-subscription';
        profileId: string;
        credentialRevision: ConnectedServiceCredentialRevisionV1;
    }>
    | Readonly<{
        kind: 'group';
        serviceId: 'claude-subscription';
        groupId: string;
        activeProfileId: string;
        fallbackProfileId: string;
        generation: number;
        credentialRevision: ConnectedServiceCredentialRevisionV1;
        policy?: unknown;
    }>;

const readString = readClaudeRuntimeString;
const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
const CLAUDE_CONTEXT_USAGE_REFRESH_CONFIG_OPTION_ID = 'context_usage_refresh';
const CLAUDE_CONTEXT_USAGE_REFRESH_TIMEOUT_MS = 1_500;

function buildClaudeMcpConfigArgs(
    mcpServers: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
    if (!mcpServers || Object.keys(mcpServers).length === 0) return [];
    return ['--mcp-config', JSON.stringify({ mcpServers })];
}

function isSdkSystemMessage(message: SDKMessage): message is SDKSystemMessage {
    return message.type === 'system';
}

function isSdkAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
    return message.type === 'assistant'
        && typeof message.message === 'object'
        && message.message !== null
        && !Array.isArray(message.message);
}

function isSdkResultMessage(message: SDKMessage): message is SDKResultMessage {
    return message.type === 'result';
}

function readSdkAssistantModelId(message: SDKMessage): string | null {
    if (!isSdkAssistantMessage(message)) return null;
    return readString((message.message as Readonly<Record<string, unknown>>).model);
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

function readClaudeSubscriptionSelection(value: unknown): ClaudeSubscriptionRuntimeAuthSelection | null {
    if (!isRecord(value) || value.serviceId !== 'claude-subscription') return null;
    const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(value.credentialRevision);
    if (!credentialRevision.success) return null;
    if (value.kind === 'profile') {
        const profileId = readString(value.profileId);
        return profileId ? {
            kind: 'profile',
            serviceId: 'claude-subscription',
            profileId,
            credentialRevision: credentialRevision.data,
        } : null;
    }
    if (value.kind !== 'group') return null;
    const groupId = readString(value.groupId);
    const activeProfileId = readString(value.activeProfileId);
    const fallbackProfileId = readString(value.fallbackProfileId);
    const generation = readNonnegativeInteger(value.generation);
    if (!groupId || !activeProfileId || !fallbackProfileId || generation === null) return null;
    return {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId,
        activeProfileId,
        fallbackProfileId,
        generation,
        credentialRevision: credentialRevision.data,
        ...(Object.prototype.hasOwnProperty.call(value, 'policy') ? { policy: value.policy } : {}),
    };
}

function readClaudeSubscriptionSelectionFromEnv(
    env: Readonly<Record<string, string>> | null | undefined,
): ClaudeSubscriptionRuntimeAuthSelection | null {
    const raw = env?.[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
        const selection = readClaudeSubscriptionSelection(item);
        if (selection) return selection;
    }
    return null;
}

function readRefreshedAccessToken(value: unknown): string | null {
    if (!isRecord(value) || value.status !== 'refreshed' || !isRecord(value.result)) return null;
    return readString(value.result.accessToken);
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
}> {
    let resolvePromise: (() => void) | null = null;
    let rejectPromise: ((error: Error) => void) | null = null;
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
    };
}

type DeferredCompletion = ReturnType<typeof createDeferred>;

const PROVIDER_ERROR_PREVIEW_MAX_LENGTH = 800;

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

function readMessageId(message: SDKMessage, fallback: string): string {
    const record = message as Readonly<Record<string, unknown>>;
    return readString(record.uuid)
        ?? readString(record.id)
        ?? readString(record.request_id)
        ?? fallback;
}

function readProviderFailureEvidence(message: SDKMessage): ClaudeProviderFailureEvidence | null {
    if (!isSdkAssistantMessage(message)) return null;
    const record = message as Readonly<Record<string, unknown>>;
    const providerErrorCode = readString(record.error);
    const isApiErrorMessage = record.isApiErrorMessage === true;
    if (!providerErrorCode && !isApiErrorMessage) return null;
    const preview = sanitizeProviderErrorPreview(readAssistantText(message));
    const code = normalizeProviderErrorCode(providerErrorCode ?? 'provider_error');
    return {
        code,
        source: classifyFailureSource({ code, preview }),
        preview,
    };
}

function buildResultFailureEvidence(
    message: SDKResultMessage,
    providerFailure: ClaudeProviderFailureEvidence | null,
): ClaudeProviderFailureEvidence {
    const resultPreview = sanitizeProviderErrorPreview(message.result);
    const code = providerFailure?.code
        ?? normalizeProviderErrorCode(readString(message.subtype) ?? 'result_error');
    const preview = providerFailure?.preview ?? resultPreview;
    return {
        code,
        source: providerFailure?.source ?? classifyFailureSource({ code, preview }),
        preview,
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

function readRuntimeConfigString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'default') return null;
    return trimmed;
}

const readEffortFromRuntimeConfigUpdate = readClaudeRuntimeConfigEffortUpdate;
const readUltracodeFromRuntimeConfigUpdate = readClaudeRuntimeConfigUltracodeUpdate;

function resolvePromptInput(
    prompt: string,
    _policy: ClaudeAgentSdkToolPermissionPolicy | null,
): AsyncIterable<SDKUserMessage> {
    return createPromptStream(prompt);
}

async function* createPromptStream(prompt: string): AsyncIterable<SDKUserMessage> {
    yield {
        type: 'user',
        message: {
            role: 'user',
            content: prompt,
        },
    };
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

function mapSdkRuntimeEvent(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    turnId: string;
    providerFailure?: ClaudeProviderFailureEvidence | null;
}>): ProviderEventMessage | null {
    if (params.message.type === 'assistant') {
        return ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'message-delta',
            turnId: params.turnId,
            delta: {
                agentId: 'claude',
                message: params.message,
            },
        });
    }
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
            }),
        });
    }
    return readClaudeProviderEvent(params.message);
}

function mapSdkTranscriptEvent(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    sequence: number;
}>): ProviderEventMessage | null {
    if (!isSdkAssistantMessage(params.message)) return null;
    const text = readAssistantText(params.message);
    if (!text) return null;
    return ClaudeProviderEventSchema.parse({
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'transcript-agent-message-committed',
        agentId: 'claude',
        localId: `claude-sdk-${readMessageId(params.message, `assistant-${params.sequence}`)}`,
        body: {
            type: 'message',
            message: text,
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
}>): ProviderEventMessage | null {
    const text = readString(params.message.result);
    if (!text) return null;
    return ClaudeProviderEventSchema.parse({
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        kind: 'transcript-agent-message-committed',
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
    const providerSessionId = readString(params.message.session_id);
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

function mapSdkToolRuntimeEvents(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    turnId: string;
    toolNameByCallId: Map<string, string>;
}>): ProviderEventMessage[] {
    const events: ProviderEventMessage[] = [];
    for (const block of extractToolUseBlocksFromSdkMessage(params.message)) {
        params.toolNameByCallId.set(block.id, block.name);
        events.push(ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'tool-call',
            turnId: params.turnId,
            toolCallId: block.id,
            toolName: block.name,
            toolInput: block.input,
        }));
    }
    for (const block of extractToolResultBlocksFromSdkMessage(params.message)) {
        const toolName = params.toolNameByCallId.get(block.toolUseId);
        events.push(ClaudeProviderEventSchema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'tool-result',
            turnId: params.turnId,
            toolCallId: block.toolUseId,
            output: block.output,
            ...(block.isError === undefined ? {} : { isError: block.isError }),
            ...(toolName ? { toolName } : {}),
        }));
    }
    return events;
}

export type ClaudeAgentSdkTurnOperationsParams = Readonly<{
    ctx: ClaudeAgentSdkContext;
    queryContext?: ClaudeSdkQueryContext;
    permissionEngine?: ClaudePermissionEngine;
    directory: string;
    launchEnv: Readonly<Record<string, string>>;
    advancedOptions?: ClaudeRemoteAdvancedOptions;
    permissionMode: string;
    happierSessionId?: string | null;
    toolPermissionPolicy?: ClaudeAgentSdkToolPermissionPolicy | null;
    abortSignal?: AbortSignal;
    initialModelId?: string | null;
    supportsEffort?: boolean;
    initialEffort?: string | null;
    initialUltracode?: boolean;
    providerModel?: AgentSessionProviderBinding['model'];
    initialProviderSessionId?: string | null;
    mcpServers?: Readonly<Record<string, unknown>> | null;
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
    publishGoalWorkState?: (snapshot: SessionWorkStateV1) => void;
}>;

export type ClaudeAgentSdkNativeOperations = ClaudeRuntimeTurnOperations & Readonly<{
    subscribeCanonicalAgentSessionEvents: ReturnType<typeof createClaudeRuntimeActivityPublisher>['subscribe'];
    subscribeEffectiveModel: ClaudeEffectiveModelEvidenceSubscription;
    subscribeUsageObservation: ClaudeUsageObservationSubscription;
    setOnPromptDeliveryOutcome(handler: ClaudeProviderPromptDeliveryOutcomeCallback | null): void;
}>;

export function createClaudeAgentSdkTurnOperations(
    params: ClaudeAgentSdkTurnOperationsParams,
): ClaudeAgentSdkNativeOperations {
    const permissionEngine = params.permissionEngine ?? createClaudePermissionEngine(params.ctx);
    const listeners = new Set<(event: ClaudeProviderEvent) => void>();
    const effectiveModelListeners = new Set<(evidence: ClaudeEffectiveModelEvidence) => void>();
    const usageObservationListeners = new Set<(observation: ClaudeUsageObservation) => void>();
    let providerSessionId: string | null = null;
    let resumableProviderSessionId: string | null = null;
    let pendingResumeProviderSessionId: string | null = readString(params.initialProviderSessionId);
    let activeQuery: ClaudeSdkQuery | null = null;
    let disposeQuery: ClaudeSdkQuery | null = null;
    let activeProviderTaskId: string | null = null;
    const cancelledQueries = new WeakMap<ClaudeSdkQuery, string>();
    let activeCompletion: DeferredCompletion | null = null;
    let lastTurnCompletionFailure: Error | null = null;
    const backgroundQueries = new Set<ClaudeSdkQuery>();
    let turnInFlight = false;
    let turnSequence = 0;
    let currentTurnId: string | null = null;
    let currentPermissionMode = params.permissionMode;
    let currentModelId: string | null = readString(params.initialModelId);
    let currentProviderModel = params.providerModel;
    let currentFallbackModel: string | null = null;
    const supportsEffort = params.supportsEffort !== false;
    let currentEffort: string | null = supportsEffort ? readString(params.initialEffort) : null;
    let currentUltracode = supportsEffort && params.initialUltracode === true;
    let contextUsageRefreshPromise: Promise<boolean> | null = null;
    const toolPermissionPolicy = params.toolPermissionPolicy ?? null;
    const sessionWorkStateEnabled = params.enableSessionWorkState === true;
    const happierSessionId = readString(params.happierSessionId);
    let promotedTranscriptPath: string | null = null;
    let sessionHookServer: AgentSessionHookServerHandle | null = null;
    let sessionHookPluginDir: string | null = null;
    let sessionHookSetupPromise: Promise<string | null> | null = null;
    let runtimeDisposed = false;
    let runtimeDisposePromise: Promise<void> | null = null;
    const providerActivityLedger = createClaudeProviderActivityLedger();
    const runtimeActivityPublisher = createClaudeRuntimeActivityPublisher({
        sessionId: happierSessionId ?? 'claude-agent-sdk',
    });
    // Centralized Dynamic Workflow ACTIVITY runtime (mirrors the unified runner). Turns the
    // `Workflow`/`Task`/`task_*`/`workflow_progress` events on the live SDK stream into durable
    // `activity/workflow_run.v1` records (record-FIRST via the host `writeSystemRecord` capability,
    // with the same absent-capability guard) plus the compact headline (via `writeMetadata`).
    const workflowRuntime = sessionWorkStateEnabled
        ? createClaudeUnifiedWorkflowRuntime({
            backendId: 'claude',
            agentId: 'claude',
            getCurrentClaudeSessionId: () => providerSessionId,
            writeSystemRecord: async (request) => {
                const writeSystemRecordFn = params.ctx.sessions.current.writeSystemRecord;
                if (!writeSystemRecordFn) {
                    throw new Error('host session does not support durable system records');
                }
                await writeSystemRecordFn(request);
            },
            ...(params.ctx.sessions.current.readSystemRecord
                ? {
                    readSystemRecord: async (request) => {
                        const readSystemRecordFn = params.ctx.sessions.current.readSystemRecord;
                        return readSystemRecordFn ? await readSystemRecordFn(request) : null;
                    },
                }
                : {}),
            writeMetadata: async (request) => { await params.ctx.sessions.current.writeMetadata(request); },
            fileFollow: params.ctx.agentRuntime.transcripts.fileFollow,
            onProviderTaskActivity: (activity) => {
                applyProviderTaskActivity(activity);
                if (activity.type === 'terminal' && activeProviderTaskId === activity.taskId) {
                    const remaining = providerActivityLedger.getActiveProviderTasks();
                    activeProviderTaskId = remaining.length > 0
                        ? remaining[remaining.length - 1]!.taskId
                        : null;
                }
            },
            logError: (message, error) => { params.ctx.logger.debug(`[ClaudeAgentSdk] ${message}`, { error }); },
        })
        : null;
    // CWF4: expose workflow-owned subagent tool-use ids to the (stateless) task work-state derivation,
    // keyed by the Happier session id, so a canonical Workflow run's agents do not ALSO render as
    // top-level task/todo rows.
    const disposeWorkflowOwnedToolUseIdsRegistration = workflowRuntime
        ? registerClaudeWorkflowOwnedToolUseIds(
            happierSessionId ?? 'claude-agent-sdk',
            () => workflowRuntime.getWorkflowOwnedAgentToolUseIds(),
        )
        : null;
    // Centralized native `/goal` runtime. The SOURCE observes the live SDK stream (system-init
    // `slash_commands` => `/goal` capability) AND the file-only `goal_status` attachments via the
    // narrow JSONL tail below; the effector injects a literal `/goal …` user turn.
    const goalRuntime = sessionWorkStateEnabled
        ? createClaudeUnifiedGoalRuntime({
            backendId: 'claude',
            agentId: 'claude',
            getCurrentClaudeSessionId: () => providerSessionId,
            ...(params.publishGoalWorkState
                ? { publishWorkStateSnapshot: params.publishGoalWorkState }
                : { writeMetadataUpdate: async (request) => { await params.ctx.sessions.current.writeMetadata(request); } }),
            injectGoalCommand: async (message) => { await operations.sendProviderTurnPrompt(message); },
            logError: (message, error) => { params.ctx.logger.debug(`[ClaudeAgentSdk] ${message}`, { error }); },
        })
        : null;
    let goalStatusTail: ClaudeAgentSdkGoalStatusTail | null = null;
    const retiringGoalStatusTails = new Set<Promise<void>>();
    let lastEffectiveModelEvidenceKey: string | null = null;

    function publishEffectiveModel(evidence: ClaudeEffectiveModelEvidence): void {
        const modelId = readString(evidence.modelId);
        if (!modelId) return;
        const contextWindowTokens = readNonnegativeInteger(evidence.contextWindowTokens);
        const key = `${modelId}|${contextWindowTokens ?? ''}`;
        if (key === lastEffectiveModelEvidenceKey) return;
        lastEffectiveModelEvidenceKey = key;
        const published = Object.freeze({
            modelId,
            ...(contextWindowTokens && contextWindowTokens > 0 ? { contextWindowTokens } : {}),
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
    // attachments (not present on the live SDK stream). The path is admitted only after the
    // authenticated SessionStart candidate has exact accepted-prompt materialization proof.
    function ensureGoalStatusTail(): void {
        if (!goalRuntime || goalStatusTail) return;
        const transcriptPath = promotedTranscriptPath ?? (
            params.enableSessionResumability !== true && providerSessionId
                ? join(
                    getClaudeProjectPath(
                        params.directory,
                        resolveClaudeConfigDirOverride({ ...params.launchEnv }),
                    ),
                    `${providerSessionId}.jsonl`,
                )
                : null
        );
        if (!transcriptPath) return;
        const goalSource = goalRuntime.source;
        goalStatusTail = createClaudeAgentSdkGoalStatusTail({
            ctx: params.ctx,
            transcriptPath,
            observeGoalStatusRow: (row) => goalSource.observeTranscriptMessage(row),
        });
    }

    const resumeIdentityOwner = params.enableSessionResumability === true && happierSessionId
        ? createClaudeAgentSdkResumeIdentityOwner({
            ctx: params.ctx,
            onProviderSessionId: observeProviderSessionId,
            onTranscriptCandidateActivated: ({ transcriptPath }) => {
                if (promotedTranscriptPath === null || promotedTranscriptPath === transcriptPath) return;
                resumableProviderSessionId = null;
                pendingResumeProviderSessionId = null;
                clearPromotedTranscriptForRekey();
            },
            onTranscriptPromoted: async ({ providerSessionId: provenProviderSessionId, transcriptPath, isCurrent }) => {
                if (!isCurrent() || providerSessionId !== provenProviderSessionId) return;
                if (!isCurrent() || providerSessionId !== provenProviderSessionId) return;
                resumableProviderSessionId = provenProviderSessionId;
                pendingResumeProviderSessionId = null;
                if (promotedTranscriptPath !== transcriptPath) {
                    const previousGoalStatusTail = goalStatusTail;
                    goalStatusTail = null;
                    if (previousGoalStatusTail) {
                        await retireGoalStatusTail(previousGoalStatusTail);
                    }
                }
                if (!isCurrent() || providerSessionId !== provenProviderSessionId) return;
                promotedTranscriptPath = transcriptPath;
                ensureGoalStatusTail();
            },
        })
        : null;

    async function ensureSessionHookPluginDir(): Promise<string | null> {
        if (!happierSessionId) return null;
        if (sessionHookPluginDir) return sessionHookPluginDir;
        if (sessionHookSetupPromise) return await sessionHookSetupPromise;

        sessionHookSetupPromise = (async () => {
            const sessionHookSecret = randomUUID();
            const server = await params.ctx.agentRuntime.sessionHooks.startServer({
                providerId: 'claude',
                sessionId: happierSessionId,
                lifecycle: { kind: 'session', sessionId: happierSessionId },
                sessionHookSecret,
                onSessionHook: async (providerSessionId, payload) => {
                    observeProviderTaskActivity(payload, providerSessionId);
                    await resumeIdentityOwner?.observeSessionHook(providerSessionId, payload);
                },
            });
            sessionHookServer = server;
            try {
                const assets = await params.ctx.agentRuntime.sessionHooks.resolveForwarderAssets();
                const hooks = buildClaudeHookPluginHooks({
                    port: server.port,
                    nodeExecutable: assets.nodeExecutable,
                    sessionForwarderScript: assets.sessionForwarderScript,
                    ...(server.sessionHookSecretFile
                        ? { sessionHookSecretFile: server.sessionHookSecretFile }
                        : {}),
                });
                const manifest = buildClaudeHookPluginManifest({ instanceId: happierSessionId });
                sessionHookPluginDir = await params.ctx.agentRuntime.sessionHooks.createPluginDir({
                    providerId: 'claude',
                    lifecycle: { kind: 'session', sessionId: happierSessionId },
                    files: [
                        { path: '.claude-plugin/plugin.json', json: manifest },
                        { path: 'hooks/hooks.json', json: hooks },
                    ],
                });
                return sessionHookPluginDir;
            } catch (error) {
                sessionHookServer = null;
                await server.dispose().catch(() => undefined);
                throw error;
            }
        })().finally(() => {
            sessionHookSetupPromise = null;
        });
        return await sessionHookSetupPromise;
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

    async function requestAndPublishContextUsage(turnQuery: ClaudeSdkQuery): Promise<boolean> {
        if (contextUsageRefreshPromise) return await contextUsageRefreshPromise;
        contextUsageRefreshPromise = (async () => {
            const response = await withTimeout(
                turnQuery.getContextUsage(),
                CLAUDE_CONTEXT_USAGE_REFRESH_TIMEOUT_MS,
            );
            const snapshot = buildClaudeLiveContextUsageSnapshot({
                response,
                observedAtMs: Date.now(),
            });
            if (!snapshot) return false;
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
            return true;
        })().finally(() => {
            contextUsageRefreshPromise = null;
        });
        return await contextUsageRefreshPromise;
    }

    async function requestContextUsageOnDemand(): Promise<boolean> {
        const reusableQuery = activeQuery;
        if (reusableQuery) return await requestAndPublishContextUsage(reusableQuery);
        const contextUsageProviderSessionId = params.enableSessionResumability === true
            ? resumableProviderSessionId ?? pendingResumeProviderSessionId
            : providerSessionId;
        if (!contextUsageProviderSessionId) return false;

        const hookPluginDir = await ensureSessionHookPluginDir();
        const idleController = new AbortController();
        const transientQuery = queryWithContext(params.queryContext ?? params.ctx.agentRuntime.exec, {
            prompt: createIdlePromptStream(idleController.signal),
            options: {
                cwd: params.directory,
                env: params.launchEnv,
                abort: params.abortSignal,
                resume: contextUsageProviderSessionId,
                ...(currentModelId ? { model: currentModelId } : {}),
                extraArgs: [
                    ...(hookPluginDir ? ['--plugin-dir', hookPluginDir, '--include-hook-events'] : []),
                    ...buildClaudeMcpConfigArgs(params.mcpServers),
                ],
                ...params.advancedOptions,
            },
        });
        try {
            return await requestAndPublishContextUsage(transientQuery);
        } finally {
            idleController.abort();
            await transientQuery.dispose().catch(() => undefined);
        }
    }

    function applyProviderTaskActivity(activity: ClaudeProviderTaskActivity): void {
        applyClaudeProviderTaskActivity({
            activity,
            ledger: providerActivityLedger,
            runtimeActivityPublisher,
            logger: params.ctx.logger,
            logPrefix: '[ClaudeAgentSdk]',
        });
    }

    function observeProviderTaskActivity(message: unknown, contextualSessionId?: string): boolean {
        const event = normalizeClaudeProviderTaskEvent(
            message,
            contextualSessionId ?? providerSessionId ?? undefined,
        );
        let didObserveActivity = false;
        if (event.activity) {
            didObserveActivity = true;
            applyProviderTaskActivity(event.activity);
        }

        if (event.interruptTarget?.type === 'active') {
            activeProviderTaskId = event.interruptTarget.taskId;
        } else if (
            event.interruptTarget?.type === 'terminal'
            && activeProviderTaskId === event.interruptTarget.taskId
        ) {
            const remaining = providerActivityLedger.getActiveProviderTasks();
            activeProviderTaskId = remaining.length > 0
                ? remaining[remaining.length - 1]!.taskId
                : null;
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

    type SuccessfulTurn = Readonly<{
        completion: DeferredCompletion;
        message: SDKResultMessage;
        messageSequence: number;
        providerFailure: ClaudeProviderFailureEvidence | null;
        publishedTranscriptText: boolean;
        turnQuery: ClaudeSdkQuery;
    }>;

    function completeSuccessfulTurn(
        turn: SuccessfulTurn,
        publishTerminal: (event: ClaudeProviderEvent) => void,
    ): void {
        if (activeQuery === turn.turnQuery) activeQuery = null;
        if (activeCompletion === turn.completion) {
            activeCompletion = null;
            turnInFlight = false;
        }

        if (params.publishTranscriptMessages === true) {
            publishRuntimeEvent(mapSdkResultUsageTranscriptEvent({
                message: turn.message,
                sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                sequence: turn.messageSequence,
                modelId: currentModelId,
            }));
        }
        publishUsageObservation(buildClaudeSdkResultUsageObservation({
            modelId: currentModelId ?? currentProviderModel?.id ?? 'unknown',
            ...(currentProviderModel ? { modelSource: 'provider' } : {}),
            result: turn.message,
        }));
        if (params.publishTranscriptMessages === true && !turn.publishedTranscriptText) {
            const resultTranscriptEvent = mapResultTranscriptEvent({
                message: turn.message,
                sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                sequence: turn.messageSequence,
            });
            if (resultTranscriptEvent) publishRuntimeEvent(resultTranscriptEvent);
        }
        publishTerminal(mapSdkRuntimeEvent({
            message: turn.message,
            sessionId: readRuntimeEventSessionId(),
            turnId: currentTurnId ?? 'claude-agent-sdk-turn',
            providerFailure: turn.providerFailure,
        })!);
        reconcileProviderTaskRuntimeActivityForCurrentQuery('foreground-result');
        turn.completion.resolve();
    }

    function completeProviderBackgroundObservation(turnQuery: ClaudeSdkQuery): void {
        backgroundQueries.delete(turnQuery);
        if (backgroundQueries.size === 0) {
            reconcileProviderTaskRuntimeActivityForCurrentQuery('background-observation-complete');
        }
    }

    function publishProviderSessionId(nextSessionId: string): void {
        publishRuntimeEvent(ClaudeProviderEventSchema.parse({
            sessionId: readString(params.happierSessionId) ?? nextSessionId,
            emittedAtMs: Date.now(),
            kind: 'session-id-publish',
            publishedSessionId: nextSessionId,
            source: 'claude-agent-sdk',
        }));
    }

    function clearPromotedTranscriptForRekey(): void {
        const previousTranscriptPath = promotedTranscriptPath;
        if (!previousTranscriptPath) return;
        promotedTranscriptPath = null;
        const previousGoalStatusTail = goalStatusTail;
        goalStatusTail = null;
        if (previousGoalStatusTail) void retireGoalStatusTail(previousGoalStatusTail);
    }

    function observeProviderSessionId(value: unknown): void {
        const nextSessionId = readString(value);
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
        options: { signal: AbortSignal },
    ): Promise<PermissionResult> {
        if (toolPermissionPolicy === 'no_tools') {
            return { behavior: 'deny', message: 'Tools are disabled for this execution run.', interrupt: true };
        }
        if (toolPermissionPolicy === 'workspace_write') {
            return {
                behavior: 'allow',
                updatedInput: input && typeof input === 'object' && !Array.isArray(input)
                    ? input as Record<string, unknown>
                    : {},
            };
        }
        return permissionEngine.canCallTool(toolName, input, options);
    }

    const claudeSubscriptionRuntimeAuthSelection = readClaudeSubscriptionSelectionFromEnv(params.launchEnv);
    const refreshRuntimeAuth = params.ctx.sessions.current.auth?.services?.refreshRuntimeAuth;
    let lastClaudeSdkOAuthTokenFingerprint: string | null = null;
    let pendingClaudeSdkOAuthRefreshAttempt: Readonly<{
        expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
        refreshAttemptId: string;
    }> | null = null;
    const getClaudeSdkOAuthToken = (
        claudeSubscriptionRuntimeAuthSelection && typeof refreshRuntimeAuth === 'function'
    )
        ? async (options: { signal: AbortSignal }): Promise<string | null> => {
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
                env: params.launchEnv,
                selection: claudeSubscriptionRuntimeAuthSelection,
                expectedCredentialRevision,
                reason: 'claude_agent_sdk_oauth_token_refresh',
                failingAccessTokenFingerprint: lastClaudeSdkOAuthTokenFingerprint,
            };
            const result = await refreshRuntimeAuth(refreshRequest, { signal: options.signal });
            const accessToken = readRefreshedAccessToken(result);
            if (accessToken) {
                pendingClaudeSdkOAuthRefreshAttempt = null;
                lastClaudeSdkOAuthTokenFingerprint = computeClaudeSubscriptionAccessTokenFingerprint(accessToken);
            }
            return accessToken;
        }
        : null;

    async function consumeTurnMessages(turnQuery: ClaudeSdkQuery, completion: DeferredCompletion): Promise<void> {
        let sawResult = false;
        let terminalPublished = false;
        let messageSequence = 0;
        let publishedTranscriptText = false;
        let providerFailure: ClaudeProviderFailureEvidence | null = null;
        let foregroundCompleted = false;
        const toolNameByCallId = new Map<string, string>();
        const publishTerminal = (event: ClaudeProviderEvent): void => {
            if (terminalPublished) return;
            terminalPublished = true;
            publishRuntimeEvent(event);
        };
        const publishFailedTerminal = (
            error: Error,
            source: ClaudeSessionRuntimeIssueSource,
            code: string,
        ): void => {
            publishTerminal(ClaudeProviderEventSchema.parse({
                sessionId: readRuntimeEventSessionId(),
                emittedAtMs: Date.now(),
                kind: 'turn-failed',
                turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                issue: buildClaudeSessionRuntimeIssue({
                    code,
                    source,
                    occurredAt: Date.now(),
                    agentId: 'claude',
                    sanitizedPreview: sanitizeProviderErrorPreview(error.message),
                }),
            }));
        };
        const publishCancelledTerminal = (reason: string): void => {
            publishTerminal(ClaudeProviderEventSchema.parse({
                sessionId: readRuntimeEventSessionId(),
                emittedAtMs: Date.now(),
                kind: 'turn-cancelled',
                turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                reason,
            }));
        };
        try {
            for await (const message of turnQuery) {
                messageSequence += 1;
                const assistantModelId = readSdkAssistantModelId(message);
                if (assistantModelId) publishEffectiveModel({ modelId: assistantModelId });
                if (isClaudeProviderActivityHookObservationLoss(message, providerSessionId)) {
                    providerActivityLedger.noteObservationLost();
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('hook-response-observation-lost');
                }
                if (
                    params.enableSessionResumability !== true
                    && isSdkSystemMessage(message)
                    && message.subtype !== 'hook_response'
                ) {
                    observeProviderSessionId(message.session_id);
                }
                if (params.enableSessionResumability !== true && isSdkResultMessage(message)) {
                    observeProviderSessionId(message.session_id);
                }
                const nextProviderFailure = readProviderFailureEvidence(message);
                if (nextProviderFailure) {
                    providerFailure = nextProviderFailure;
                }
                observeSessionWorkStateMessage(message);
                if (
                    observeProviderTaskActivity(message)
                    && sawResult
                    && !providerActivityLedger.hasActiveProviderTasks()
                ) {
                    completeProviderBackgroundObservation(turnQuery);
                    return;
                }
                const isSuccessfulResultMessage = isSdkResultMessage(message)
                    && message.subtype === 'success'
                    && message.is_error !== true;
                if (params.publishSdkMessages === true && !isSdkResultMessage(message)) {
                    const runtimeEvent = mapSdkRuntimeEvent({
                        message,
                        sessionId: providerSessionId ?? readString(params.happierSessionId) ?? 'claude-agent-sdk',
                        turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                        providerFailure,
                    });
                    publishRuntimeEvent(runtimeEvent);
                }
                if (params.publishTranscriptMessages === true && isSdkAssistantMessage(message)) {
                    const transcriptEvent = mapSdkTranscriptEvent({
                        message,
                        sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                        sequence: messageSequence,
                    });
                    if (transcriptEvent) {
                        publishedTranscriptText = true;
                        publishRuntimeEvent(transcriptEvent);
                    }
                }
                if (isSdkAssistantMessage(message)) {
                    const usage = readSdkAssistantUsage(message);
                    publishUsageObservation(buildClaudeAssistantUsageObservation({
                        modelId: currentModelId,
                        ...(currentProviderModel ? { modelSource: 'provider' } : {}),
                        usage: usage ?? {},
                    }));
                }
                if (params.publishSdkMessages === true || params.publishTranscriptMessages === true) {
                    for (const runtimeEvent of mapSdkToolRuntimeEvents({
                        message,
                        sessionId: readRuntimeEventSessionId(),
                        turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                        toolNameByCallId,
                    })) {
                        publishRuntimeEvent(runtimeEvent);
                    }
                }
                if (!isSdkResultMessage(message)) continue;
                const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : null;
                if (modelUsage) {
                    const modelIds = Object.keys(modelUsage)
                        .map(readString)
                        .filter((value): value is string => value !== null);
                    const effectiveModelId = currentModelId && modelIds.includes(currentModelId)
                        ? currentModelId
                        : modelIds.length === 1 ? modelIds[0]! : null;
                    if (effectiveModelId) {
                        const usage = isRecord(modelUsage[effectiveModelId]) ? modelUsage[effectiveModelId] : null;
                        publishEffectiveModel({
                            modelId: effectiveModelId,
                            contextWindowTokens: readNonnegativeInteger(usage?.contextWindow),
                        });
                    }
                }
                sawResult = true;
                // Drain any pending workflow activity at turn end so durable records + headline
                // land promptly (best-effort; a publish failure must not affect turn completion).
                if (workflowRuntime) void workflowRuntime.flush().catch(() => undefined);
                if (message.subtype === 'success' && message.is_error !== true) {
                    const successfulTurn = {
                        completion,
                        message,
                        messageSequence,
                        providerFailure,
                        publishedTranscriptText,
                        turnQuery,
                    };
                    const shouldContinueForBackgroundTasks = providerActivityLedger.hasActiveProviderTasks();
                    const turnEndContextUsageRefresh = params.publishTranscriptMessages === true
                        ? requestAndPublishContextUsage(turnQuery).catch((error: unknown) => {
                            params.ctx.logger.debug(
                                '[ClaudeAgentSdk] Turn-end context usage refresh failed (non-fatal)',
                                { error },
                            );
                            return false;
                        })
                        : null;
                    completeSuccessfulTurn(successfulTurn, publishTerminal);
                    foregroundCompleted = true;
                    if (shouldContinueForBackgroundTasks) {
                        backgroundQueries.add(turnQuery);
                        continue;
                    }
                    // Returning from a `for await` loop calls the iterator's return(), which
                    // disposes the SDK query. Keep the control channel alive until the turn-end
                    // context request settles, without delaying the already-resolved turn.
                    await turnEndContextUsageRefresh;
                } else {
                    if (activeQuery === turnQuery) activeQuery = null;
                    if (activeCompletion === completion) {
                        activeCompletion = null;
                        turnInFlight = false;
                    }
                    reconcileProviderTaskRuntimeActivityForCurrentQuery('result-error');
                    publishTerminal(mapSdkRuntimeEvent({
                        message,
                        sessionId: readRuntimeEventSessionId(),
                        turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                        providerFailure,
                    })!);
                    const resultError = createResultError(message, providerFailure);
                    lastTurnCompletionFailure = resultError;
                    completion.reject(resultError);
                }
                return;
            }
            if (!sawResult || providerActivityLedger.hasActiveProviderTasks()) {
                providerActivityLedger.noteObservationLost();
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
            providerActivityLedger.noteObservationLost();
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
            if (activeQuery === turnQuery) activeQuery = null;
            if (activeCompletion === completion) {
                activeCompletion = null;
                turnInFlight = false;
            }
        }
    }

    let onPromptDeliveryOutcome: ClaudeProviderPromptDeliveryOutcomeCallback | null = null;
    const operations: ClaudeRuntimeTurnOperations & Readonly<{
        subscribeCanonicalAgentSessionEvents: typeof runtimeActivityPublisher.subscribe;
        subscribeEffectiveModel: ClaudeEffectiveModelEvidenceSubscription;
        subscribeUsageObservation: ClaudeUsageObservationSubscription;
        setOnPromptDeliveryOutcome(handler: ClaudeProviderPromptDeliveryOutcomeCallback | null): void;
    }> = {
        subscribeCanonicalAgentSessionEvents: runtimeActivityPublisher.subscribe,
        subscribeEffectiveModel(listener) {
            effectiveModelListeners.add(listener);
            return () => effectiveModelListeners.delete(listener);
        },
        subscribeUsageObservation(listener) {
            usageObservationListeners.add(listener);
            return () => usageObservationListeners.delete(listener);
        },
        beginProviderTurn() {
            turnSequence += 1;
            currentTurnId = `claude-agent-sdk-turn-${turnSequence}`;
        },
        async startProviderSession(opts) {
            const requestedResumeId = readString(opts?.resumeId);
            if (requestedResumeId && providerSessionId === null) pendingResumeProviderSessionId = requestedResumeId;
            return providerSessionId;
        },
        async sendProviderTurnPrompt(prompt, meta) {
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
            try {
                lastTurnCompletionFailure = null;
                reconcileProviderTaskRuntimeActivityForCurrentQuery('new-turn');
                const completion = createDeferred();
                completion.promise.catch(() => undefined);
                const hookPluginDir = await ensureSessionHookPluginDir();
                if (runtimeDisposed) {
                    throw new Error('Claude Agent SDK runtime is disposed.');
                }
                await resumeIdentityOwner?.settleCurrentCandidate();
                if (runtimeDisposed) {
                    throw new Error('Claude Agent SDK runtime is disposed.');
                }
                resumeIdentityOwner?.recordSubmittedPrompt(prompt);
                const resumeProviderSessionId = params.enableSessionResumability === true
                    ? resumableProviderSessionId ?? pendingResumeProviderSessionId
                    : providerSessionId ?? pendingResumeProviderSessionId;
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
                            delivery: { kind: 'newTurn', turnId: currentTurnId ?? 'claude-agent-sdk-turn' },
                        });
                    } else if (outcome.kind === 'rejected_before_effect') {
                        const message = sanitizeProviderErrorPreview(outcome.reason);
                        onPromptDeliveryOutcome?.({
                            type: 'input-rejected',
                            ...identity,
                            diagnostic: {
                                code: 'claude_sdk_prompt_rejected_before_transport',
                                severity: 'error',
                                ...(message ? { message } : {}),
                            },
                            retryable: true,
                        });
                    } else if (outcome.kind === 'effect_may_have_occurred') {
                        const message = sanitizeProviderErrorPreview(outcome.reason);
                        onPromptDeliveryOutcome?.({
                            type: 'input-custody-unknown',
                            ...identity,
                            issue: {
                                code: 'claude_sdk_prompt_transport_ambiguous',
                                severity: 'error',
                                ...(message ? { message } : {}),
                            },
                        });
                    }
                };
                const turnQuery = queryWithContext(params.queryContext ?? params.ctx.agentRuntime.exec, {
                    prompt: resolvePromptInput(prompt, toolPermissionPolicy),
                    options: {
                        cwd: params.directory,
                        env: params.launchEnv,
                        abort: params.abortSignal,
                        ...(toolPermissionPolicy
                            ? {}
                            : {
                                permissionMode: resolveClaudePermissionModeFromRuntimeMode({
                                    permissionMode: currentPermissionMode,
                                }),
                            }),
                        ...(currentModelId ? { model: currentModelId } : {}),
                        ...(currentFallbackModel ? { fallbackModel: currentFallbackModel } : {}),
                        ...(currentEffort ? { effort: currentEffort } : {}),
                        ...(resumeProviderSessionId ? { resume: resumeProviderSessionId } : {}),
                        extraArgs: [
                            ...(hookPluginDir ? ['--plugin-dir', hookPluginDir, '--include-hook-events'] : []),
                            ...buildClaudeMcpConfigArgs(params.mcpServers),
                        ],
                        // Ultracode rides the single inline --settings overlay; an unhonorable
                        // request resolves to OFF (gate = xhigh capability, [1m]-tolerant).
                        ...(currentUltracode && isClaudeUltracodeSupportedModelId(currentModelId, currentProviderModel)
                            ? { settingsJson: JSON.stringify({ ultracode: true }) }
                            : {}),
                        ...(toolPermissionPolicy === 'read_only'
                            ? {}
                            : { canCallTool: resolvePermission }),
                        ...(getClaudeSdkOAuthToken ? { getOAuthToken: getClaudeSdkOAuthToken } : {}),
                        ...params.advancedOptions,
                    },
                    onMessageReceived(message) {
                        void recordClaudeRuntimeProviderAccountUsageSnapshot({
                            ctx: params.ctx,
                            evidence: message,
                            sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                            launchEnv: params.launchEnv,
                        });
                    },
                });
                activeCompletion = completion;
                activeQuery = turnQuery;
                disposeQuery = turnQuery;
                void consumeTurnMessages(turnQuery, completion);
                const transportOutcome = await turnQuery.promptTransportOutcome;
                const outcome: ClaudeRuntimePromptSubmissionOutcome = transportOutcome.kind === 'accepted'
                    ? transportOutcome
                    : {
                        kind: transportOutcome.kind,
                        reason: sanitizeProviderErrorPreview(transportOutcome.error.message)
                            ?? 'Claude SDK prompt transport failed.',
                    };
                publishTransportOutcome(outcome);
                return outcome;
            } catch (error) {
                turnInFlight = false;
                const outcome: ClaudeRuntimePromptSubmissionOutcome = {
                    kind: 'rejected_before_effect',
                    reason: sanitizeProviderErrorPreview(
                        error instanceof Error ? error.message : String(error),
                    ) ?? 'Claude SDK prompt setup failed.',
                };
                return outcome;
            }
        },
        async steerProviderTurn(message, meta) {
            return await operations.sendProviderTurnPrompt(message, meta);
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
            return respondToClaudePermission({ ctx: params.ctx, provider: 'claude', requestId, approved });
        },
        async cancelProviderTurn() {
            const turnQuery = activeQuery
                ?? (activeProviderTaskId
                    ? Array.from(backgroundQueries).at(-1) ?? disposeQuery
                    : null);
            if (!turnQuery) return;
            cancelledQueries.set(turnQuery, 'user_request');
            const providerTaskId = activeProviderTaskId;
            if (providerTaskId) {
                try {
                    await turnQuery.stopTask(providerTaskId);
                    if (activeProviderTaskId === providerTaskId) activeProviderTaskId = null;
                    if (activeQuery === turnQuery) activeQuery = null;
                    backgroundQueries.delete(turnQuery);
                    await turnQuery.dispose();
                    return;
                } catch (error) {
                    params.ctx.logger.debug(
                        '[ClaudeAgentSdk] Targeted provider task cancellation failed; interrupting query',
                        { error },
                    );
                }
            }
            await turnQuery.interrupt();
            if (activeQuery === turnQuery) activeQuery = null;
            backgroundQueries.delete(turnQuery);
            await turnQuery.dispose();
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
            const permissionMode = readRuntimeConfigString(update.permissionMode);
            if (permissionMode) {
                currentPermissionMode = permissionMode;
            }

            const modelId = readRuntimeConfigString(update.modelId);
            if (modelId) {
                currentModelId = modelId;
            } else if (update.modelId === null) {
                currentModelId = null;
            }

            const fallbackModel = readRuntimeConfigString(update.fallbackModel);
            if (fallbackModel) {
                currentFallbackModel = fallbackModel;
            } else if (update.fallbackModel === null) {
                currentFallbackModel = null;
            }

            const effort = readEffortFromRuntimeConfigUpdate(update);
            if (effort) {
                currentEffort = effort;
            } else if (effort === null) {
                currentEffort = null;
            }

            const ultracode = readUltracodeFromRuntimeConfigUpdate(update);
            if (ultracode !== undefined) {
                currentUltracode = ultracode;
            }
            if (nextProviderModel) {
                currentProviderModel = nextProviderModel;
            }
        },
        async disposeProviderSession() {
            if (runtimeDisposePromise) return await runtimeDisposePromise;
            runtimeDisposed = true;
            runtimeDisposePromise = (async () => {
                const queriesToDispose = new Set<ClaudeSdkQuery>();
                if (activeQuery) {
                    cancelledQueries.set(activeQuery, 'runtime_disposed');
                    queriesToDispose.add(activeQuery);
                }
                if (disposeQuery) queriesToDispose.add(disposeQuery);
                for (const queryToDispose of backgroundQueries) {
                    queriesToDispose.add(queryToDispose);
                }
                activeQuery = null;
                disposeQuery = null;
                activeProviderTaskId = null;
                activeCompletion = null;
                lastTurnCompletionFailure = null;
                backgroundQueries.clear();
                reconcileProviderTaskRuntimeActivityForCurrentQuery('runtime-dispose');
                turnInFlight = false;
                await sessionHookSetupPromise?.catch(() => undefined);
                if (workflowRuntime) {
                    await workflowRuntime.flush().catch(() => undefined);
                    workflowRuntime.dispose();
                }
                disposeWorkflowOwnedToolUseIdsRegistration?.();
                await resumeIdentityOwner?.dispose().catch(() => undefined);
                const tail = goalStatusTail;
                goalStatusTail = null;
                if (tail) await retireGoalStatusTail(tail);
                await Promise.all(Array.from(retiringGoalStatusTails));
                const hookPluginDir = sessionHookPluginDir;
                sessionHookPluginDir = null;
                if (hookPluginDir) {
                    await params.ctx.agentRuntime.sessionHooks.disposePluginDir(hookPluginDir).catch(() => undefined);
                }
                const hookServer = sessionHookServer;
                sessionHookServer = null;
                if (hookServer) await hookServer.dispose().catch(() => undefined);
                await Promise.all(Array.from(queriesToDispose, async (queryToDispose) => {
                    await queryToDispose.dispose().catch(() => undefined);
                }));
                effectiveModelListeners.clear();
                usageObservationListeners.clear();
            })();
            await runtimeDisposePromise;
        },
    };

    return operations;
}
