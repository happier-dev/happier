import type {
    ClaudeProviderConfigurationOutcome,
    ClaudeProviderConfigurationUpdate,
    ClaudeProviderDisposeReason,
    ClaudeProviderPermissionResponseOutcome,
    ClaudeProviderPromptDeliveryOutcomeCallback,
    ClaudeRuntimePromptSendMeta as ClaudeProviderPromptSendMeta,
    ClaudeRuntimePromptSubmissionOutcome,
    ClaudeRuntimeTurnOperations as ClaudeProviderOperations,
} from './providerOperations.js';
import { readClaudePendingLocalId } from './providerOperations.js';
import type { ClaudeProviderEvent } from './providerEvents.js';

type ClaudeTestRuntimeDeliveryMode = 'steer' | 'followUp';
type ClaudeTestRuntimeInput = Readonly<{ text?: string }>;
type ClaudeTestRuntimeSendOptions = Readonly<{
    localInputId?: string;
    localInputIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
    deliverAs?: ClaudeTestRuntimeDeliveryMode;
}>;
type ClaudeTestRuntimeSendResult = Readonly<{
    status: 'accepted' | 'unsupported' | 'unavailable' | 'rejected';
    diagnostic?: string;
}>;
type ClaudeTestRuntimeCancelResult = Readonly<{
    status: 'cancelled' | 'not_running' | 'unsupported' | 'unavailable';
    diagnostic?: string;
}>;
type ClaudeTestPermissionDecision = Readonly<{
    requestId: string;
    approved: boolean;
}>;
type ClaudeTestPromptAcceptedInfo = Readonly<{
    localInputId?: string | null;
    localInputIds?: readonly string[];
    userMessageSeq: number | null;
    userMessageSeqs?: readonly number[];
}>;
type ClaudeTestPromptAcceptedCallback = (info: ClaudeTestPromptAcceptedInfo) => void;

export type ClaudeRuntimePromptSendMeta = ClaudeProviderPromptSendMeta;

export type ClaudeRuntimeTurnOperations = Readonly<{
    beginTurnLifecycle(): void;
    startProviderSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null | Readonly<Record<string, unknown>>>;
    sendTurnPrompt(prompt: string, meta?: ClaudeRuntimePromptSendMeta): Promise<ClaudeRuntimePromptSubmissionOutcome>;
    steerInFlightTurn(message: string, meta?: ClaudeRuntimePromptSendMeta): Promise<ClaudeRuntimePromptSubmissionOutcome>;
    waitForTurnCompletion(opts?: Readonly<{ timeoutMs?: number | null }>): Promise<void>;
    subscribeRuntimeEvents(handler: (event: ClaudeProviderEvent) => void): () => void;
    respondToPermission(
        requestId: string,
        approved: boolean,
    ): Promise<ClaudeProviderPermissionResponseOutcome>;
    cancelTurn(): Promise<void>;
    readSessionIdentity(): Readonly<{ sessionId: string | null }>;
    updateSessionRuntimeConfig(
        update: ClaudeProviderConfigurationUpdate,
    ): Promise<ClaudeProviderConfigurationOutcome | void>;
    resetOrDisposeRuntime(
        reason?: ClaudeProviderDisposeReason | Readonly<{ reason?: ClaudeProviderDisposeReason }>,
    ): Promise<void>;
}>;

export function adaptClaudeProviderOperationsForTest<TOperations extends ClaudeProviderOperations>(
    operations: TOperations,
): TOperations & ClaudeRuntimeTurnOperations {
    return Object.freeze({
        ...operations,
        beginTurnLifecycle: () => operations.beginProviderTurn(),
        startProviderSession: async (opts) => await operations.startProviderSession(opts),
        sendTurnPrompt: async (prompt, meta) => await operations.sendProviderTurnPrompt(prompt, meta),
        steerInFlightTurn: async (message, meta) => await operations.steerProviderTurn(message, meta),
        waitForTurnCompletion: async (opts) => await operations.waitForProviderTurnCompletion(opts),
        subscribeRuntimeEvents: (handler) => operations.subscribeProviderEvents(handler),
        respondToPermission: async (requestId, approved) =>
            await operations.respondToProviderPermission(requestId, approved),
        cancelTurn: async () => await operations.cancelProviderTurn(),
        readSessionIdentity: () => operations.readProviderIdentity(),
        updateSessionRuntimeConfig: async (update) => await operations.updateProviderConfiguration(update),
        resetOrDisposeRuntime: async (reason) => await operations.disposeProviderSession(reason),
    });
}

