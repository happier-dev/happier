import type { EnhancedMode } from '../loop';
import { hasClaudeQueuedUserTurns, readClaudeResultUserMessageUuids } from './resultTurnBoundary';
import { randomUUID } from 'node:crypto';
import { readPendingLocalId } from '@happier-dev/protocol';
import type { PendingProviderAction } from '@/agent/runtime/modeMessageQueue';

export type ClaudeRemoteProviderPromptAcceptance = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    appliedModelId?: string;
}>;

export type ClaudeRemoteProviderAcceptedPrompt<Mode = EnhancedMode> = Readonly<{
    message: string;
    mode: Mode;
    maxUserMessageSeq?: number | null;
    userMessageLocalIds?: readonly string[] | null;
    providerAcceptancePending?: boolean;
    pendingProviderAction?: PendingProviderAction;
    pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
}>;

export type ClaudeRemoteProviderPromptAttribution = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    providerAcceptancePending: boolean;
    pendingProviderAction?: PendingProviderAction;
    pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
}>;

export function readClaudeRemoteProviderPromptAttribution(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAttribution {
    return {
        ...readClaudeRemoteProviderPromptAcceptance(prompt),
        providerAcceptancePending: prompt.providerAcceptancePending === true,
        ...(prompt.pendingProviderAction ? { pendingProviderAction: prompt.pendingProviderAction } : {}),
        ...(prompt.pendingRequestedAction ? { pendingRequestedAction: prompt.pendingRequestedAction } : {}),
    };
}

export type ClaudeRemoteProviderPromptAcceptedHandler =
    (accepted: ClaudeRemoteProviderPromptAcceptance) => void | Promise<void>;

export type ClaudeRemoteProviderPromptTransportFailure =
    ClaudeRemoteProviderPromptAcceptance & Readonly<{
        kind: 'rejected_before_effect' | 'effect_may_have_occurred';
    }>;

export type ClaudeRemoteProviderPromptTransportFailureHandler =
    (failure: ClaudeRemoteProviderPromptTransportFailure) => void | Promise<void>;

export function readClaudeRemoteProviderPromptAcceptance(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAcceptance {
    const localIds: string[] = [];
    const seenLocalIds = new Set<string>();
    for (const value of prompt.userMessageLocalIds ?? []) {
        const localId = readPendingLocalId(value) ?? '';
        if (!localId || seenLocalIds.has(localId)) continue;
        seenLocalIds.add(localId);
        localIds.push(localId);
    }
    return {
        maxUserMessageSeq: typeof prompt.maxUserMessageSeq === 'number' && Number.isInteger(prompt.maxUserMessageSeq)
            ? prompt.maxUserMessageSeq
            : null,
        userMessageLocalIds: localIds,
    };
}

export function confirmClaudeRemoteProviderPromptAccepted(
    handler: ClaudeRemoteProviderPromptAcceptedHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): void {
    if (!handler) return;
    void Promise.resolve(handler(readClaudeRemoteProviderPromptAcceptance(prompt))).catch(() => {});
}

export function reportClaudeRemoteProviderPromptTransportFailure(
    handler: ClaudeRemoteProviderPromptTransportFailureHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
    kind: ClaudeRemoteProviderPromptTransportFailure['kind'],
): void {
    if (!handler) return;
    void Promise.resolve(handler({
        kind,
        ...readClaudeRemoteProviderPromptAcceptance(prompt),
    })).catch(() => {});
}

/**
 * Owns settlement for prompts claimed from Happier's durable pending queue.
 *
 * Both remote runtimes request Claude's supported --replay-user-messages acknowledgment.
 * Enqueuing input locally, reading the iterable and writing stdin cannot prove that
 * Claude accepted it. An exact main-chain user echo or an attributed result answering
 * that UUID settles Pending and permits replay-seed retirement. Result custody remains
 * separate: a delivery echo does not complete a turn. Unified TUI injection has its own
 * provider-evidence owner and deliberately does not use this tracker.
 */
export function createClaudeRemotePromptSettlementTracker(options: Readonly<{
    onAccepted?: ClaudeRemoteProviderPromptAcceptedHandler | null;
    onTransportFailure?: ClaudeRemoteProviderPromptTransportFailureHandler | null;
}>) {
    const unresolved = new Map<ClaudeRemoteProviderAcceptedPrompt, string | null>();
    const awaitingResultUuids = new Set<string>();
    let latestSubmittedUuid: string | null = null;

    const remove = (prompt: ClaudeRemoteProviderAcceptedPrompt): boolean => unresolved.delete(prompt);
    const rejectBeforeEffect = (prompt: ClaudeRemoteProviderAcceptedPrompt): void => {
        if (!remove(prompt)) return;
        reportClaudeRemoteProviderPromptTransportFailure(
            options.onTransportFailure,
            prompt,
            'rejected_before_effect',
        );
    };

    return {
        track(prompt: ClaudeRemoteProviderAcceptedPrompt): void {
            unresolved.set(prompt, null);
        },
        submit(prompt: ClaudeRemoteProviderAcceptedPrompt): string {
            if (!unresolved.has(prompt)) throw new Error('Cannot submit an untracked Claude prompt');
            const uuid = randomUUID();
            unresolved.set(prompt, uuid);
            awaitingResultUuids.add(uuid);
            latestSubmittedUuid = uuid;
            return uuid;
        },
        observeProviderMessage(message: unknown): boolean {
            if (!message || typeof message !== 'object') return false;
            const record = message as Record<string, unknown>;
            if ((record.type !== 'user' && record.type !== 'result') || record.isSynthetic === true || record.parent_tool_use_id != null) return false;
            const acknowledgedUuids = record.type === 'user' && typeof record.uuid === 'string'
                ? [record.uuid]
                : readClaudeResultUserMessageUuids(message);
            if (acknowledgedUuids.length === 0) return false;
            let accepted = false;
            for (const [prompt, uuid] of unresolved) {
                if (uuid === null || !acknowledgedUuids.includes(uuid)) continue;
                unresolved.delete(prompt);
                confirmClaudeRemoteProviderPromptAccepted(options.onAccepted, prompt);
                accepted = true;
            }
            // Callers suppress acknowledged user echoes, but still publish result output.
            return accepted && record.type === 'user';
        },
        /** Called once by the ordered result consumer, separately from raw delivery observation. */
        shouldRetainForegroundForResult(message: unknown): boolean {
            const hasQueuedUserTurns = hasClaudeQueuedUserTurns(message);
            const answeredUuids = readClaudeResultUserMessageUuids(message);
            if (answeredUuids.length === 0) {
                // Older native producers lack attribution. Preserve their existing queue boundary.
                if (!hasQueuedUserTurns) {
                    awaitingResultUuids.clear();
                    latestSubmittedUuid = null;
                }
                return hasQueuedUserTurns;
            }
            if (awaitingResultUuids.size === 0) return hasQueuedUserTurns;
            for (const uuid of answeredUuids) awaitingResultUuids.delete(uuid);
            if (!hasQueuedUserTurns && latestSubmittedUuid !== null && !awaitingResultUuids.has(latestSubmittedUuid)) {
                // The latest send has its own result. Keep the existing empty-queue closeout for
                // older IDs omitted by native attribution's 64-entry limit; this is not delivery proof.
                awaitingResultUuids.clear();
            }
            return awaitingResultUuids.size > 0;
        },
        /** Commands handled locally have no provider transport to acknowledge. */
        accept(prompt: ClaudeRemoteProviderAcceptedPrompt): void {
            if (!remove(prompt)) return;
            confirmClaudeRemoteProviderPromptAccepted(options.onAccepted, prompt);
        },
        rejectBeforeEffect,
        settleUnresolved(): void {
            for (const [prompt, uuid] of unresolved) {
                unresolved.delete(prompt);
                reportClaudeRemoteProviderPromptTransportFailure(
                    options.onTransportFailure,
                    prompt,
                    uuid === null ? 'rejected_before_effect' : 'effect_may_have_occurred',
                );
            }
        },
    };
}
