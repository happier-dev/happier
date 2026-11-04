import type { Tx } from "@/storage/inTx";
import { buildSessionAccessWhere } from "./sessionAccessWhere";
import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";
import { createSessionDataKeyEnvelopeViewerSelect, projectViewerSessionDataKey, type SessionDataKeyEnvelopeViewerRow } from "../encryption/sessionDataKeyEnvelopePersistence";
import { assertSessionOwnerMetadataCurrentness, deriveSessionMetadataOwnerAccountMode, projectSessionDisplayForRecipient, sessionMetadataOwnerAccountCurrentnessSelect } from "../metadata/sessionMetadataRecipientProjection";
import { buildSessionAccessProjectionSelect, projectSessionEffectiveAccessV1, resolveSessionAccessForOperation, type SessionAccessOperationDecision } from "./sessionAccess";
import type { SessionDisplayProjectionV1, SessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionLegacyShare } from "../listing/rows";

/** Filter a captured projection without re-reading or broadening its content corpus. */
export async function readCurrentSessionIdsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
    accessMode?: "effective_access_v1" | "legacy_owner_or_direct";
}>): Promise<ReadonlySet<string>> {
    if (input.sessionIds.length === 0) return new Set();
    // The effective compiler retains credential/runtime-principal admission;
    // the released seam additionally narrows to its existing owner/direct corpus.
    const effectiveWhere = await buildSessionAccessWhere({ tx, accountId: input.accountId, capability: "readTranscript", mode: "effective_access_v1", authentication: input.authentication });
    const where = input.accessMode === "legacy_owner_or_direct" ? { AND: [effectiveWhere,
        buildSessionAccessWhere({ accountId: input.accountId, capability: "readTranscript", mode: "legacy_owner_or_direct" }),
    ] } : effectiveWhere;
    const rows = await tx.session.findMany({
        where: { AND: [where, { id: { in: [...input.sessionIds] } }] },
        select: { id: true },
    });
    return new Set(rows.map(row => row.id));
}

type CapturedSessionReadRow = Readonly<{ id: string; encryptionMode?: string;
    metadataLayoutVersion?: number | null; metadata?: unknown; ownerMetadata?: string | SessionOwnerMetadataEnvelopeV1 | null; effectiveAccess?: unknown;
    metadataVersion?: number; displayProjectionV1?: string | SessionDisplayProjectionV1 | null;
    dataEncryptionKey?: string | null; dataKeyEnvelopes?: SessionDataKeyEnvelopeViewerRow["dataKeyEnvelopes"] }>;

export type SessionReadAdmission<T> =
    | Exclude<SessionAccessOperationDecision, Readonly<{ status: "allowed" }>>
    | Readonly<{ status: "allowed"; row: T }>;

