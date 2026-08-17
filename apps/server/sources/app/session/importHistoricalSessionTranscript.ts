import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

import { resolveSessionMessageRole } from "./messageRole/resolveSessionMessageRole";
import { ensureSessionEditAccess } from "./sessionWriteService";
import {
    HISTORICAL_IMPORT_TRANSCRIPT_OBSERVATION_PROVENANCE,
    writeHistoricalSessionMessageBatchInTx,
} from "./sessionTranscriptWrite";

export type HistoricalSessionTranscriptImportItem = Readonly<{
    localId: string;
    content: PrismaJson.SessionMessageContent;
    messageRole?: unknown;
}>;

export type HistoricalSessionTranscriptImportResult =
    | Readonly<{
        ok: true;
        imported: number;
        cursor: number | null;
      }>
    | Readonly<{
        ok: false;
        error: "forbidden" | "session-not-found" | "invalid-params" | "internal";
        code?: string;
      }>;

/**
 * Host compatibility adapter for the existing transcript.import action. Authorization and the
 * canonical historical batch stay in one transaction; this adapter intentionally has no hosted
 * message projections, Pending admission, turn, attention, badge, or participant side effects.
 */
export async function importHistoricalSessionTranscript(
    params: Readonly<{
        actorUserId: string;
        sessionId: string;
        items: readonly HistoricalSessionTranscriptImportItem[];
    }>,
): Promise<HistoricalSessionTranscriptImportResult> {
    const storagePolicy = readEncryptionFeatureEnv(process.env).storagePolicy;
    const attempt = async (): Promise<HistoricalSessionTranscriptImportResult> => await inTx<HistoricalSessionTranscriptImportResult>(async (tx) => {
        const access = await ensureSessionEditAccess(tx, {
            actorUserId: params.actorUserId,
            sessionId: params.sessionId,
        });
        if (!access.ok) {
            return { ok: false as const, error: access.error };
        }

        const written = await writeHistoricalSessionMessageBatchInTx(tx, {
            sessionId: params.sessionId,
            writeAuthority: "hosted",
            storagePolicy,
            items: params.items.map((item) => ({
                localId: item.localId,
                sidechainId: null,
                content: item.content,
                messageRole: resolveSessionMessageRole({
                    content: item.content,
                    suppliedRole: item.messageRole,
                    telemetry: {
                        sessionId: params.sessionId,
                        storageMode: access.sessionEncryptionMode,
                        source: "session-message",
                    },
                }).messageRole,
                transcriptObservationProvenance:
                    HISTORICAL_IMPORT_TRANSCRIPT_OBSERVATION_PROVENANCE,
            })),
        });
        if (!written.ok) {
            return {
                ok: false as const,
                error: written.error === "session-not-found" ? "session-not-found" : "invalid-params",
                ...("code" in written && typeof written.code === "string"
                    ? {
                        code: written.code === "session_storage_authority_mismatch"
                            ? "external_session_operation_required"
                            : written.code,
                    }
                    // The reserved Agent-transition divider namespace reports the
                    // SAME client-visible code as the other message ingresses that
                    // refuse it, so a caller sees one vocabulary for one rule.
                    : written.error === "reserved-local-id"
                        ? { code: "session_message_reserved_local_id" }
                        : { code: written.error }),
            };
        }
        return {
            ok: true as const,
            imported: written.messages.length,
            cursor: written.lastSeq,
        };
    });

    try {
        return await attempt();
    } catch (error) {
        if (!isPrismaErrorCode(error, "P2002")) {
            return { ok: false, error: "internal" };
        }
        try {
            return await attempt();
        } catch {
            return { ok: false, error: "internal" };
        }
    }
}
