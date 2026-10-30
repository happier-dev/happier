import { createAcpToolIdentity, createAcpTurnIdentity } from './identity';
import {
    claimAcpToolResultPublication,
    createMutableAcpToolCallRecord,
    isAcpToolTerminalStatus,
    mergeAcpToolObservation,
    snapshotAcpToolCall,
    snapshotAcpToolResult,
    type MutableAcpToolCallRecord,
} from './mergeToolCallUpdate';
import type {
    AcpToolAccumulatorEmission,
    AcpToolObservation,
    MergedAcpToolCall,
    TerminalizeAcpToolTurnInput,
} from './types';

type Tombstone = Readonly<{
    record: MutableAcpToolCallRecord;
    finalizedAtMs: number;
}>;

export class AcpToolCallAccumulator {
    // Late ACP updates carry no turn identity. Retain correlation for this runtime's
    // lifetime; reset/dispose retire it with the owning Session, never by age/count.
    private readonly active = new Map<string, MutableAcpToolCallRecord>();
    private readonly tombstones = new Map<string, Tombstone>();
    private readonly closedTurns = new Set<string>();
    private disposed = false;

    get activeSize(): number {
        return this.active.size;
    }

    get tombstoneSize(): number {
        return this.tombstones.size;
    }

    get closedTurnSize(): number {
        return this.closedTurns.size;
    }

    observe(observation: AcpToolObservation): AcpToolAccumulatorEmission {
        this.assertActive();
        this.assertObservation(observation);
        const identity = createAcpToolIdentity(observation);
        const tombstone = this.tombstones.get(identity.correlationKey);
        const allSidechainsTurnKey = createAcpTurnIdentity({
            sessionId: observation.sessionId,
            turnId: observation.turnId,
        });
        const exactSidechainTurnKey = createAcpTurnIdentity(observation);
        if (
            (this.closedTurns.has(allSidechainsTurnKey) || this.closedTurns.has(exactSidechainTurnKey))
            && tombstone === undefined
        ) {
            return Object.freeze({ kind: 'ignored', reason: 'closed-beyond-tombstone' });
        }
        const record = tombstone?.record ?? this.active.get(identity.correlationKey);
        if (record && observation.revision <= record.revision) {
            return Object.freeze({ kind: 'ignored', reason: 'stale' });
        }

        if (record) {
            const changed = mergeAcpToolObservation(record, observation);
            if (!changed) {
                return Object.freeze({ kind: 'ignored', reason: 'duplicate' });
            }
            if (tombstone) {
                const result = snapshotAcpToolResult(record);
                const publishResult = claimAcpToolResultPublication(record, result);
                this.tombstones.delete(identity.correlationKey);
                this.tombstones.set(identity.correlationKey, Object.freeze({
                    record,
                    finalizedAtMs: Math.max(tombstone.finalizedAtMs, observation.observedAtMs),
                }));
                return Object.freeze({
                    kind: 'late-enrichment',
                    call: snapshotAcpToolCall(record),
                    result,
                    publishResult,
                    revision: observation.revision,
                });
            }
            return this.emitActiveRecord(identity.correlationKey, record);
        }

        const created = createMutableAcpToolCallRecord(observation, identity);
        mergeAcpToolObservation(created, observation);
        this.active.set(identity.correlationKey, created);
        return this.emitActiveRecord(identity.correlationKey, created);
    }

    terminalizeTurn(input: TerminalizeAcpToolTurnInput): readonly AcpToolAccumulatorEmission[] {
        this.assertActive();
        const emissions: AcpToolAccumulatorEmission[] = [];
        const records = [...this.active.values()]
            .filter((record) => record.sessionId === input.sessionId
                && record.turnId === input.turnId
                && (input.sidechainId === undefined || record.sidechainId === input.sidechainId));

        for (const record of records) {
            const revision = Math.max(input.revision, record.revision + 1);
            const emission = this.observe({
                sessionId: record.sessionId,
                turnId: record.turnId,
                sidechainId: record.sidechainId,
                toolCallId: record.toolCallId,
                revision,
                observedAtMs: input.observedAtMs,
                source: 'terminalize_turn',
                patch: { status: input.status },
            });
            emissions.push(emission);
        }

        const turnKey = createAcpTurnIdentity({
            sessionId: input.sessionId,
            turnId: input.turnId,
            sidechainId: input.sidechainId,
        });
        this.closedTurns.add(turnKey);
        return Object.freeze(emissions);
    }

