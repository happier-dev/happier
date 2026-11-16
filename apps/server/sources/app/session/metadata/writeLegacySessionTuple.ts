import { decodeSessionStoredContent, encodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";

import type { Tx } from "@/storage/inTx";
import { SESSION_TRANSCRIPT_PUBLICATION_SELECT } from "@/app/session/sessionTranscriptPublicationPolicy";
import type { UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { nextSessionUsageTiming } from './sessionUsageTiming';

const tupleSelect = {
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    active: true, archivedAt: true, metadataLayoutVersion: true, ownerMetadata: true,
    metadataVersion: true, metadata: true, encryptionMode: true,
    usageTimingV1: true,
    agentStateVersion: true, agentState: true,
    seq: true, latestTurnId: true, latestTurnStatus: true,
    pendingPermissionRequestCount: true, pendingUserActionRequestCount: true,
    pendingRequestObservedAt: true, pendingCount: true, pendingBlockedCount: true,
    latestReadyEventSeq: true, lastRuntimeIssue: true,
} as const satisfies Prisma.SessionSelect;

type StoredTuple = Prisma.SessionGetPayload<{ select: typeof tupleSelect }>;
type TupleFields = Readonly<{
    metadata: Readonly<{ value: string; version: number }>;
    agentState: Readonly<{ value: string | null; version: number }>;
}>;

export type LegacySessionActivitySummary = Readonly<{
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    pendingRequestObservedAt?: Date | null;
}>;

export type LegacySessionTupleWriteResult =
    | (TupleFields & Readonly<{
        ok: true;
        previous: StoredTuple;
        didWrite: boolean;
        metadataChanged: boolean;
        agentStateChanged: boolean;
      }>)
    | Readonly<{
        ok: false;
        error: "session-not-found" | "session_active" | "session_archived"
            | "metadata_privacy_upgrade_required" | "version-mismatch";
        current?: TupleFields;
      }>;

function metadataEquals(current: StoredTuple, next: string): boolean {
    if (current.metadata === next) return true;
    if (current.encryptionMode !== "plain") return false;
    try { return isDeepStrictEqual(JSON.parse(current.metadata), JSON.parse(next)); }
    catch { return false; }
}

/** The layout-zero CAS for already-admitted HTTP and released socket writes. */
export async function writeLegacySessionTupleInTx(tx: Tx, input: Readonly<{
    sessionId: string;
    metadata?: Readonly<{ ciphertext: string; expectedVersion: number }>;
    agentState?: Readonly<{ ciphertext: string | null; expectedVersion: number }>;
    usageTimingV1?: UsageSessionTimingV1;
    activitySummary?: LegacySessionActivitySummary;
    requireInactiveSession?: boolean;
    requireUnarchivedSession?: boolean;
}>): Promise<LegacySessionTupleWriteResult> {
    const { metadata, agentState } = input;
    const fields = (row: StoredTuple): TupleFields => ({
        metadata: { value: row.metadata, version: row.metadataVersion },
        agentState: { value: row.agentState, version: row.agentStateVersion },
    });
    const classify = (row: StoredTuple, afterCas: boolean): Extract<LegacySessionTupleWriteResult, { ok: false }> | null => {
        if (input.requireInactiveSession && row.active) return { ok: false, error: "session_active" };
        if (afterCas && input.requireUnarchivedSession && row.archivedAt !== null) return { ok: false, error: "session_archived" };
        if ((row.metadataLayoutVersion ?? 0) !== 0 || row.ownerMetadata !== null) {
            return { ok: false, error: "metadata_privacy_upgrade_required" };
        }
        return null;
    };
    const current = await tx.session.findUnique({ where: { id: input.sessionId }, select: withSessionContentSelect(tupleSelect) }).then(decodeSessionStoredContent);
    if (!current) return { ok: false, error: "session-not-found" };
    const rejected = classify(current, false);
    if (rejected) return rejected;
    if (metadata && current.metadataVersion !== metadata.expectedVersion
        || agentState && current.agentStateVersion !== agentState.expectedVersion) {
        return { ok: false, error: "version-mismatch", current: fields(current) };
    }
    const metadataChanged = metadata !== undefined && !metadataEquals(current, metadata.ciphertext);
    const agentStateChanged = agentState !== undefined && current.agentState !== agentState.ciphertext;
    const summary = input.activitySummary;
    const summaryChanged = summary !== undefined && (
        summary.pendingPermissionRequestCount !== undefined && summary.pendingPermissionRequestCount !== current.pendingPermissionRequestCount
        || summary.pendingUserActionRequestCount !== undefined && summary.pendingUserActionRequestCount !== current.pendingUserActionRequestCount
        || summary.pendingRequestObservedAt !== undefined
            && (summary.pendingRequestObservedAt?.getTime() ?? null) !== (current.pendingRequestObservedAt?.getTime() ?? null)
    );
    if (!metadataChanged && !agentStateChanged && !summaryChanged) {
        return { ok: true, previous: current, didWrite: false, metadataChanged, agentStateChanged, ...fields(current) };
    }
    const next = {
        ...current,
        ...(metadataChanged && metadata ? { metadata: metadata.ciphertext, metadataVersion: metadata.expectedVersion + 1 } : {}),
        ...(agentStateChanged && agentState ? { agentState: agentState.ciphertext, agentStateVersion: agentState.expectedVersion + 1 } : {}),
    };
    const updated = await tx.session.updateMany({
        where: {
            id: input.sessionId, metadataLayoutVersion: 0, ownerMetadata: null,
            ...(metadata ? { metadataVersion: metadata.expectedVersion } : {}),
            ...(agentState ? { agentStateVersion: agentState.expectedVersion } : {}),
            ...(input.requireInactiveSession ? { active: false } : {}),
            ...(input.requireUnarchivedSession ? { archivedAt: null } : {}),
        },
        data: encodeSessionStoredContent({
            usageTimingV1: nextSessionUsageTiming({ current: current.usageTimingV1, supplied: input.usageTimingV1,
                metadataWritten: metadata !== undefined, metadataChanged, agentStateWritten: agentState !== undefined, agentStateChanged }),
            ...(metadataChanged && metadata ? { metadata: next.metadata, metadataVersion: next.metadataVersion } : {}),
            ...(agentStateChanged && agentState ? { agentState: next.agentState, agentStateVersion: next.agentStateVersion } : {}),
            ...summary,
        }),
    });
    if (updated.count === 0) {
        const fresh = await tx.session.findUnique({ where: { id: input.sessionId }, select: withSessionContentSelect(tupleSelect) }).then(decodeSessionStoredContent);
        if (!fresh) return { ok: false, error: "session-not-found" };
        return classify(fresh, true) ?? { ok: false, error: "version-mismatch", current: fields(fresh) };
    }
    return { ok: true, previous: current, didWrite: true, metadataChanged, agentStateChanged, ...fields(next) };
}