/** One fresh row supplies access, mode and key facts; only the access owner qualifies it. */
export async function readmitSessionRowsWithAdmissionInTx<T extends CapturedSessionReadRow>(
    tx: Tx, input: Omit<Parameters<typeof readCurrentSessionIdsInTx>[1], "sessionIds">, captured: readonly T[],
): Promise<ReadonlyMap<string, SessionReadAdmission<T>>> {
    const result = new Map<string, SessionReadAdmission<T>>();
    if (captured.length === 0) return result;
    const includesDocuments = captured.some(row => 'metadata' in row || 'ownerMetadata' in row);
    const accessSelect = buildSessionAccessProjectionSelect(input.accountId);
    const current = await tx.session.findMany({ where: { id: { in: captured.map(row => row.id) } },
        select: { metadataLayoutVersion: true, ownerMetadata: includesDocuments,
            ...accessSelect,
            account: { select: { ...accessSelect.account.select, ...sessionMetadataOwnerAccountCurrentnessSelect } },
            ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: input.accountId }) } });
    const byId = new Map(current.map(row => [row.id, row]));
    const decisions = new Map<string, SessionAccessOperationDecision>();
    for (const fresh of current) {
        decisions.set(fresh.id, await resolveSessionAccessForOperation(tx, { ...input, sessionId: fresh.id,
            capability: "readTranscript", row: fresh }));
    }
    // Inaccessible rows cannot expose their owning Account's privacy readiness.
    const ownerModes = new Map<string, ReturnType<typeof deriveSessionMetadataOwnerAccountMode>>();
    for (const row of current) {
        if (decisions.get(row.id)?.status === "allowed" && row.metadataLayoutVersion === 1
            && !ownerModes.has(row.accountId)) {
            ownerModes.set(row.accountId, deriveSessionMetadataOwnerAccountMode(row.account));
        }
    }
    for (const row of captured) {
        const fresh = byId.get(row.id);
        const decision = decisions.get(row.id);
        if (!fresh || !decision) {
            result.set(row.id, { status: "unavailable" });
            continue;
        }
        if (decision.status !== "allowed") {
            result.set(row.id, decision);
            continue;
        }
        if (row.encryptionMode !== undefined && row.encryptionMode !== fresh.encryptionMode) {
            result.set(row.id, { status: "unavailable" });
            continue;
        }
        if (row.metadataLayoutVersion !== undefined && row.metadataLayoutVersion !== fresh.metadataLayoutVersion) {
            result.set(row.id, { status: 'unavailable' });
            continue;
        }
        if (includesDocuments && row.metadataLayoutVersion === 1) {
            const capturedOwnerMetadata = row.ownerMetadata === undefined ? fresh.ownerMetadata
                : row.ownerMetadata;
            assertSessionOwnerMetadataCurrentness({ metadataLayoutVersion: row.metadataLayoutVersion,
                ownerMetadata: capturedOwnerMetadata ?? null, accountMode: ownerModes.get(fresh.accountId)!,
                isOwner: fresh.accountId === input.accountId && !input.authentication.sessionRuntimePrincipal });
        }
        const capturedKey = row.dataKeyEnvelopes !== undefined && row.encryptionMode !== undefined
            ? projectViewerSessionDataKey({ encryptionMode: row.encryptionMode, dataKeyEnvelopes: row.dataKeyEnvelopes })
            : row.dataEncryptionKey;
        if (capturedKey !== undefined && capturedKey !== projectViewerSessionDataKey(fresh)) {
            result.set(row.id, { status: "unavailable" });
            continue;
        }
        // Captured display content obeys the same fresh Account mode as
        // full documents. Withdraw an incompatible owner leaf without
        // refreshing the captured tuple or selecting another document.
        const displayProjectionV1 = row.displayProjectionV1 !== undefined
            && row.metadataVersion !== undefined && row.encryptionMode !== undefined
            ? projectSessionDisplayForRecipient({
                session: { ...row, metadataVersion: row.metadataVersion,
                    encryptionMode: row.encryptionMode, accountId: fresh.accountId },
                recipient: fresh.accountId === input.accountId && decision.access.level === 'owner'
                    && !input.authentication.sessionRuntimePrincipal
                    ? { type: 'owner', accountId: input.accountId, accountMode: ownerModes.get(fresh.accountId)! }
                    : { type: 'shared', accountId: input.accountId, ownerAccountMode: ownerModes.get(fresh.accountId) },
            }) : undefined;
        const readmittedRow = row.displayProjectionV1 == null ? row : { ...row,
            displayProjectionV1: typeof row.displayProjectionV1 === 'string'
                ? displayProjectionV1 ? JSON.stringify(displayProjectionV1) : null
                : displayProjectionV1 };
        if (row.effectiveAccess !== undefined) {
            const share = projectSessionLegacyShare({ receivesOwnerMetadata: fresh.accountId === input.accountId
                && decision.access.level === "owner", share: fresh.shares[0] });
            result.set(row.id, { status: "allowed", row: { ...readmittedRow, share: share.share,
                effectiveAccess: projectSessionEffectiveAccessV1(decision.access) } });
        } else result.set(row.id, { status: "allowed", row: readmittedRow });
    }
    return result;
}

/** Lists omit denials; detail consumes the same owner's typed denial directly. */
export async function readmitSessionRowsInTx<T extends CapturedSessionReadRow>(
    tx: Tx, input: Omit<Parameters<typeof readCurrentSessionIdsInTx>[1], "sessionIds">, captured: readonly T[],
): Promise<T[]> {
    const admissions = await readmitSessionRowsWithAdmissionInTx(tx, input, captured);
    const rows: T[] = [];
    for (const capturedRow of captured) {
        const admission = admissions.get(capturedRow.id);
        if (admission?.status === "allowed") rows.push(admission.row);
    }
    return rows;
}