    peek(sessionId: string, turnId: string, sidechainId: string | null, toolCallId: string): MergedAcpToolCall | null {
        const identity = createAcpToolIdentity({ sessionId, turnId, sidechainId, toolCallId });
        const record = this.active.get(identity.correlationKey) ?? this.tombstones.get(identity.correlationKey)?.record;
        return record ? snapshotAcpToolCall(record) : null;
    }

    /**
     * Finds the newest retained terminal observation for an opaque provider call ID.
     *
     * ACP tool updates do not carry a turn ID. The runtime uses this retained lookup only
     * for `tool_call_update`, after preferring an active current-turn record, so a newly
     * created `tool_call` with a reused opaque ID always starts a fresh turn-scoped record.
     */
    findNewestRetainedTurnId(input: Readonly<{
        sessionId: string;
        sidechainId: string | null;
        toolCallId: string;
    }>): string | null {
        let newest: Tombstone | null = null;
        for (const tombstone of this.tombstones.values()) {
            const record = tombstone.record;
            if (
                record.sessionId !== input.sessionId
                || record.sidechainId !== input.sidechainId
                || record.toolCallId !== input.toolCallId
            ) {
                continue;
            }
            if (
                newest === null
                || tombstone.finalizedAtMs > newest.finalizedAtMs
                || (
                    tombstone.finalizedAtMs === newest.finalizedAtMs
                    && record.revision > newest.record.revision
                )
            ) {
                newest = tombstone;
            }
        }
        return newest?.record.turnId ?? null;
    }

    listActiveCalls(input: Readonly<{
        sessionId: string;
        turnId: string;
        sidechainId?: string | null;
    }>): readonly MergedAcpToolCall[] {
        return Object.freeze([...this.active.values()]
            .filter((record) => record.sessionId === input.sessionId
                && record.turnId === input.turnId
                && (input.sidechainId === undefined || record.sidechainId === input.sidechainId))
            .map(snapshotAcpToolCall));
    }

    reset(): void {
        this.active.clear();
        this.tombstones.clear();
        this.closedTurns.clear();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.reset();
        this.disposed = true;
    }

    private emitActiveRecord(correlationKey: string, record: MutableAcpToolCallRecord): AcpToolAccumulatorEmission {
        if (!isAcpToolTerminalStatus(record.status)) {
            return Object.freeze({
                kind: 'progress',
                call: snapshotAcpToolCall(record),
                revision: record.revision,
            });
        }

        this.active.delete(correlationKey);
        const result = snapshotAcpToolResult(record);
        const publishResult = claimAcpToolResultPublication(record, result);
        this.tombstones.set(correlationKey, Object.freeze({
            record,
            finalizedAtMs: record.observedAtMs,
        }));
        return Object.freeze({
            kind: 'terminal',
            call: snapshotAcpToolCall(record),
            result,
            publishResult,
            revision: record.revision,
        });
    }

    private assertActive(): void {
        if (this.disposed) {
            throw new Error('ACP tool accumulator is disposed');
        }
    }

    private assertObservation(observation: AcpToolObservation): void {
        if (!Number.isSafeInteger(observation.revision) || observation.revision < 0) {
            throw new Error('ACP tool observation revision must be a non-negative safe integer');
        }
        if (!Number.isFinite(observation.observedAtMs)) {
            throw new Error('ACP tool observation timestamp must be finite');
        }
    }
}
