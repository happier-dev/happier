import { randomUUID } from 'node:crypto';

import {
    createSessionTurnMutation,
    type SessionTurnMutationV1,
} from '@/api/session/mutations/sessionMutationTypes';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type {
    PrimaryTurnStatusV1,
    SessionRuntimeIssueV1,
    SessionTurnTranscriptAnchorsV1,
} from '@happier-dev/protocol';

import type {
    AppendTranscriptAnchorsInput,
    AttachProviderTurnIdInput,
    BeginTurnInput,
    CancelTurnInput,
    CompleteTurnInput,
    EndSessionInput,
    FailTurnInput,
    MarkRollbackEligibleInput,
    MarkRolledBackInput,
    ObserveAcpLifecycleMarkerResult,
    SessionTurnHandle,
    SessionTurnLifecycleControllerWithActiveTurnWitness,
    SessionTurnTerminalStatus,
    SessionTurnTranscriptAnchorsInput,
    TouchActiveTurnInput,
} from './types';

const DEFAULT_ACTIVE_TURN_TOUCH_INTERVAL_MS = 60_000;

type MutableTurn = {
    turnId: string;
    provider?: string;
    providerTurnId?: string;
    terminalStatus?: SessionTurnTerminalStatus;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
};

type CreateSessionTurnLifecycleParams = Readonly<{
    sessionId: string;
    enqueueSessionTurn: (mutation: SessionTurnMutationV1) => Promise<void>;
    createId?: () => string;
    now?: () => number;
    activeTurnTouchIntervalMs?: number;
    onTurnFailure?: (issue: SessionRuntimeIssueV1) => void;
    onTurnLifecycleEvent?: (
        event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
        // REV-1: failTurn / turn_failed markers emit `assistant_message_end` too; the
        // terminal status lets daemon consumers distinguish completion from failure.
        terminalStatus?: 'completed' | 'failed',
        turnId?: string,
    ) => void;
}>;

function normalizeOptionalString(value: string | null | undefined): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : undefined;
}

function createSessionOwnedTurnId(createId: () => string): string {
    return `session-turn:${createId()}`;
}

function toHandle(turn: MutableTurn): SessionTurnHandle {
    return {
        turnId: turn.turnId,
        ...(turn.provider ? { provider: turn.provider } : {}),
        ...(turn.providerTurnId ? { providerTurnId: turn.providerTurnId } : {}),
    };
}

function mutationActionForStatus(status: PrimaryTurnStatusV1): SessionTurnMutationV1['action'] {
    if (status === 'in_progress') return 'begin';
    if (status === 'completed') return 'complete';
    if (status === 'failed') return 'fail';
    return 'cancel';
}

function createSyntheticIssue(params: Readonly<{
    provider?: string;
    providerTurnId?: string;
    observedAt: number;
}>): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_turn_failed',
        source: 'unknown',
        occurredAt: params.observedAt,
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.providerTurnId ? { providerTurnId: params.providerTurnId } : {}),
        sanitizedPreview: 'Provider reported turn failure',
    };
}

function normalizeTranscriptAnchors(
    anchors: SessionTurnTranscriptAnchorsInput | undefined,
): SessionTurnTranscriptAnchorsV1 | undefined {
    if (!anchors) return undefined;
    const {
        startUserMessageSeq,
        startSeqInclusive,
        ...rest
    } = anchors;
    return {
        ...rest,
        ...(typeof startUserMessageSeq === 'number' ? { startUserMessageSeq } : {}),
        ...(typeof startSeqInclusive === 'number' ? { startSeqInclusive } : {}),
    };
}

function isAcpLifecycleMarker(body: ACPMessageData): body is Extract<ACPMessageData, { id: string }> {
    return (
        body.type === 'task_started'
        || body.type === 'task_complete'
        || body.type === 'turn_failed'
        || body.type === 'turn_cancelled'
        || body.type === 'turn_aborted'
    );
}