type ClaudeRuntimePromptAcceptedOperations = Readonly<{
    setOnPromptAcceptedByProvider?(handler: ClaudeTestPromptAcceptedCallback | null): void;
    setOnPromptDeliveryOutcome?(handler: ClaudeProviderPromptDeliveryOutcomeCallback | null): void;
}>;

export type ClaudeTestSessionRuntime<TOperations extends ClaudeRuntimeTurnOperations = ClaudeRuntimeTurnOperations> =
    TOperations & Readonly<{
        identity: Readonly<{
            read(): Readonly<{ providerSessionId: string | null }>;
        }>;
        events: Readonly<{
            subscribe(handler: (event: ClaudeProviderEvent) => void): () => void;
        }>;
        send(
            input: ClaudeTestRuntimeInput,
            options?: ClaudeTestRuntimeSendOptions,
        ): Promise<ClaudeTestRuntimeSendResult>;
        cancel(request?: Readonly<Record<string, unknown>>): Promise<ClaudeTestRuntimeCancelResult>;
        permissions: Readonly<{
            capability: 'responds';
            respond(
                decision: ClaudeTestPermissionDecision,
            ): Promise<ClaudeProviderPermissionResponseOutcome>;
        }>;
        updateConfig(
            update: ClaudeProviderConfigurationUpdate,
        ): Promise<ClaudeProviderConfigurationOutcome | void>;
        setOnPromptAcceptedByProvider?(handler: ClaudeTestPromptAcceptedCallback | null): void;
        setOnPromptDeliveryOutcome?(handler: ClaudeProviderPromptDeliveryOutcomeCallback | null): void;
        dispose(reason?: ClaudeProviderDisposeReason): Promise<void>;
    }>;

