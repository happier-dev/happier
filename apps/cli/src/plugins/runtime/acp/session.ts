import { randomUUID } from 'node:crypto';

import type {
    AcpRuntimeAuthenticateV1,
    AcpRuntimeInitializeV1,
    AcpSessionRuntimeCompletionOptionsV1,
    AcpSessionRuntimeConfigUpdateV1,
    AcpSessionRuntimeV1,
    AcpSessionStartParamsV1,
    JsonRpcClientV1,
} from '@happier-dev/plugin-sdk';
import { RuntimeEventV1Schema, validatePluginHookPayloadV1, type RuntimeEventV1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

type AcpSessionRuntimeErrorFactory = (message: string) => Error;

export type CreateAcpSessionRuntimeParams = Readonly<{
    client: JsonRpcClientV1;
    sessionId: string;
    cwd: string;
    signal: AbortSignal;
    initializeMeta?: Readonly<Record<string, unknown>>;
    initialize?: AcpRuntimeInitializeV1;
    authenticate?: AcpRuntimeAuthenticateV1;
    turnAbort?: Readonly<{
        beginTurn(): void;
        cancelTurn(): void;
        settleTurn(): void;
    }>;
    transformAgentRequestBeforeDispatch?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
    createDisposedError: () => Error;
    createSessionNotStartedError: () => Error;
    createInvalidResultError: AcpSessionRuntimeErrorFactory;
}>;

const ACP_INITIALIZE_METHOD = 'initialize';
const ACP_AUTHENTICATE_METHOD = 'authenticate';
const ACP_SESSION_NEW_METHOD = 'session/new';
const ACP_SESSION_LOAD_METHOD = 'session/load';
const ACP_SESSION_PROMPT_METHOD = 'session/prompt';
const ACP_SESSION_CANCEL_METHOD = 'session/cancel';
const ACP_SESSION_SET_MODE_METHOD = 'session/set_mode';
const ACP_SESSION_SET_MODEL_METHOD = 'session/set_model';
const ACP_SESSION_SET_CONFIG_OPTION_METHOD = 'session/set_config_option';

const PROMPT_TURN_SESSION_UPDATE_TYPES = new Set([
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
]);

const TERMINAL_SESSION_UPDATE_TYPES = new Set([
    'task_complete',
    'task_completed',
    'turn_complete',
    'turn_completed',
]);

const FAILED_SESSION_UPDATE_TYPES = new Set([
    'task_failed',
    'turn_failed',
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readSessionId(value: unknown, createError: AcpSessionRuntimeErrorFactory): string {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
        throw createError('ACP session operation returned an invalid session id result');
    }
    return value.sessionId;
}

function assertRuntimeActive(params: CreateAcpSessionRuntimeParams): void {
    if (params.signal.aborted) {
        throw params.createDisposedError();
    }
}

function normalizeMcpServers(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) ? Object.freeze([...value]) : undefined;
}

function buildMcpServersPayload(startParams: AcpSessionStartParamsV1): Readonly<Record<string, unknown>> {
    const mcpServers = normalizeMcpServers(startParams.mcpServers);
    return mcpServers === undefined ? Object.freeze({}) : Object.freeze({ mcpServers });
}

function buildNewSessionParams(
    params: CreateAcpSessionRuntimeParams,
    startParams: AcpSessionStartParamsV1,
): Readonly<Record<string, unknown>> {
    return Object.freeze({
        cwd: params.cwd,
        ...buildMcpServersPayload(startParams),
        ...(params.initializeMeta ? { _meta: params.initializeMeta } : {}),
    });
}

function buildLoadSessionParams(
    params: CreateAcpSessionRuntimeParams,
    providerSessionId: string,
    startParams: AcpSessionStartParamsV1,
): Readonly<Record<string, unknown>> {
    return Object.freeze({
        sessionId: providerSessionId,
        cwd: params.cwd,
        ...buildMcpServersPayload(startParams),
    });
}

function buildInitializeParams(params: CreateAcpSessionRuntimeParams): Readonly<Record<string, unknown>> {
    const lifecycle = params.initialize;
    const clientCapabilities = {
        ...(lifecycle?.clientCapabilities ?? {}),
        ...(params.initializeMeta ? { _meta: params.initializeMeta } : {}),
    };
    return Object.freeze({
        protocolVersion: lifecycle?.protocolVersion ?? 1,
        ...(Object.keys(clientCapabilities).length > 0 ? { clientCapabilities: Object.freeze(clientCapabilities) } : {}),
    });
}

function buildAuthenticateParams(params: CreateAcpSessionRuntimeParams): Readonly<Record<string, unknown>> | null {
    const authenticate = params.authenticate;
    if (!authenticate) {
        return null;
    }
    return Object.freeze({
        methodId: authenticate.methodId,
        ...(authenticate.meta ? { _meta: authenticate.meta } : {}),
    });
}

async function transformAcpAgentRequestBeforeDispatch(params: Readonly<{
    transformAgentRequestBeforeDispatch?: CreateAcpSessionRuntimeParams['transformAgentRequestBeforeDispatch'];
    happySessionId: string;
    method: string;
    request: Readonly<Record<string, unknown>>;
}>): Promise<Readonly<Record<string, unknown>>> {
    if (!params.transformAgentRequestBeforeDispatch) {
        return params.request;
    }
    try {
        const transformed = await params.transformAgentRequestBeforeDispatch({
            sessionId: params.happySessionId,
            runtimeFamily: 'acpSession',
            method: params.method,
            request: params.request,
            timestampMs: Date.now(),
        });
        const validation = validatePluginHookPayloadV1({
            hookId: 'agent.request.before',
            payload: transformed,
        });
        if (!validation.success) {
            logger.debug('[plugins] agent.request.before returned an invalid ACP request payload; using original request', {
                error: validation.message,
            });
            return params.request;
        }
        const parsed = validation.payload as Record<string, unknown>;
        const request = parsed.request;
        return request && typeof request === 'object' && !Array.isArray(request)
            ? request as Readonly<Record<string, unknown>>
            : params.request;
    } catch (error) {
        logger.debug('[plugins] agent.request.before failed for ACP request; using original request', { error });
        return params.request;
    }
}

function readAdvertisedAuthMethodIds(result: unknown): readonly string[] {
    if (!isRecord(result) || !Array.isArray(result.authMethods)) {
        return Object.freeze([]);
    }
    return Object.freeze(result.authMethods
        .map((method) => isRecord(method) ? readString(method.id) : null)
        .filter((methodId): methodId is string => Boolean(methodId)));
}

type RuntimeEventDraft = Omit<RuntimeEventV1, 'sessionId' | 'emittedAtMs'>;

type ActiveTurnState = Readonly<{
    turnId: string;
    providerTurnId: string;
}>;

type PendingCompletion = Readonly<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
}>;