function withLifecycleMarkerId<T extends Extract<ACPMessageData, { id: string }>>(body: T, id: string): T {
    return { ...body, id } as T;
}

export function createSessionTurnLifecycle(
    params: CreateSessionTurnLifecycleParams,
): SessionTurnLifecycleControllerWithActiveTurnWitness {
    const createId = params.createId ?? randomUUID;
    const now = params.now ?? Date.now;
    const activeTurnTouchIntervalMs = Math.max(
        0,
        Math.trunc(params.activeTurnTouchIntervalMs ?? DEFAULT_ACTIVE_TURN_TOUCH_INTERVAL_MS),
    );
    let activeTurn: MutableTurn | null = null;
    let lastTerminalTurn: MutableTurn | null = null;
    let lastActiveTurnTouchAt: number | null = null;
    const terminalWrites = new Set<string>();

    function emitTurnLifecycleEvent(
        event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
        terminalStatus?: 'completed' | 'failed',
        turnId?: string,
    ): void {
        try {
            params.onTurnLifecycleEvent?.(event, terminalStatus, turnId);
        } catch {
            // Turn lifecycle observer callbacks are best-effort only.
        }
    }

    function emitTerminalTurnLifecycleEvent(status: SessionTurnTerminalStatus, turnId?: string): void {
        if (status === 'cancelled') {
            emitTurnLifecycleEvent('turn_cancelled', undefined, turnId);
            return;
        }
        emitTurnLifecycleEvent(
            'assistant_message_end',
            status === 'failed' ? 'failed' : 'completed',
            turnId,
        );
    }

    function emitBeginTurnAfterWrite(
        result: Readonly<{ turn: MutableTurn; pendingWrite: Promise<void> }>,
        event: 'prompt_or_steer' | 'task_started',
    ): Promise<void> {
        return result.pendingWrite.then(
            () => {
                emitTurnLifecycleEvent(event, undefined, result.turn.turnId);
            },
            (error) => {
                emitTurnLifecycleEvent(event);
                throw error;
            },
        );
    }

    async function awaitTerminalTurnWriteAndEmit(
        result: Readonly<{ turn: MutableTurn | null; pendingWrite: Promise<void> | null }>,
        status: SessionTurnTerminalStatus,
        beforeWrite?: Promise<void> | null,
    ): Promise<void> {
        let firstError: unknown = null;
        if (beforeWrite) {
            try {
                await beforeWrite;
            } catch (error) {
                firstError = error;
            }
        }

        if (!result.pendingWrite || !result.turn) {
            if (firstError !== null) throw firstError;
            return;
        }

        let terminalWriteAccepted = false;
        try {
            await result.pendingWrite;
            terminalWriteAccepted = true;
            if (status === 'failed' && result.turn.lastRuntimeIssue) {
                params.onTurnFailure?.(result.turn.lastRuntimeIssue);
            }
        } catch (error) {
            firstError ??= error;
        } finally {
            emitTerminalTurnLifecycleEvent(
                status,
                terminalWriteAccepted ? result.turn.turnId : undefined,
            );
        }

        if (firstError !== null) {
            throw firstError;
        }
    }

    function createTurn(input: Readonly<{
        provider?: string | null;
        providerTurnId?: string | null;
    }>): MutableTurn {
        return {
            turnId: createSessionOwnedTurnId(createId),
            ...normalizeProviderFacts(input),
        };
    }

    function normalizeProviderFacts(input: Readonly<{
        provider?: string | null;
        providerTurnId?: string | null;
    }>): Pick<MutableTurn, 'provider' | 'providerTurnId'> {
        const provider = normalizeOptionalString(input.provider);
        const providerTurnId = normalizeOptionalString(input.providerTurnId);
        return {
            ...(provider ? { provider } : {}),
            ...(providerTurnId ? { providerTurnId } : {}),
        };
    }

    function mergeProviderFacts(
        turn: MutableTurn,
        input: Readonly<{ provider?: string | null; providerTurnId?: string | null }>,
    ): void {
        const facts = normalizeProviderFacts(input);
        if (facts.provider && !turn.provider) {
            turn.provider = facts.provider;
        }
        if (facts.providerTurnId && !turn.providerTurnId) {
            turn.providerTurnId = facts.providerTurnId;
        }
    }

    function resolveTerminalProviderTurnId(
        turn: MutableTurn,
        input: Readonly<{ providerTurnId?: string | null }>,
    ): string | undefined {
        if (turn.providerTurnId) return turn.providerTurnId;
        return normalizeOptionalString(input.providerTurnId);
    }

    function enqueue(mutation: SessionTurnMutationV1): Promise<void> {
        return params.enqueueSessionTurn(mutation);
    }

    function buildMutation(input: Readonly<{
        action: SessionTurnMutationV1['action'];
        turn: MutableTurn;
        provider?: string | null;
        providerTurnId?: string | null;
        issue?: SessionRuntimeIssueV1 | null;
        transcriptAnchors?: SessionTurnTranscriptAnchorsInput;
        observedAt?: number;
        mutationId?: string;
    }>): SessionTurnMutationV1 {
        const observedAt = input.observedAt ?? now();
        const provider = normalizeOptionalString(input.provider) ?? input.turn.provider;
        const providerTurnId = input.action === 'begin'
            ? normalizeOptionalString(input.providerTurnId) ?? input.turn.providerTurnId
            : resolveTerminalProviderTurnId(input.turn, input);
        return createSessionTurnMutation({
            sessionId: params.sessionId,
            action: input.action,
            turnId: input.turn.turnId,
            provider,
            providerTurnId,
            ...('issue' in input && input.issue ? { issue: input.issue } : {}),
            ...(input.transcriptAnchors !== undefined ? { transcriptAnchors: normalizeTranscriptAnchors(input.transcriptAnchors) } : {}),
            mutationId: input.mutationId,
            observedAt,
        });
    }

    function createTurnReference(input: Readonly<{
        turnId: string;
        provider?: string | null;
        providerTurnId?: string | null;
    }>): MutableTurn {
        return {
            turnId: input.turnId,
            ...normalizeProviderFacts(input),
        };
    }

    function beginTurnSync(input: BeginTurnInput): { turn: MutableTurn; pendingWrite: Promise<void> } {
        if (!activeTurn || activeTurn.terminalStatus) {
            activeTurn = createTurn(input);
            lastActiveTurnTouchAt = input.observedAt ?? now();
        } else {
            mergeProviderFacts(activeTurn, input);
        }
        const mutation = buildMutation({
            action: 'begin',
            turn: activeTurn,
            provider: input.provider,
            providerTurnId: input.providerTurnId,
            transcriptAnchors: input.transcriptAnchors,
            observedAt: input.observedAt,
        });
        return { turn: activeTurn, pendingWrite: enqueue(mutation) };
    }

    function terminalTurnSync(input: Readonly<{
        status: SessionTurnTerminalStatus;
        provider?: string | null;
        providerTurnId?: string | null;
        issue?: SessionRuntimeIssueV1 | null;
        observedAt?: number;
        suppressUntrustedDuplicate?: boolean;
    }>): { turn: MutableTurn | null; pendingWrite: Promise<void> | null } {
        const providerTurnId = normalizeOptionalString(input.providerTurnId);
        if (!activeTurn && input.suppressUntrustedDuplicate && !providerTurnId && lastTerminalTurn?.terminalStatus === input.status) {
            return { turn: lastTerminalTurn, pendingWrite: null };
        }
        if (!activeTurn) {
            return { turn: null, pendingWrite: null };
        }

        const turn = activeTurn;
        mergeProviderFacts(turn, input);
        const observedAt = input.observedAt ?? now();
        const issue = input.status === 'failed'
            ? input.issue ?? createSyntheticIssue({
                provider: normalizeOptionalString(input.provider) ?? turn.provider,
                providerTurnId: turn.providerTurnId ?? providerTurnId,
                observedAt,
            })
            : input.issue;
        const terminalKey = `${turn.turnId}:${input.status}`;
        if (terminalWrites.has(terminalKey)) {
            return { turn, pendingWrite: null };
        }

        terminalWrites.add(terminalKey);
        turn.terminalStatus = input.status;
        turn.lastRuntimeIssue = issue ?? null;
        activeTurn = null;
        lastActiveTurnTouchAt = null;
        lastTerminalTurn = turn;
        return {
            turn,
            pendingWrite: enqueue(buildMutation({
                action: mutationActionForStatus(input.status),
                turn,
                provider: input.provider,
                providerTurnId: input.providerTurnId,
                issue: input.status === 'failed' ? issue ?? null : null,
                observedAt,
            })),
        };
    }

    async function beginTurn(input: BeginTurnInput): Promise<SessionTurnHandle> {
        const result = beginTurnSync(input);
        await emitBeginTurnAfterWrite(result, 'prompt_or_steer');
        return toHandle(result.turn);
    }

    async function attachProviderTurnId(input: AttachProviderTurnIdInput): Promise<void> {
        const turn = activeTurn;
        if (!turn) return;
        mergeProviderFacts(turn, input);
        await enqueue(buildMutation({
            action: 'attach_provider_turn_id',
            turn,
            provider: input.provider,
            providerTurnId: input.providerTurnId,
            observedAt: input.observedAt,
        }));
    }

    async function appendTranscriptAnchors(input: AppendTranscriptAnchorsInput): Promise<void> {
        const turnId = normalizeOptionalString(input.turnId);
        const turn = turnId
            ? activeTurn?.turnId === turnId
                ? activeTurn
                : createTurnReference({
                    turnId,
                    provider: input.provider,
                    providerTurnId: input.providerTurnId,
                })
            : activeTurn;
        if (!turn) return;
        mergeProviderFacts(turn, input);
        await enqueue(buildMutation({
            action: 'append_transcript_anchors',
            turn,
            provider: input.provider,
            providerTurnId: input.providerTurnId,
            transcriptAnchors: input.transcriptAnchors,
            observedAt: input.observedAt,
        }));
    }

    async function touchActiveTurn(input: TouchActiveTurnInput = {}): Promise<void> {
        const turn = activeTurn;
        if (!turn) return;
        const observedAt = input.observedAt ?? now();
        if (
            input.force !== true
            && lastActiveTurnTouchAt !== null
            && observedAt - lastActiveTurnTouchAt < activeTurnTouchIntervalMs
        ) {
            return;
        }
        mergeProviderFacts(turn, input);
        lastActiveTurnTouchAt = observedAt;
        await enqueue(buildMutation({
            action: 'touch_active',
            turn,
            provider: input.provider,
            providerTurnId: input.providerTurnId,
            observedAt,
        }));
    }

    async function completeTurn(input: CompleteTurnInput = {}): Promise<void> {
        const result = terminalTurnSync({ ...input, status: 'completed' });
        await awaitTerminalTurnWriteAndEmit(result, 'completed');
    }

    async function failTurn(input: FailTurnInput): Promise<void> {
        let allocatedWrite: Promise<void> | null = null;
        const previousIssue = lastTerminalTurn?.lastRuntimeIssue;
        const reuseFailedTurn = input.suppressUntrustedDuplicate === true
            && !activeTurn && !normalizeOptionalString(input.providerTurnId)
            && lastTerminalTurn?.terminalStatus === 'failed'
            && previousIssue?.code === input.issue?.code
            && previousIssue?.source === input.issue?.source
            && previousIssue?.provider === input.issue?.provider;
        if (!activeTurn && input.allocateWhenIdle && !reuseFailedTurn) {
            // Session-scoped failure with no active turn (e.g. host death between
            // turns): allocate a session-owned turn so the failure surfaces, but do
            // NOT emit a misleading 'prompt_or_steer' observer event.
            const begun = beginTurnSync({
                provider: input.provider,
                providerTurnId: input.providerTurnId,
                observedAt: input.observedAt,
            });
            allocatedWrite = begun.pendingWrite;
        }
        const result = terminalTurnSync({ ...input, status: 'failed', suppressUntrustedDuplicate: reuseFailedTurn });
        if (result.turn?.lastRuntimeIssue) {
            input.onFailureTurn?.({ turnId: result.turn.turnId, issue: result.turn.lastRuntimeIssue });
        }
        await awaitTerminalTurnWriteAndEmit(result, 'failed', allocatedWrite);
    }

    async function cancelTurn(input: CancelTurnInput = {}): Promise<void> {
        const result = terminalTurnSync({ ...input, status: 'cancelled' });
        await awaitTerminalTurnWriteAndEmit(result, 'cancelled');
    }

    async function endSession(input: EndSessionInput = {}): Promise<void> {
        if (!activeTurn) return;
        await cancelTurn({ observedAt: input.observedAt });
    }

    async function markRollbackEligible(input: MarkRollbackEligibleInput): Promise<void> {
        const observedAt = input.observedAt ?? now();
        await enqueue({
            ...buildMutation({
                action: 'mark_rollback_eligible',
                turn: createTurnReference(input),
                provider: input.provider,
                transcriptAnchors: input.transcriptAnchors,
                observedAt,
            }),
        });
    }

    async function markRolledBack(input: MarkRolledBackInput): Promise<void> {
        const observedAt = input.observedAt ?? now();
        await enqueue({
            ...buildMutation({
                action: 'mark_rolled_back',
                turn: createTurnReference(input),
                provider: input.provider,
                observedAt,
            }),
        });
    }

    function hasActiveTurn(): boolean {
        return activeTurn !== null;
    }

    function getActiveTurnId(): string | null {
        return activeTurn?.turnId ?? null;
    }

    function observeAcpLifecycleMarker(input: Readonly<{
        provider: ACPProvider;
        body: ACPMessageData;
    }>): ObserveAcpLifecycleMarkerResult {
        if (!isAcpLifecycleMarker(input.body)) {
            return { body: input.body, pendingWrite: null };
        }

        const providerTurnId = normalizeOptionalString(input.body.id);
        if (input.body.type === 'task_started') {
            const result = beginTurnSync({
                provider: input.provider,
                providerTurnId,
            });
            return {
                body: withLifecycleMarkerId(input.body, result.turn.turnId),
                pendingWrite: emitBeginTurnAfterWrite(result, 'task_started'),
            };
        }

        const terminalResult = terminalTurnSync({
            provider: input.provider,
            providerTurnId,
            issue: input.body.type === 'turn_failed' ? input.body.issue : undefined,
            status: input.body.type === 'task_complete' ? 'completed'
                : input.body.type === 'turn_failed' ? 'failed'
                    : 'cancelled',
            suppressUntrustedDuplicate: !providerTurnId,
        });
        if (!terminalResult.turn) {
            return {
                body: input.body,
                pendingWrite: null,
            };
        }
        const pendingWrite = terminalResult.pendingWrite
            ? terminalResult.pendingWrite.then(
                () => {
                    if (terminalResult.turn) {
                        emitTerminalTurnLifecycleEvent(
                            terminalResult.turn.terminalStatus ?? 'completed',
                            terminalResult.turn.turnId,
                        );
                    }
                },
                (error) => {
                    if (terminalResult.turn) {
                        emitTerminalTurnLifecycleEvent(terminalResult.turn.terminalStatus ?? 'completed');
                    }
                    throw error;
                },
            )
            : null;
        return {
            body: withLifecycleMarkerId(input.body, terminalResult.turn.turnId),
            pendingWrite,
        };
    }

    return {
        beginTurn,
        attachProviderTurnId,
        appendTranscriptAnchors,
        touchActiveTurn,
        completeTurn,
        failTurn,
        cancelTurn,
        endSession,
        markRollbackEligible,
        markRolledBack,
        hasActiveTurn,
        getActiveTurnId,
        observeAcpLifecycleMarker,
    };
}