function readRuntimeInputText(input: ClaudeTestRuntimeInput): string | null {
    const trimmed = typeof input.text === 'string' ? input.text.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function accepted(): ClaudeTestRuntimeSendResult {
    return { status: 'accepted' };
}

function isUserMessageSeq(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeNonEmptyStringList(values: readonly unknown[] | null | undefined): string[] {
    const normalized: string[] = [];
    for (const value of values ?? []) {
        const localId = readClaudePendingLocalId(value);
        if (localId === null || normalized.includes(localId)) continue;
        normalized.push(localId);
    }
    return normalized;
}

function readSendMeta(
    options: ClaudeTestRuntimeSendOptions | undefined,
): ClaudeRuntimePromptSendMeta | undefined {
    const localInputIds: string[] = [];
    const appendLocalId = (value: unknown) => {
        const localId = readClaudePendingLocalId(value);
        if (localId === null || localInputIds.includes(localId)) return;
        localInputIds.push(localId);
    };
    appendLocalId(options?.localInputId);
    for (const localId of options?.localInputIds ?? []) {
        appendLocalId(localId);
    }
    const userMessageSeqs: number[] = [];
    const appendSeq = (value: unknown) => {
        if (!isUserMessageSeq(value) || userMessageSeqs.includes(value)) return;
        userMessageSeqs.push(value);
    };
    const userMessageSeq = options?.userMessageSeq;
    appendSeq(userMessageSeq);
    for (const seq of options?.userMessageSeqs ?? []) {
        appendSeq(seq);
    }
    const meta = {
        ...(localInputIds[0] ? { localId: localInputIds[0] } : {}),
        ...(localInputIds.length === 0 ? {} : { localIds: localInputIds }),
        ...(isUserMessageSeq(userMessageSeq) ? { userMessageSeq } : {}),
        ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
}

function readRuntimePromptAcceptedInfo(
    options: ClaudeTestRuntimeSendOptions | undefined,
): ClaudeTestPromptAcceptedInfo {
    const meta = readSendMeta(options);
    return {
        ...(meta?.localId ? { localInputId: meta.localId } : {}),
        ...(meta?.localIds && meta.localIds.length > 0 ? { localInputIds: meta.localIds } : {}),
        userMessageSeq: isUserMessageSeq(meta?.userMessageSeq) ? meta.userMessageSeq : null,
        ...(meta?.userMessageSeqs && meta.userMessageSeqs.length > 0 ? { userMessageSeqs: meta.userMessageSeqs } : {}),
    };
}

function unsupportedDelivery(
    deliverAs: ClaudeTestRuntimeDeliveryMode,
): ClaudeTestRuntimeSendResult {
    return {
        status: 'unsupported',
        diagnostic: `Claude runtime does not support ${deliverAs} delivery`,
    };
}

function normalizeDisposeReason(
    reason:
        | ClaudeProviderDisposeReason
        | Readonly<{ reason?: ClaudeProviderDisposeReason }>
        | undefined,
): ClaudeProviderDisposeReason | Readonly<{ reason?: ClaudeProviderDisposeReason }> | undefined {
    return reason;
}

export function createClaudeTestSessionRuntime<TOperations extends ClaudeRuntimeTurnOperations>(
    operations: TOperations,
): ClaudeTestSessionRuntime<TOperations> {
    const subscribers = new Set<(event: ClaudeProviderEvent) => void>();
    const operationsPromptAcceptedHandler =
        (operations as TOperations & ClaudeRuntimePromptAcceptedOperations).setOnPromptAcceptedByProvider;
    const usesOperationsPromptAcceptedHandler = typeof operationsPromptAcceptedHandler === 'function';
    const operationsPromptDeliveryOutcomeHandler =
        (operations as TOperations & ClaudeRuntimePromptAcceptedOperations).setOnPromptDeliveryOutcome;
    let promptAcceptedCallback: ClaudeTestPromptAcceptedCallback | null = null;
    const submitPromptWithAcceptanceTracking = async (
        info: ClaudeTestPromptAcceptedInfo,
        submit: () => Promise<ClaudeRuntimePromptSubmissionOutcome>,
    ): Promise<ClaudeRuntimePromptSubmissionOutcome> => {
        const outcome = await submit();
        if (!usesOperationsPromptAcceptedHandler && outcome.kind === 'accepted') {
            promptAcceptedCallback?.(info);
        }
        return outcome;
    };
    const unsubscribeOperations = operations.subscribeRuntimeEvents((event) => {
        for (const subscriber of Array.from(subscribers)) {
            subscriber(event);
        }
    });

    return Object.freeze({
        ...operations,
        identity: Object.freeze({
            read: () => ({
                providerSessionId: operations.readSessionIdentity().sessionId,
            }),
        }),
        events: Object.freeze({
            subscribe: (handler: (event: ClaudeProviderEvent) => void) => {
                subscribers.add(handler);
                return () => {
                    subscribers.delete(handler);
                };
            },
        }),
        async send(
            input: ClaudeTestRuntimeInput,
            options?: ClaudeTestRuntimeSendOptions,
        ): Promise<ClaudeTestRuntimeSendResult> {
            const text = readRuntimeInputText(input);
            if (!text) {
                return {
                    status: 'rejected',
                    diagnostic: 'Claude runtime input did not include text',
                };
            }
            if (options?.deliverAs === 'followUp') return unsupportedDelivery(options.deliverAs);
            const meta = readSendMeta(options);
            const acceptedInfo = readRuntimePromptAcceptedInfo(options);
            if (options?.deliverAs === 'steer') {
                const outcome = await submitPromptWithAcceptanceTracking(
                    acceptedInfo,
                    async () => await operations.steerInFlightTurn(text, meta),
                );
                return outcome.kind === 'rejected_before_effect'
                    ? { status: 'rejected', diagnostic: outcome.reason }
                    : outcome.kind === 'effect_may_have_occurred'
                        ? { status: 'unavailable', diagnostic: outcome.reason }
                        : accepted();
            }
            operations.beginTurnLifecycle();
            const outcome = await submitPromptWithAcceptanceTracking(
                acceptedInfo,
                async () => await operations.sendTurnPrompt(text, meta),
            );
            return outcome.kind === 'rejected_before_effect'
                ? { status: 'rejected', diagnostic: outcome.reason }
                : outcome.kind === 'effect_may_have_occurred'
                    ? { status: 'unavailable', diagnostic: outcome.reason }
                    : accepted();
        },
        async cancel(): Promise<ClaudeTestRuntimeCancelResult> {
            await operations.cancelTurn();
            return { status: 'cancelled' };
        },
        permissions: Object.freeze({
            capability: 'responds' as const,
            respond: async (decision: ClaudeTestPermissionDecision) =>
                await operations.respondToPermission(decision.requestId, decision.approved),
        }),
        updateConfig: async (update) => await operations.updateSessionRuntimeConfig(update),
        setOnPromptAcceptedByProvider(handler) {
            if (usesOperationsPromptAcceptedHandler) {
                operationsPromptAcceptedHandler.call(operations, handler);
                return;
            }
            promptAcceptedCallback = handler;
        },
        setOnPromptDeliveryOutcome(handler) {
            operationsPromptDeliveryOutcomeHandler?.call(operations, handler);
        },
        dispose: async (reason) => {
            if (usesOperationsPromptAcceptedHandler) {
                operationsPromptAcceptedHandler.call(operations, null);
            }
            operationsPromptDeliveryOutcomeHandler?.call(operations, null);
            unsubscribeOperations();
            subscribers.clear();
            promptAcceptedCallback = null;
            await operations.resetOrDisposeRuntime(normalizeDisposeReason(reason));
        },
    }) as ClaudeTestSessionRuntime<TOperations>;
}
