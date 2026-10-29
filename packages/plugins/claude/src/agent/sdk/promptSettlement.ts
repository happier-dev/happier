import type { SDKMessage } from './types.js';

export type ClaudeSdkPromptTransportOutcome =
    | Readonly<{ kind: 'accepted' }>
    | Readonly<{ kind: 'rejected_before_effect'; error: Error }>
    | Readonly<{ kind: 'effect_may_have_occurred'; error: Error }>;

function readResultUserMessageUuids(message: SDKMessage): readonly string[] {
    if (message.type !== 'result' || message.isSynthetic === true || message.parent_tool_use_id != null) return [];
    if (Array.isArray(message.user_message_uuids)) {
        return message.user_message_uuids.filter((uuid): uuid is string => typeof uuid === 'string' && uuid.length > 0);
    }
    return typeof message.user_message_uuid === 'string' && message.user_message_uuid.length > 0
        ? [message.user_message_uuid]
        : [];
}

/** Native receipt settlement and ordered result attribution share the submitted UUIDs. */
export function createClaudePromptSettlementTracker() {
    const pendingAcknowledgements = new Map<string, (outcome: ClaudeSdkPromptTransportOutcome) => void>();
    const submitted = new Map<string, boolean>();
    let latestSubmittedUuid: string | null = null;

    function clearResults(): void {
        submitted.clear();
        latestSubmittedUuid = null;
    }

    function forgetSubmission(uuid: string): void {
        submitted.delete(uuid);
        if (latestSubmittedUuid === uuid) {
            latestSubmittedUuid = null;
            for (const submittedUuid of submitted.keys()) latestSubmittedUuid = submittedUuid;
        }
    }

    function settleSubmission(uuid: string, outcome: ClaudeSdkPromptTransportOutcome): void {
        const resolve = pendingAcknowledgements.get(uuid);
        if (!resolve) return;
        pendingAcknowledgements.delete(uuid);
        if (outcome.kind === 'rejected_before_effect') forgetSubmission(uuid);
        resolve(outcome);
    }

    return {
        hasPendingAcknowledgement(uuid: string): boolean {
            return pendingAcknowledgements.has(uuid);
        },
        registerSubmission(uuid: string, resolve: (outcome: ClaudeSdkPromptTransportOutcome) => void): void {
            pendingAcknowledgements.set(uuid, resolve);
            submitted.set(uuid, false);
            latestSubmittedUuid = uuid;
        },
        settleSubmission,
        settlePending(error: Error): void {
            for (const uuid of pendingAcknowledgements.keys()) {
                settleSubmission(uuid, { kind: 'effect_may_have_occurred', error });
            }
        },
        observeMessage(message: SDKMessage): void {
            if (message.isSynthetic === true || message.parent_tool_use_id != null) return;
            if (message.type === 'user' && typeof message.uuid === 'string') {
                settleSubmission(message.uuid, { kind: 'accepted' });
            } else {
                for (const uuid of readResultUserMessageUuids(message)) settleSubmission(uuid, { kind: 'accepted' });
            }
        },
        // Consume in runtime order: raw receipt ingress can read ahead of an earlier result.
        shouldRetainForegroundForResult(message: SDKMessage): boolean {
            const count = message.queued_turn_count;
            const hasQueuedTurns = typeof count === 'number' && Number.isSafeInteger(count) && count > 0;
            const uuids = readResultUserMessageUuids(message);
            if (uuids.length === 0) {
                if (!hasQueuedTurns) clearResults();
                return hasQueuedTurns;
            }
            if (submitted.size === 0) return hasQueuedTurns;
            for (const uuid of uuids) {
                if (submitted.has(uuid)) submitted.set(uuid, true);
            }
            // Native result UUID lists are capped. Preserve empty-queue closeout for
            // omitted older IDs only after the latest submitted input has an answer.
            if (!hasQueuedTurns && latestSubmittedUuid !== null && submitted.get(latestSubmittedUuid) === true) {
                clearResults();
                return false;
            }
            for (const answered of submitted.values()) {
                if (!answered) return true;
            }
            clearResults();
            return false;
        },
    };
}