export type AcpSessionRuntimeController = AcpSessionRuntimeV1 & Readonly<{
    handleSessionUpdate(notification: unknown): void;
}>;

function readSessionUpdates(notification: unknown): readonly unknown[] {
    if (!isRecord(notification)) {
        return Object.freeze([notification]);
    }
    if (Array.isArray(notification.updates)) {
        return Object.freeze(notification.updates);
    }
    if ('update' in notification) {
        return Object.freeze(Array.isArray(notification.update) ? notification.update : [notification.update]);
    }
    return Object.freeze([notification]);
}

function readRuntimeEvent(value: unknown): RuntimeEventV1 | null {
    const candidates = (() => {
        if (!isRecord(value)) {
            return [value];
        }
        return [
            value,
            value.runtimeEvent,
            value.event,
            isRecord(value.payload) && value.type === 'event' && value.name === 'runtime.event'
                ? value.payload
                : null,
        ];
    })();
    for (const candidate of candidates) {
        const parsed = RuntimeEventV1Schema.safeParse(candidate);
        if (parsed.success) {
            return parsed.data;
        }
    }
    return null;
}

function readSessionUpdateType(update: unknown): string | null {
    if (!isRecord(update)) {
        return null;
    }
    return readString(update.sessionUpdate) ?? readString(update.type);
}

function readPromptStopReason(update: unknown): string | null {
    if (!isRecord(update)) {
        return null;
    }
    return readString(update.stopReason);
}

function readAgentMessageDelta(update: unknown): unknown | null {
    if (!isRecord(update)) {
        return null;
    }
    const messageChunk = isRecord(update.messageChunk) ? update.messageChunk : null;
    const text = readString(messageChunk?.textDelta)
        ?? readString(messageChunk?.text)
        ?? (isRecord(update.content) ? readString(update.content.textDelta) ?? readString(update.content.text) : null)
        ?? readString(update.textDelta)
        ?? readString(update.text);
    if (!text) {
        return null;
    }
    return Object.freeze({ text });
}

function createCompletion(): PendingCompletion {
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    return Object.freeze({
        promise,
        resolve: resolveCompletion,
        reject: rejectCompletion,
    });
}

function withTimeout(promise: Promise<void>, opts: AcpSessionRuntimeCompletionOptionsV1 | undefined): Promise<void> {
    const timeoutMs = opts?.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`ACP turn completion timed out after ${Math.trunc(timeoutMs)}ms`));
        }, Math.trunc(timeoutMs));
        timeout.unref?.();
        promise.then(
            () => {
                clearTimeout(timeout);
                resolve();
            },
            (error) => {
                clearTimeout(timeout);
                reject(error);
            },
        );
    });
}

