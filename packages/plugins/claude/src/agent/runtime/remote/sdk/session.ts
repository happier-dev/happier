import type {
    CreateSessionRuntimeParamsV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type {
    BundledSessionRuntimeCreateResultV1,
    InternalRuntimeTurnOperationsEnvelopeV1,
} from '@happier-dev/plugin-sdk/internal/runtime/session';
import { RuntimeEventV1Schema, type RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import { createClaudePermissionEngine } from '../../../permissions/createClaudePermissionEngine.js';
import { query } from '../../../sdk/query.js';
import type { ClaudeSdkQuery } from '../../../sdk/query.js';
import type { PermissionResult, SDKMessage, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from '../../../sdk/types.js';
import { isolateClaudeRuntimeAuthEnv } from '../../../auth/services/runtime/env.js';
import { recordClaudeRuntimeProviderAccountUsageSnapshot } from '../../accountUsage.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { isClaudeUltracodeSupportedModelId } from '../../reasoningEffort.js';

export type ClaudeAgentSdkToolPermissionPolicy =
    | 'no_tools'
    | 'read_only'
    | 'workspace_write'
    | 'parent_session_prompt';

type HostSessionRuntimeFactoryParams = Readonly<{
    directory?: string;
    session?: Readonly<{ sessionId?: string }>;
    getPermissionMode?: () => unknown;
    setThinking?: (thinking: boolean) => void;
}>;

type RuntimeEventMessage = RuntimeEventV1;

type ClaudeAgentSdkFallbackPlan = Readonly<{
    kind: 'hostSessionRuntimePlan';
    providerId: 'claude';
    opts: Readonly<Record<string, unknown>>;
    config: Readonly<{
        flavor: 'claude';
        policyAgentId: 'claude';
        backendDisplayName: 'Claude';
        uiLogPrefix: '[claude]';
        providerName: 'Claude';
        waitingForCommandLabel: 'Claude';
        agentMessageType: 'claude';
        checkpointToolProtocol: 'claude';
        supportsMcpServers: true;
        machineMetadata: Readonly<Record<string, unknown>>;
        terminalDisplay: () => null;
        shouldRenderTerminalDisplay: () => false;
        formatPromptErrorMessage: (error: unknown) => string;
        startRuntimeBeforeFirstPrompt: true;
        createSessionRuntime: (params: HostSessionRuntimeFactoryParams) => Promise<InternalRuntimeTurnOperationsEnvelopeV1>;
    }>;
}>;

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readDirectory(sessionParams: CreateSessionRuntimeParamsV1): string {
    return readString(sessionParams.cwd)
        ?? readString(sessionParams.directory)
        ?? process.cwd();
}

function readHostCredentials(sessionParams: CreateSessionRuntimeParamsV1): unknown {
    return (sessionParams as CreateSessionRuntimeParamsV1 & Readonly<{
        credentials?: unknown;
    }>).credentials;
}

function readEnv(sessionParams: CreateSessionRuntimeParamsV1): Readonly<Record<string, string>> {
    const source = sessionParams.isolation?.env ?? sessionParams.env ?? {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string') env[key] = value;
    }
    return isolateClaudeRuntimeAuthEnv(env);
}

function formatPromptErrorMessage(error: unknown): string {
    if (error instanceof Error && readString(error.message)) {
        return error.message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]');
    }
    return 'Claude prompt failed';
}

function isSdkSystemMessage(message: SDKMessage): message is SDKSystemMessage {
    return message.type === 'system';
}

function isSdkResultMessage(message: SDKMessage): message is SDKResultMessage {
    return message.type === 'result';
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

function createResultError(message: SDKResultMessage): Error {
    const subtype = readString(message.subtype) ?? 'unknown';
    return new Error(`Claude Agent SDK turn failed with result subtype ${subtype}`);
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
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
                timeout.unref?.();
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function readRuntimeConfigString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'default') return null;
    return trimmed;
}

function readNonEmptyConfigString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

// Reads the reasoning-effort runtime override. The canonical UI/provider id is
// `reasoning_effort`; bare `effort` is kept only as a tested legacy alias. Returns a
// string when set, `null` when explicitly cleared, and `undefined` when not present so
// callers can distinguish "leave as-is" from "clear".
function readEffortFromRuntimeConfigUpdate(update: Readonly<Record<string, unknown>>): string | null | undefined {
    const configOption = update.configOption;
    if (!configOption || typeof configOption !== 'object' || Array.isArray(configOption)) return undefined;
    const option = configOption as Record<string, unknown>;
    const optionId = readNonEmptyConfigString(option.id);
    if (optionId !== 'reasoning_effort' && optionId !== 'effort') return undefined;
    const value = readNonEmptyConfigString(option.value);
    return value ?? null;
}

// Reads the ultracode runtime override (boolean config option). Returns `true`/`false`
// when present and `undefined` when the update does not carry the option.
function readUltracodeFromRuntimeConfigUpdate(update: Readonly<Record<string, unknown>>): boolean | undefined {
    const configOption = update.configOption;
    if (!configOption || typeof configOption !== 'object' || Array.isArray(configOption)) return undefined;
    const option = configOption as Record<string, unknown>;
    if (readNonEmptyConfigString(option.id) !== 'ultracode') return undefined;
    if (option.value === true || option.value === 'true') return true;
    if (option.value === false || option.value === 'false') return false;
    return undefined;
}

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

function mapSdkRuntimeEvent(params: Readonly<{
    message: SDKMessage;
    sessionId: string;
    turnId: string;
}>): RuntimeEventMessage | null {
    if (params.message.type === 'assistant') {
        return RuntimeEventV1Schema.parse({
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            kind: 'message-delta',
            turnId: params.turnId,
            delta: {
                provider: 'claude',
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
                provider: 'claude',
                result: params.message.result ?? null,
            },
        });
    }
    const parsed = RuntimeEventV1Schema.safeParse(params.message);
    return parsed.success ? parsed.data : null;
}

export function createClaudeAgentSdkTurnOperations(params: Readonly<{
    ctx: PluginContextV1;
    directory: string;
    launchEnv: Readonly<Record<string, string>>;
    permissionMode: string;
    happierSessionId?: string | null;
    toolPermissionPolicy?: ClaudeAgentSdkToolPermissionPolicy | null;
    abortSignal?: AbortSignal;
    publishSdkMessages?: boolean;
}>): InternalRuntimeTurnOperationsEnvelopeV1 {
    const permissionEngine = createClaudePermissionEngine(params.ctx);
    const listeners = new Set<Parameters<InternalRuntimeTurnOperationsEnvelopeV1['operations']['subscribeRuntimeEvents']>[0]>();
    let providerSessionId: string | null = null;
    let activeQuery: ClaudeSdkQuery | null = null;
    let disposeQuery: ClaudeSdkQuery | null = null;
    let activeCompletion: ReturnType<typeof createDeferred> | null = null;
    let turnInFlight = false;
    let turnSequence = 0;
    let currentTurnId: string | null = null;
    let currentPermissionMode = params.permissionMode;
    let currentModelId: string | null = null;
    let currentFallbackModel: string | null = null;
    let currentEffort: string | null = null;
    let currentUltracode = false;
    const toolPermissionPolicy = params.toolPermissionPolicy ?? null;

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

    async function consumeTurnMessages(turnQuery: ClaudeSdkQuery, completion: ReturnType<typeof createDeferred>): Promise<void> {
        let sawResult = false;
        try {
            for await (const message of turnQuery) {
                if (isSdkSystemMessage(message)) {
                    providerSessionId = readString(message.session_id) ?? providerSessionId;
                }
                if (isSdkResultMessage(message)) {
                    providerSessionId = readString(message.session_id) ?? providerSessionId;
                }
                if (params.publishSdkMessages === true) {
                    const runtimeEvent = mapSdkRuntimeEvent({
                        message,
                        sessionId: providerSessionId ?? readString(params.happierSessionId) ?? 'claude-agent-sdk',
                        turnId: currentTurnId ?? 'claude-agent-sdk-turn',
                    });
                    if (runtimeEvent) {
                        for (const listener of Array.from(listeners)) {
                            listener(runtimeEvent);
                        }
                    }
                }
                if (!isSdkResultMessage(message)) continue;
                sawResult = true;
                if (activeQuery === turnQuery) activeQuery = null;
                if (activeCompletion === completion) turnInFlight = false;
                if (message.subtype === 'success' && message.is_error !== true) {
                    completion.resolve();
                } else {
                    completion.reject(createResultError(message));
                }
                return;
            }
            if (!sawResult) {
                completion.reject(new Error('Claude Agent SDK process exited before emitting a result.'));
            }
        } catch (error) {
            completion.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
            if (activeQuery === turnQuery) activeQuery = null;
            if (activeCompletion === completion) turnInFlight = false;
        }
    }

    const operations: InternalRuntimeTurnOperationsEnvelopeV1['operations'] = {
        beginTurnLifecycle() {
            turnSequence += 1;
            currentTurnId = `claude-agent-sdk-turn-${turnSequence}`;
        },
        async startOrLoadSession(opts) {
            const requestedSessionId = opts && typeof opts === 'object' && !Array.isArray(opts)
                ? readString((opts as Readonly<Record<string, unknown>>).resumeId)
                    ?? readString((opts as Readonly<Record<string, unknown>>).sessionId)
                    ?? readString((opts as Readonly<Record<string, unknown>>).providerSessionId)
                : null;
            return providerSessionId ?? requestedSessionId ?? readString(params.happierSessionId);
        },
        async sendTurnPrompt(prompt) {
            if (turnInFlight) {
                throw new Error('Claude Agent SDK turn is already running.');
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
                    // Ultracode rides the single inline --settings overlay; an unhonorable
                    // request resolves to OFF (gate = xhigh capability, [1m]-tolerant).
                    ...(currentUltracode && isClaudeUltracodeSupportedModelId(currentModelId)
                        ? { settingsJson: JSON.stringify({ ultracode: true }) }
                        : {}),
                    ...(toolPermissionPolicy === 'read_only'
                        ? {}
                        : { canCallTool: resolvePermission }),
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
        async steerInFlightTurn(message) {
            await operations.sendTurnPrompt(message);
        },
        async waitForTurnCompletion(opts) {
            const timeoutMs = readTimeoutMs(opts);
            await withTimeout(activeCompletion?.promise ?? Promise.resolve(), timeoutMs);
        },
        subscribeRuntimeEvents(handler) {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
            };
        },
        async respondToPermission(requestId, approved) {
            await params.ctx.session.permissions.requestDecision({
                provider: 'claude',
                requestId,
                approved,
            });
        },
        async cancelTurn() {
            const turnQuery = activeQuery;
            if (!turnQuery) return;
            await turnQuery.interrupt();
            await turnQuery.dispose();
        },
        readSessionIdentity() {
            return { sessionId: providerSessionId ?? readString(params.happierSessionId) };
        },
        async updateSessionRuntimeConfig(update) {
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
            const turnQuery = activeQuery ?? disposeQuery;
            activeQuery = null;
            disposeQuery = null;
            activeCompletion = null;
            turnInFlight = false;
            await turnQuery?.dispose();
        },
    };

    return {
        operations,
        nativeRuntime: operations,
        runtimeDescriptor: {
            kind: 'claude-agent-sdk',
            providerId: 'claude',
        },
        runtimeCapabilities: {
            input: {
                terminalPromptInjectionSupported: false,
            },
        },
    };
}

export async function bindClaudeAgentSdkFallbackSession(params: Readonly<{
    ctx: PluginContextV1;
    sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<BundledSessionRuntimeCreateResultV1> {
    const directory = readDirectory(params.sessionParams);
    const launchEnv = readEnv(params.sessionParams);
    const initialPermissionMode = readString(params.sessionParams.permissionMode) ?? 'default';
    const credentials = readHostCredentials(params.sessionParams);

    return {
        kind: 'hostSessionRuntimePlan',
        providerId: 'claude',
        opts: {
            directory,
            backendId: 'claude',
            ...(credentials === undefined ? {} : { credentials }),
        },
        config: {
            flavor: 'claude',
            policyAgentId: 'claude',
            backendDisplayName: 'Claude',
            uiLogPrefix: '[claude]',
            providerName: 'Claude',
            waitingForCommandLabel: 'Claude',
            agentMessageType: 'claude',
            checkpointToolProtocol: 'claude',
            supportsMcpServers: true,
            machineMetadata: {},
            terminalDisplay: () => null,
            shouldRenderTerminalDisplay: () => false,
            formatPromptErrorMessage,
            startRuntimeBeforeFirstPrompt: true,
            createSessionRuntime: async (runtimeParams) => createClaudeAgentSdkTurnOperations({
                ctx: params.ctx,
                directory: readString(runtimeParams.directory) ?? directory,
                launchEnv,
                permissionMode: readString(runtimeParams.getPermissionMode?.()) ?? initialPermissionMode,
                happierSessionId: readString(runtimeParams.session?.sessionId) ?? readString(params.sessionParams.sessionId),
            }),
        },
    } satisfies ClaudeAgentSdkFallbackPlan;
}
