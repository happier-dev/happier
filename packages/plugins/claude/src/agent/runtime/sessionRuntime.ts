import type {
    RuntimeCancelResultV1,
    RuntimeConfigUpdateOutcomeV1,
    RuntimeDeliveryModeV1,
    RuntimeDisposeReasonV1,
    RuntimeEventV1,
    RuntimeInputPayloadV1,
    RuntimePermissionResponseDecisionV1,
    RuntimePermissionResponseOutcomeV1,
    RuntimeSendOptionsV1,
    RuntimeSendResultV1,
    SessionRuntimeConfigUpdateV1,
    SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import type {
    RuntimePromptAcceptedCallbackV1,
    RuntimePromptAcceptedInfoV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

export type ClaudeRuntimeTurnOperations = Readonly<{
    beginTurnLifecycle(): void;
    startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null | Readonly<Record<string, unknown>>>;
    sendTurnPrompt(prompt: string, meta?: ClaudeRuntimePromptSendMeta): Promise<void>;
    steerInFlightTurn(message: string, meta?: ClaudeRuntimePromptSendMeta): Promise<void>;
    waitForTurnCompletion(opts?: Readonly<{ timeoutMs?: number | null }>): Promise<void>;
    subscribeRuntimeEvents(handler: (event: RuntimeEventV1) => void): () => void;
    respondToPermission(requestId: string, approved: boolean): Promise<RuntimePermissionResponseOutcomeV1>;
    cancelTurn(): Promise<void>;
    readSessionIdentity(): Readonly<{ sessionId: string | null }>;
    updateSessionRuntimeConfig(
        update: SessionRuntimeConfigUpdateV1 & Readonly<Record<string, unknown>>,
    ): Promise<RuntimeConfigUpdateOutcomeV1 | void>;
    resetOrDisposeRuntime(reason?: RuntimeDisposeReasonV1 | Readonly<{ reason?: RuntimeDisposeReasonV1 }>): Promise<void>;
}>;

export type ClaudeRuntimePromptSendMeta = Readonly<{
    localId?: string | null;
    localIds?: readonly string[];
    providerClaimedPendingLocalIds?: readonly string[];
    userMessageSeq?: number | null;
    userMessageSeqs?: readonly number[];
}>;

type ClaudeRuntimePromptAcceptedOperations = Readonly<{
    setOnPromptAcceptedByProvider?(handler: RuntimePromptAcceptedCallbackV1 | null): void;
}>;

type PendingPromptAcceptance = {
    info: RuntimePromptAcceptedInfoV1;
    providerEvidenceObserved: boolean;
    submitted: boolean;
};

export type ClaudePublicSessionRuntime<TOperations extends ClaudeRuntimeTurnOperations = ClaudeRuntimeTurnOperations> =
    SessionRuntimeV1 & TOperations;

function readRuntimeInputText(input: RuntimeInputPayloadV1): string | null {
    const trimmed = typeof input.text === 'string' ? input.text.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function accepted(): RuntimeSendResultV1 {
    return { status: 'accepted' };
}

function isUserMessageSeq(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeNonEmptyStringList(values: readonly unknown[] | null | undefined): string[] {
    const normalized: string[] = [];
    for (const value of values ?? []) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || normalized.includes(text)) continue;
        normalized.push(text);
    }
    return normalized;
}

function readSendMeta(options: RuntimeSendOptionsV1 | undefined): ClaudeRuntimePromptSendMeta | undefined {
    const localInputIds: string[] = [];
    const appendLocalId = (value: unknown) => {
        const localId = typeof value === 'string' ? value.trim() : '';
        if (!localId || localInputIds.includes(localId)) return;
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
    const providerClaimedPendingLocalIds = normalizeNonEmptyStringList(options?.providerClaimedPendingLocalIds);
    const meta = {
        ...(localInputIds[0] ? { localId: localInputIds[0] } : {}),
        ...(localInputIds.length === 0 ? {} : { localIds: localInputIds }),
        ...(providerClaimedPendingLocalIds.length === 0 ? {} : { providerClaimedPendingLocalIds }),
        ...(isUserMessageSeq(userMessageSeq) ? { userMessageSeq } : {}),
        ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
}

function readRuntimePromptAcceptedInfo(options: RuntimeSendOptionsV1 | undefined): RuntimePromptAcceptedInfoV1 {
    const meta = readSendMeta(options);
    return {
        ...(meta?.localId ? { localInputId: meta.localId } : {}),
        ...(meta?.localIds && meta.localIds.length > 0 ? { localInputIds: meta.localIds } : {}),
        userMessageSeq: isUserMessageSeq(meta?.userMessageSeq) ? meta.userMessageSeq : null,
        ...(meta?.userMessageSeqs && meta.userMessageSeqs.length > 0 ? { userMessageSeqs: meta.userMessageSeqs } : {}),
    };
}

function isProviderAcceptanceEvidenceEvent(event: RuntimeEventV1): boolean {
    return event.kind === 'message-delta'
        || event.kind === 'tool-call'
        || event.kind === 'tool-result'
        || event.kind === 'tool-progress'
        || event.kind === 'turn-agent-id-observed'
        || event.kind === 'turn-progress'
        || event.kind === 'turn-complete'
        || event.kind === 'turn-failed'
        || event.kind === 'turn-cancelled';
}

function unsupportedDelivery(deliverAs: RuntimeDeliveryModeV1): RuntimeSendResultV1 {
    return {
        status: 'unsupported',
        diagnostic: `Claude runtime does not support ${deliverAs} delivery`,
    };
}

function normalizeDisposeReason(
    reason: RuntimeDisposeReasonV1 | Readonly<{ reason?: RuntimeDisposeReasonV1 }> | undefined,
): RuntimeDisposeReasonV1 | Readonly<{ reason?: RuntimeDisposeReasonV1 }> | undefined {
    return reason;
}

export function createClaudePublicSessionRuntime<TOperations extends ClaudeRuntimeTurnOperations>(
    operations: TOperations,
): ClaudePublicSessionRuntime<TOperations> {
    const subscribers = new Set<(event: RuntimeEventV1) => void>();
    const operationsPromptAcceptedHandler =
        (operations as TOperations & ClaudeRuntimePromptAcceptedOperations).setOnPromptAcceptedByProvider;
    const usesOperationsPromptAcceptedHandler = typeof operationsPromptAcceptedHandler === 'function';
    let promptAcceptedCallback: RuntimePromptAcceptedCallbackV1 | null = null;
    const pendingPromptAcceptances: PendingPromptAcceptance[] = [];
    const flushProviderAcceptedPrompts = (): void => {
        const accepted = pendingPromptAcceptances.filter((pending) =>
            pending.submitted && pending.providerEvidenceObserved);
        for (const pending of accepted) {
            const index = pendingPromptAcceptances.indexOf(pending);
            if (index >= 0) pendingPromptAcceptances.splice(index, 1);
            promptAcceptedCallback?.(pending.info);
        }
    };
    const observeProviderAcceptanceEvidence = (event: RuntimeEventV1): void => {
        if (usesOperationsPromptAcceptedHandler || !isProviderAcceptanceEvidenceEvent(event)) return;
        for (const pending of pendingPromptAcceptances) {
            pending.providerEvidenceObserved = true;
        }
        flushProviderAcceptedPrompts();
    };
    const enqueuePromptAcceptance = (info: RuntimePromptAcceptedInfoV1): PendingPromptAcceptance => {
        const pending = {
            info,
            providerEvidenceObserved: false,
            submitted: false,
        };
        pendingPromptAcceptances.push(pending);
        return pending;
    };
    const markPromptSubmitted = (pending: PendingPromptAcceptance): void => {
        pending.submitted = true;
        flushProviderAcceptedPrompts();
    };
    const removePendingPromptAcceptance = (pending: PendingPromptAcceptance): void => {
        const index = pendingPromptAcceptances.indexOf(pending);
        if (index >= 0) pendingPromptAcceptances.splice(index, 1);
    };
    const submitPromptWithAcceptanceTracking = async (
        info: RuntimePromptAcceptedInfoV1,
        submit: () => Promise<void>,
    ): Promise<void> => {
        if (usesOperationsPromptAcceptedHandler) {
            await submit();
            return;
        }
        const pending = enqueuePromptAcceptance(info);
        try {
            await submit();
            markPromptSubmitted(pending);
        } catch (error) {
            removePendingPromptAcceptance(pending);
            throw error;
        }
    };
    const unsubscribeOperations = operations.subscribeRuntimeEvents((event) => {
        observeProviderAcceptanceEvidence(event);
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
            subscribe: (handler: (event: RuntimeEventV1) => void) => {
                subscribers.add(handler);
                return () => {
                    subscribers.delete(handler);
                };
            },
        }),
        async send(input: RuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1> {
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
                await submitPromptWithAcceptanceTracking(acceptedInfo, async () => {
                    await operations.steerInFlightTurn(text, meta);
                });
                return accepted();
            }
            operations.beginTurnLifecycle();
            await submitPromptWithAcceptanceTracking(acceptedInfo, async () => {
                await operations.sendTurnPrompt(text, meta);
            });
            return accepted();
        },
        async cancel(): Promise<RuntimeCancelResultV1> {
            await operations.cancelTurn();
            return { status: 'cancelled' };
        },
        permissions: Object.freeze({
            capability: 'responds' as const,
            respond: async (decision: RuntimePermissionResponseDecisionV1) =>
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
        dispose: async (reason) => {
            if (usesOperationsPromptAcceptedHandler) {
                operationsPromptAcceptedHandler.call(operations, null);
            }
            unsubscribeOperations();
            subscribers.clear();
            pendingPromptAcceptances.length = 0;
            promptAcceptedCallback = null;
            await operations.resetOrDisposeRuntime(normalizeDisposeReason(reason));
        },
    }) as ClaudePublicSessionRuntime<TOperations>;
}