export function createAcpSessionRuntime(params: CreateAcpSessionRuntimeParams): AcpSessionRuntimeController {
    let providerSessionId: string | null = null;
    let currentTurn: ActiveTurnState | null = null;
    let pendingCompletion: PendingCompletion | null = null;
    let ordering = 0;
    const subscribers = new Set<(event: RuntimeEventV1) => void>();
    let handshakeComplete = false;

    async function ensureHandshake(): Promise<void> {
        if (handshakeComplete) {
            return;
        }
        let initializeResult: unknown = null;
        if (params.initialize || params.authenticate) {
            initializeResult = await params.client.request(ACP_INITIALIZE_METHOD, buildInitializeParams(params));
        }
        const authenticateParams = buildAuthenticateParams(params);
        if (authenticateParams) {
            const advertisedAuthMethodIds = readAdvertisedAuthMethodIds(initializeResult);
            if (!advertisedAuthMethodIds.includes(params.authenticate!.methodId)) {
                throw params.createInvalidResultError(
                    `ACP initialize did not advertise required auth method '${params.authenticate!.methodId}'`,
                );
            }
            await params.client.request(ACP_AUTHENTICATE_METHOD, authenticateParams);
        }
        handshakeComplete = true;
    }

    async function startOrLoadSession(startParams: AcpSessionStartParamsV1 = {}): Promise<string> {
        assertRuntimeActive(params);
        await ensureHandshake();
        const requestedSessionId = startParams.providerSessionId ?? null;
        const result = requestedSessionId
            ? await params.client.request(ACP_SESSION_LOAD_METHOD, buildLoadSessionParams(params, requestedSessionId, startParams))
            : await params.client.request(ACP_SESSION_NEW_METHOD, buildNewSessionParams(params, startParams));
        providerSessionId = readSessionId(result, params.createInvalidResultError);
        return providerSessionId;
    }

    function readActiveProviderSessionId(): string {
        if (providerSessionId) {
            return providerSessionId;
        }
        throw params.createSessionNotStartedError();
    }

    function publishRuntimeEvent(event: RuntimeEventDraft): void {
        const payload = RuntimeEventV1Schema.parse({
            ...event,
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            ordering: ordering++,
        });
        for (const subscriber of subscribers) {
            subscriber(payload);
        }
        if (
            payload.kind === 'turn-complete'
            || payload.kind === 'turn-cancelled'
            || payload.kind === 'turn-failed'
        ) {
            settleTerminalEvent(payload);
        }
    }

    function publishExternalRuntimeEvent(event: RuntimeEventV1): void {
        for (const subscriber of subscribers) {
            subscriber(event);
        }
        if (
            event.kind === 'turn-complete'
            || event.kind === 'turn-cancelled'
            || event.kind === 'turn-failed'
        ) {
            settleTerminalEvent(event);
        }
    }

    function beginTurnLifecycle(): void {
        assertRuntimeActive(params);
        params.turnAbort?.beginTurn();
        const nextTurn = Object.freeze({
            turnId: randomUUID(),
            providerTurnId: randomUUID(),
        });
        currentTurn = nextTurn;
        pendingCompletion = createCompletion();
        publishRuntimeEvent({
            kind: 'turn-start',
            turnId: nextTurn.turnId,
            providerTurnId: nextTurn.providerTurnId,
            startedBy: 'provider',
        });
    }

    function readCurrentTurn(): ActiveTurnState | null {
        return currentTurn;
    }

    function settleTerminalEvent(event: Extract<RuntimeEventV1, { kind: 'turn-complete' | 'turn-cancelled' | 'turn-failed' }>): void {
        const completion = pendingCompletion;
        params.turnAbort?.settleTurn();
        if (!completion) {
            currentTurn = null;
            return;
        }
        pendingCompletion = null;
        currentTurn = null;
        if (event.kind === 'turn-failed') {
            completion.reject(new Error('ACP turn failed'));
            return;
        }
        completion.resolve();
    }

    function rejectPendingCompletion(error: unknown): void {
        const completion = pendingCompletion;
        if (!completion) {
            return;
        }
        pendingCompletion = null;
        currentTurn = null;
        completion.reject(error);
    }

    function publishMessageDelta(update: unknown): void {
        const turn = readCurrentTurn();
        const delta = readAgentMessageDelta(update);
        if (!turn || delta === null) {
            return;
        }
        publishRuntimeEvent({
            kind: 'message-delta',
            turnId: turn.turnId,
            delta,
        });
    }

    function publishTurnComplete(): void {
        const turn = readCurrentTurn();
        if (!turn) {
            return;
        }
        publishRuntimeEvent({
            kind: 'turn-complete',
            turnId: turn.turnId,
            providerTurnId: turn.providerTurnId,
        });
    }

    function publishTurnFailed(update: unknown): void {
        const turn = readCurrentTurn();
        if (!turn) {
            return;
        }
        const detail = isRecord(update) ? update.detail ?? update.error ?? update.reason : undefined;
        publishRuntimeEvent({
            kind: 'turn-failed',
            turnId: turn.turnId,
            providerTurnId: turn.providerTurnId,
            issue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'acp_turn_failed',
                source: 'provider_session_error',
                occurredAt: Date.now(),
                sanitizedPreview: readString(detail) ?? 'ACP turn failed',
            },
        });
    }

    function handleOneSessionUpdate(update: unknown): void {
        const runtimeEvent = readRuntimeEvent(update);
        if (runtimeEvent) {
            publishExternalRuntimeEvent(runtimeEvent);
            return;
        }
        const sessionUpdateType = readSessionUpdateType(update);
        if (sessionUpdateType && PROMPT_TURN_SESSION_UPDATE_TYPES.has(sessionUpdateType)) {
            publishMessageDelta(update);
            return;
        }
        if (sessionUpdateType && TERMINAL_SESSION_UPDATE_TYPES.has(sessionUpdateType)) {
            publishTurnComplete();
            return;
        }
        if (sessionUpdateType && FAILED_SESSION_UPDATE_TYPES.has(sessionUpdateType)) {
            publishTurnFailed(update);
            return;
        }
        if (readPromptStopReason(update) === 'end_turn') {
            publishTurnComplete();
        }
    }

    function handleSessionUpdate(notification: unknown): void {
        assertRuntimeActive(params);
        for (const update of readSessionUpdates(notification)) {
            handleOneSessionUpdate(update);
        }
    }

    const rejectOnAbort = () => {
        rejectPendingCompletion(params.createDisposedError());
    };
    if (params.signal.aborted) {
        rejectOnAbort();
    } else {
        params.signal.addEventListener('abort', rejectOnAbort, { once: true });
    }

    return Object.freeze({
        beginTurnLifecycle,
        startOrLoadSession,
        async sendTurnPrompt(prompt: string): Promise<void> {
            assertRuntimeActive(params);
            const sessionId = readActiveProviderSessionId();
            const request = await transformAcpAgentRequestBeforeDispatch({
                transformAgentRequestBeforeDispatch: params.transformAgentRequestBeforeDispatch,
                happySessionId: params.sessionId,
                method: ACP_SESSION_PROMPT_METHOD,
                request: {
                    sessionId,
                    prompt: [Object.freeze({ type: 'text', text: prompt })],
                },
            });
            const result = await params.client.request(ACP_SESSION_PROMPT_METHOD, request);
            for (const update of readSessionUpdates(result)) {
                handleOneSessionUpdate(update);
            }
        },
        async waitForTurnCompletion(opts?: AcpSessionRuntimeCompletionOptionsV1): Promise<void> {
            assertRuntimeActive(params);
            const completion = pendingCompletion;
            if (!completion) {
                return;
            }
            await withTimeout(completion.promise, opts);
        },
        subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void {
            subscribers.add(handler);
            return () => {
                subscribers.delete(handler);
            };
        },
        async cancelTurn(): Promise<void> {
            assertRuntimeActive(params);
            const sessionId = readActiveProviderSessionId();
            params.turnAbort?.cancelTurn();
            await params.client.request(ACP_SESSION_CANCEL_METHOD, {
                sessionId,
            });
            const turn = readCurrentTurn();
            if (turn) {
                publishRuntimeEvent({
                    kind: 'turn-cancelled',
                    turnId: turn.turnId,
                    providerTurnId: turn.providerTurnId,
                    reason: 'cancelled',
                });
            }
        },
        async updateSessionRuntimeConfig(update: AcpSessionRuntimeConfigUpdateV1): Promise<void> {
            assertRuntimeActive(params);
            if (
                update.modeId === undefined
                && update.modelId === undefined
                && update.configOption === undefined
            ) {
                return;
            }
            const sessionId = readActiveProviderSessionId();
            if (update.modeId !== undefined) {
                await params.client.request(ACP_SESSION_SET_MODE_METHOD, {
                    sessionId,
                    modeId: update.modeId,
                });
            }
            if (update.modelId !== undefined) {
                await params.client.request(ACP_SESSION_SET_MODEL_METHOD, {
                    sessionId,
                    modelId: update.modelId,
                });
            }
            if (update.configOption && typeof update.configOption.id === 'string') {
                await params.client.request(ACP_SESSION_SET_CONFIG_OPTION_METHOD, {
                    sessionId,
                    configId: update.configOption.id,
                    value: update.configOption.value,
                });
            }
        },
        handleSessionUpdate,
    });
}
