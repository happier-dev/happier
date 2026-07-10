import {
    createSessionRuntimeActivityPublisher,
    type CreateSessionRuntimeParamsV1,
    type PluginContextV1,
    type RuntimeEventV1,
    type SessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk';
import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk/experimental/diagnostics';
import {
    buildSessionRuntimeIssueV1,
    RuntimeEventV1Schema,
    type SessionRuntimeIssueSourceV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/experimental/timeout';
import { join } from 'node:path';

import { createClaudePermissionEngine } from '../../../permissions/createClaudePermissionEngine.js';
import { createClaudeSdkNoResultError, query } from '../../../sdk/query.js';
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
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';
import {
    createClaudePublicSessionRuntime,
    type ClaudePublicSessionRuntime,
    type ClaudeRuntimeTurnOperations,
} from '../../sessionRuntime.js';
import {
    createClaudeUnifiedWorkflowRuntime,
    registerClaudeWorkflowOwnedToolUseIds,
} from '../../../workflowRecords/index.js';
import { createClaudeUnifiedGoalRuntime } from '../../terminal/unified/goalRuntime.js';
import { getClaudeProjectPath, resolveClaudeConfigDirOverride } from '../../../surfaces/sessions/handoff/path.js';
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
    buildClaudeProviderTaskRuntimeActivitySourceId,
    createClaudeProviderActivityLedger,
} from './providerActivity.js';
import {
    clearClaudeRuntimeActivitySources,
    observeClaudeProviderTaskActivity,
    publishClaudeProviderSessionId,
    publishClaudeRuntimeActivityUpdate,
    readClaudeRuntimeConfigEffortUpdate,
    readClaudeRuntimeConfigUltracodeUpdate,
    readClaudeRuntimeDirectory,
    readClaudeRuntimeEnv,
    readClaudeRuntimeString,
    respondToClaudePermission,
} from '../../shared/runtimeHelpers.js';

export type ClaudeAgentSdkToolPermissionPolicy =
    | 'no_tools'
    | 'read_only'
    | 'workspace_write'
    | 'parent_session_prompt';

type RuntimeEventMessage = RuntimeEventV1;
type ClaudeProviderFailureEvidence = Readonly<{
    code: string;
    source: SessionRuntimeIssueSourceV1;
    preview: string | null;
}>;
type ClaudeSubscriptionRuntimeAuthSelection =
    | Readonly<{
        kind: 'profile';
        serviceId: 'claude-subscription';
        profileId: string;
    }>
    | Readonly<{
        kind: 'group';
        serviceId: 'claude-subscription';
        groupId: string;
        activeProfileId: string;
        fallbackProfileId: string;
        generation: number;
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
    if (value.kind === 'profile') {
        const profileId = readString(value.profileId);
        return profileId ? { kind: 'profile', serviceId: 'claude-subscription', profileId } : null;
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
}>): SessionRuntimeIssueSourceV1 {
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

function resolvePromptInput(prompt: string, policy: ClaudeAgentSdkToolPermissionPolicy | null): string | AsyncIterable<SDKUserMessage> {
    return policy === 'read_only' ? prompt : createPromptStream(prompt);
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
}>): RuntimeEventMessage | null {
    if (params.message.type === 'assistant') {
        return RuntimeEventV1Schema.parse({
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
        return RuntimeEventV1Schema.parse({
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
        return RuntimeEventV1Schema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'turn-failed',
            turnId: params.turnId,
            issue: buildSessionRuntimeIssueV1({
                code: failure.code,
                source: failure.source,
                occurredAt: Date.now(),
                agentId: 'claude',
                sanitizedPreview: failure.preview,
            }),
        });
    }
    const parsed = RuntimeEventV1Schema.safeParse(params.message);
    return parsed.success ? parsed.data : null;
}

function mapSdkTranscriptEvent(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    sequence: number;
}>): RuntimeEventMessage | null {
    if (!isSdkAssistantMessage(params.message)) return null;
    const text = readAssistantText(params.message);
    if (!text) return null;
    return RuntimeEventV1Schema.parse({
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
}>): RuntimeEventMessage | null {
    const text = readString(params.message.result);
    if (!text) return null;
    return RuntimeEventV1Schema.parse({
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
}>): RuntimeEventMessage | null {
    const usage = isRecord(params.message.usage) ? params.message.usage : null;
    const modelUsage = isRecord(params.message.modelUsage) ? params.message.modelUsage : null;
    const providerSessionId = readString(params.message.session_id);
    const subtype = readString(params.message.subtype);
    if (!usage || !modelUsage || !providerSessionId || !subtype) return null;
    const messageId = readMessageId(params.message, `result-${params.sequence}`);
    return RuntimeEventV1Schema.parse({
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
}>): RuntimeEventMessage[] {
    const events: RuntimeEventMessage[] = [];
    for (const block of extractToolUseBlocksFromSdkMessage(params.message)) {
        params.toolNameByCallId.set(block.id, block.name);
        events.push(RuntimeEventV1Schema.parse({
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
        events.push(RuntimeEventV1Schema.parse({
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

export function createClaudeAgentSdkTurnOperations(params: Readonly<{
    ctx: PluginContextV1;
    directory: string;
    launchEnv: Readonly<Record<string, string>>;
    permissionMode: string;
    happierSessionId?: string | null;
    toolPermissionPolicy?: ClaudeAgentSdkToolPermissionPolicy | null;
    abortSignal?: AbortSignal;
    initialModelId?: string | null;
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
}>): ClaudePublicSessionRuntime {
    const permissionEngine = createClaudePermissionEngine(params.ctx);
    const listeners = new Set<(event: RuntimeEventV1) => void>();
    let providerSessionId: string | null = null;
    const providerSessionPublicationState = { publishedProviderSessionId: null as string | null };
    let pendingResumeProviderSessionId: string | null = null;
    let activeQuery: ClaudeSdkQuery | null = null;
    let disposeQuery: ClaudeSdkQuery | null = null;
    let activeCompletion: DeferredCompletion | null = null;
    let lastTurnCompletionFailure: Error | null = null;
    const backgroundQueries = new Set<ClaudeSdkQuery>();
    let turnInFlight = false;
    let turnSequence = 0;
    let currentTurnId: string | null = null;
    let currentPermissionMode = params.permissionMode;
    let currentModelId: string | null = readString(params.initialModelId);
    let currentFallbackModel: string | null = null;
    let currentEffort: string | null = null;
    let currentUltracode = false;
    let contextUsageRefreshPromise: Promise<boolean> | null = null;
    const toolPermissionPolicy = params.toolPermissionPolicy ?? null;
    const sessionWorkStateEnabled = params.enableSessionWorkState === true;
    const providerActivityLedger = createClaudeProviderActivityLedger({
        // W-3 backstop: a stale provider task whose terminal event was dropped expires after the TTL.
        // Reconcile so its runtime-activity source is cleared and the session stops looking "working".
        // (The target function is a hoisted declaration below; the arrow only runs at expiry.)
        onActiveTasksExpired: () => { reconcileProviderTaskRuntimeActivityForCurrentQuery('provider-task-ttl-expired'); },
    });
    const runtimeActivityPublisher = createSessionRuntimeActivityPublisher({
        session: params.ctx.sessions.current,
    });
    const liveProviderTaskIds = new Set<string>();
    const providerTaskRuntimeActivitySourceIds = new Set<string>();

    function publishRuntimeActivityUpdate(promise: Promise<void>, reason: string): void {
        publishClaudeRuntimeActivityUpdate({
            logger: params.ctx.logger,
            logPrefix: '[ClaudeAgentSdk]',
            promise,
            reason,
        });
    }

    function clearRuntimeActivitySources(reason: string): void {
        providerTaskRuntimeActivitySourceIds.clear();
        clearClaudeRuntimeActivitySources({
            logger: params.ctx.logger,
            logPrefix: '[ClaudeAgentSdk]',
            runtimeActivityPublisher,
            reason,
        });
    }

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
            runtimeActivityPublisher,
            logError: (message, error) => { params.ctx.logger.debug(`[ClaudeAgentSdk] ${message}`, { error }); },
        })
        : null;
    // CWF4: expose workflow-owned subagent tool-use ids to the (stateless) task work-state derivation,
    // keyed by the Happier session id, so a canonical Workflow run's agents do not ALSO render as
    // top-level task/todo rows.
    const disposeWorkflowOwnedToolUseIdsRegistration = workflowRuntime
        ? registerClaudeWorkflowOwnedToolUseIds(
            readString(params.happierSessionId) ?? 'claude-agent-sdk',
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
            writeMetadataUpdate: async (request) => { await params.ctx.sessions.current.writeMetadata(request); },
            injectGoalCommand: async (message) => { await operations.sendTurnPrompt(message); },
            logError: (message, error) => { params.ctx.logger.debug(`[ClaudeAgentSdk] ${message}`, { error }); },
        })
        : null;
    let goalStatusTail: ClaudeAgentSdkGoalStatusTail | null = null;

    // Narrow side-follow of the persisted transcript JSONL for the file-only `goal_status`
    // attachments (not present on the live SDK stream). Started lazily once the Claude session id
    // is known, since the transcript path is `<projectPath>/<providerSessionId>.jsonl`.
    function ensureGoalStatusTail(): void {
        if (!goalRuntime || goalStatusTail || !providerSessionId) return;
        const goalSource = goalRuntime.source;
        const transcriptPath = join(
            getClaudeProjectPath(params.directory, resolveClaudeConfigDirOverride({ ...params.launchEnv })),
            `${providerSessionId}.jsonl`,
        );
        goalStatusTail = createClaudeAgentSdkGoalStatusTail({
            ctx: params.ctx,
            transcriptPath,
            observeGoalStatusRow: (row) => goalSource.observeTranscriptMessage(row),
        });
    }

    function observeSessionWorkStateMessage(message: SDKMessage): void {
        if (!sessionWorkStateEnabled) return;
        // ONE live channel, two provider-clean sources: workflow activity + goal capability.
        workflowRuntime?.observeTranscriptMessage(message);
        goalRuntime?.source.observeTranscriptMessage(message);
    }

    function publishRuntimeEvent(event: RuntimeEventV1 | null): void {
        if (!event) return;
        for (const listener of Array.from(listeners)) {
            listener(event);
        }
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
            publishRuntimeEvent(RuntimeEventV1Schema.parse({
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
        if (!providerSessionId) return false;

        const idleController = new AbortController();
        const transientQuery = query(params.ctx, {
            prompt: createIdlePromptStream(idleController.signal),
            options: {
                cwd: params.directory,
                env: params.launchEnv,
                abort: params.abortSignal,
                resume: providerSessionId,
                ...(currentModelId ? { model: currentModelId } : {}),
                extraArgs: buildClaudeMcpConfigArgs(params.mcpServers),
            },
        });
        try {
            return await requestAndPublishContextUsage(transientQuery);
        } finally {
            idleController.abort();
            await transientQuery.dispose().catch(() => undefined);
        }
    }

    function observeProviderTaskActivity(message: SDKMessage): boolean {
        return observeClaudeProviderTaskActivity({
            row: message,
            ledger: providerActivityLedger,
            runtimeActivityPublisher,
            logger: params.ctx.logger,
            logPrefix: '[ClaudeAgentSdk]',
            onLiveProviderTaskEvidence(taskId) {
                liveProviderTaskIds.add(taskId);
            },
            onProviderTaskSourceActive(sourceId) {
                providerTaskRuntimeActivitySourceIds.add(sourceId);
            },
            onProviderTaskSourceCleared(sourceId) {
                providerTaskRuntimeActivitySourceIds.delete(sourceId);
            },
        });
    }

    function reconcileProviderTaskRuntimeActivityForCurrentQuery(reason: string): void {
        const liveSourceIds = new Set<string>();
        for (const taskId of providerActivityLedger.getActiveProviderTaskIds()) {
            if (!liveProviderTaskIds.has(taskId)) continue;
            const sourceId = buildClaudeProviderTaskRuntimeActivitySourceId(taskId);
            if (sourceId) liveSourceIds.add(sourceId);
        }

        const updates: Promise<void>[] = [];
        for (const sourceId of [...providerTaskRuntimeActivitySourceIds]) {
            if (liveSourceIds.has(sourceId)) continue;
            providerTaskRuntimeActivitySourceIds.delete(sourceId);
            updates.push(runtimeActivityPublisher.clearSource(sourceId));
        }
        for (const sourceId of liveSourceIds) {
            providerTaskRuntimeActivitySourceIds.add(sourceId);
            updates.push(runtimeActivityPublisher.markSourceActive({
                sourceId,
                sourceKind: 'provider_detached_task',
            }));
        }
        if (updates.length === 0) return;
        publishRuntimeActivityUpdate(Promise.all(updates).then(() => undefined), reason);
    }

    type SuccessfulTurn = Readonly<{
        completion: DeferredCompletion;
        message: SDKResultMessage;
        messageSequence: number;
        providerFailure: ClaudeProviderFailureEvidence | null;
        publishedTranscriptText: boolean;
        turnQuery: ClaudeSdkQuery;
    }>;

    function completeSuccessfulTurn(turn: SuccessfulTurn): void {
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
        if (params.publishTranscriptMessages === true && !turn.publishedTranscriptText) {
            const resultTranscriptEvent = mapResultTranscriptEvent({
                message: turn.message,
                sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                sequence: turn.messageSequence,
            });
            if (resultTranscriptEvent) publishRuntimeEvent(resultTranscriptEvent);
        }
        if (params.publishSdkMessages === true || params.publishTranscriptMessages === true) {
            publishRuntimeEvent(mapSdkRuntimeEvent({
                message: turn.message,
                sessionId: params.publishTranscriptMessages === true
                    ? readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk'
                    : providerSessionId ?? readString(params.happierSessionId) ?? 'claude-agent-sdk',
                turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                providerFailure: turn.providerFailure,
            }));
        }
        reconcileProviderTaskRuntimeActivityForCurrentQuery('foreground-result');
        turn.completion.resolve();
    }

    function completeProviderBackgroundObservation(turnQuery: ClaudeSdkQuery): void {
        backgroundQueries.delete(turnQuery);
        if (backgroundQueries.size === 0 && !providerActivityLedger.hasActiveProviderTasks()) {
            providerActivityLedger.clearProviderTasks();
            clearRuntimeActivitySources('background-observation-complete');
        }
    }

    function publishProviderSessionId(nextSessionId: string): void {
        publishClaudeProviderSessionId({
            ctx: params.ctx,
            state: providerSessionPublicationState,
            nextSessionId,
            reason: 'claude-agent-sdk-session-id',
            logPrefix: '[ClaudeAgentSdk]',
        });
    }

    function observeProviderSessionId(value: unknown): void {
        const nextSessionId = readString(value);
        if (!nextSessionId) return;
        providerSessionId = nextSessionId;
        publishProviderSessionId(nextSessionId);
        ensureGoalStatusTail();
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
    const getClaudeSdkOAuthToken = (
        claudeSubscriptionRuntimeAuthSelection && typeof refreshRuntimeAuth === 'function'
    )
        ? async (options: { signal: AbortSignal }): Promise<string | null> => {
            // The SDK calls this again after a delivered token fails; carry only the previous
            // token fingerprint so the daemon can adopt a newer stored token before forcing rotation.
            const refreshRequest = {
                agentId: 'claude',
                serviceId: 'claude-subscription',
                targetId: readString(params.happierSessionId),
                env: params.launchEnv,
                selection: claudeSubscriptionRuntimeAuthSelection,
                reason: 'claude_agent_sdk_oauth_token_refresh',
                failingAccessTokenFingerprint: lastClaudeSdkOAuthTokenFingerprint,
            };
            const result = await refreshRuntimeAuth(refreshRequest, { signal: options.signal });
            const accessToken = readRefreshedAccessToken(result);
            lastClaudeSdkOAuthTokenFingerprint = computeClaudeSubscriptionAccessTokenFingerprint(accessToken);
            return accessToken;
        }
        : null;

    async function consumeTurnMessages(turnQuery: ClaudeSdkQuery, completion: DeferredCompletion): Promise<void> {
        let sawResult = false;
        let messageSequence = 0;
        let publishedTranscriptText = false;
        let providerFailure: ClaudeProviderFailureEvidence | null = null;
        let foregroundCompleted = false;
        const toolNameByCallId = new Map<string, string>();
        try {
            for await (const message of turnQuery) {
                messageSequence += 1;
                if (isSdkSystemMessage(message)) {
                    observeProviderSessionId(message.session_id);
                }
                if (isSdkResultMessage(message)) {
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
                if (params.publishSdkMessages === true && !isSuccessfulResultMessage) {
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
                    completeSuccessfulTurn(successfulTurn);
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
                    providerActivityLedger.clearProviderTasks();
                    clearRuntimeActivitySources('result-error');
                    if (params.publishTranscriptMessages === true) {
                        publishRuntimeEvent(mapSdkRuntimeEvent({
                            message,
                            sessionId: readString(params.happierSessionId) ?? providerSessionId ?? 'claude-agent-sdk',
                            turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                            providerFailure,
                        }));
                    }
                    const resultError = createResultError(message, providerFailure);
                    lastTurnCompletionFailure = resultError;
                    completion.reject(resultError);
                }
                return;
            }
            if (!sawResult) {
                const noResultError = createClaudeSdkNoResultError(turnQuery.readExitResult());
                lastTurnCompletionFailure = noResultError;
                completion.reject(noResultError);
            }
        } catch (error) {
            if (foregroundCompleted) {
                backgroundQueries.delete(turnQuery);
                if (backgroundQueries.size === 0) {
                    providerActivityLedger.clearProviderTasks();
                    clearRuntimeActivitySources('background-query-error');
                }
                return;
            }
            providerActivityLedger.clearProviderTasks();
            clearRuntimeActivitySources('turn-error');
            const turnError = error instanceof Error ? error : new Error(String(error));
            lastTurnCompletionFailure = turnError;
            completion.reject(turnError);
        } finally {
            if (backgroundQueries.has(turnQuery)) {
                backgroundQueries.delete(turnQuery);
                if (backgroundQueries.size === 0 && !turnInFlight) {
                    providerActivityLedger.clearProviderTasks();
                    clearRuntimeActivitySources('turn-finally');
                }
            }
            if (activeQuery === turnQuery) activeQuery = null;
            if (activeCompletion === completion) {
                activeCompletion = null;
                turnInFlight = false;
            }
        }
    }

    const operations: ClaudeRuntimeTurnOperations = {
        beginTurnLifecycle() {
            turnSequence += 1;
            currentTurnId = `claude-agent-sdk-turn-${turnSequence}`;
        },
        async startOrLoadSession(opts) {
            const requestedResumeId = readString(opts?.resumeId);
            if (requestedResumeId && providerSessionId === null) pendingResumeProviderSessionId = requestedResumeId;
            return providerSessionId;
        },
        async sendTurnPrompt(prompt) {
            if (turnInFlight) {
                throw new Error('Claude Agent SDK turn is already running.');
            }
            lastTurnCompletionFailure = null;
            liveProviderTaskIds.clear();
            if (backgroundQueries.size === 0) {
                providerActivityLedger.clearProviderTasks();
                clearRuntimeActivitySources('new-turn-no-background-query');
            }
            const completion = createDeferred();
            completion.promise.catch(() => undefined);
            const turnQuery = query(params.ctx, {
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
                    ...(providerSessionId ?? pendingResumeProviderSessionId
                        ? { resume: providerSessionId ?? pendingResumeProviderSessionId ?? undefined }
                        : {}),
                    extraArgs: buildClaudeMcpConfigArgs(params.mcpServers),
                    // Ultracode rides the single inline --settings overlay; an unhonorable
                    // request resolves to OFF (gate = xhigh capability, [1m]-tolerant).
                    ...(currentUltracode && isClaudeUltracodeSupportedModelId(currentModelId)
                        ? { settingsJson: JSON.stringify({ ultracode: true }) }
                        : {}),
                    ...(toolPermissionPolicy === 'read_only'
                        ? {}
                        : { canCallTool: resolvePermission }),
                    ...(getClaudeSdkOAuthToken ? { getOAuthToken: getClaudeSdkOAuthToken } : {}),
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
            turnInFlight = true;
            void consumeTurnMessages(turnQuery, completion);
        },
        async steerInFlightTurn(message, meta) {
            await operations.sendTurnPrompt(message, meta);
        },
        async waitForTurnCompletion(opts) {
            const timeoutMs = readTimeoutMs(opts);
            if (!activeCompletion && lastTurnCompletionFailure) throw lastTurnCompletionFailure;
            await withTimeout(activeCompletion?.promise ?? Promise.resolve(), timeoutMs);
        },
        subscribeRuntimeEvents(handler) {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
            };
        },
        async respondToPermission(requestId, approved) {
            return respondToClaudePermission({ ctx: params.ctx, provider: 'claude', requestId, approved });
        },
        async cancelTurn() {
            const turnQuery = activeQuery;
            if (!turnQuery) return;
            await turnQuery.interrupt();
            await turnQuery.dispose();
        },
        readSessionIdentity() {
            return { sessionId: providerSessionId };
        },
        async updateSessionRuntimeConfig(update) {
            const configOption = isRecord(update.configOption) ? update.configOption : null;
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
        },
        async resetOrDisposeRuntime() {
            const queriesToDispose = new Set<ClaudeSdkQuery>();
            if (activeQuery) queriesToDispose.add(activeQuery);
            if (disposeQuery) queriesToDispose.add(disposeQuery);
            for (const queryToDispose of backgroundQueries) {
                queriesToDispose.add(queryToDispose);
            }
            activeQuery = null;
            disposeQuery = null;
            activeCompletion = null;
            lastTurnCompletionFailure = null;
            backgroundQueries.clear();
            providerActivityLedger.clearProviderTasks();
            clearRuntimeActivitySources('runtime-dispose');
            turnInFlight = false;
            if (workflowRuntime) {
                await workflowRuntime.flush().catch(() => undefined);
                workflowRuntime.dispose();
            }
            disposeWorkflowOwnedToolUseIdsRegistration?.();
            const tail = goalStatusTail;
            goalStatusTail = null;
            if (tail) await tail.dispose().catch(() => undefined);
            await Promise.all(Array.from(queriesToDispose, async (queryToDispose) => {
                await queryToDispose.dispose().catch(() => undefined);
            }));
        },
    };

    return createClaudePublicSessionRuntime(operations);
}

export async function bindClaudeAgentSdkFallbackSession(params: Readonly<{
    ctx: PluginContextV1;
    sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<SessionRuntimeCreateResultV1> {
    const directory = readClaudeRuntimeDirectory(params.sessionParams);
    const launchEnv = readClaudeRuntimeEnv(params.sessionParams);
    const initialPermissionMode = readString(params.sessionParams.permissionMode) ?? 'default';

    return createClaudeAgentSdkTurnOperations({
        ctx: params.ctx,
        directory,
        launchEnv,
        permissionMode: initialPermissionMode,
        happierSessionId: readString(params.sessionParams.sessionId),
        mcpServers: params.sessionParams.mcpServers,
        publishTranscriptMessages: true,
        enableSessionWorkState: true,
    });
}
