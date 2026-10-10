import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
    SessionBoardMutationV1Schema, SessionBoardLayoutV1Schema, SessionSurfaceItemV1Schema,
    isSessionSurfaceItemSourceCompatible,
    sessionBoardMutationUsesLayoutV1,
    type SessionBoardMutationV1, type SessionBoardMutationResultV1, type SessionBoardErrorV1,
    type SessionBoardFeatureGateErrorV1Schema,
} from "@happier-dev/protocol/sessions/board";
import {
    type SessionSystemRecordContent, type SessionSystemRecordStored,
} from "@happier-dev/protocol";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { resolveSessionBoardRecordsInTx } from "@/app/session/systemRecords/sessionSystemRecordService";
import { markSessionProjectionRecipientsChanged } from "@/app/session/changeTracking/markSessionProjectionRecipientsChanged";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

type SessionBoardMutationError = SessionBoardErrorV1 | z.infer<typeof SessionBoardFeatureGateErrorV1Schema>;

class BoardMutationFailure extends Error {
    constructor(readonly result: SessionBoardMutationError) { super(result.error); }
}

type SessionBoardMutationOutcome =
    { ok: true; result: SessionBoardMutationResultV1 } | { ok: false; result: SessionBoardMutationError };

async function mutateSessionBoardAttempt(
    params: Readonly<{ actorUserId: string; sessionId: string; authentication: SessionAccessAuthentication }>,
    mutation: SessionBoardMutationV1,
    settleCreateRace: boolean,
): Promise<SessionBoardMutationOutcome> {
    try {
        return await inTx(async tx => {
            const records = await resolveSessionBoardRecordsInTx(tx, { ...params, requiresLayout: sessionBoardMutationUsesLayoutV1(mutation) });
            if (!records.ok) throw new BoardMutationFailure({
                error: records.code === "plugin_session_record_feature_disabled" ? "not_found" : "session_board_forbidden",
            });
            const read = async (id: string | null) => {
                const result = await records.read(id);
                if (!result.ok) {
                    if (result.code === "plugin_session_record_internal") throw new Error(result.code);
                    if (result.code === "session_system_record_storage_mode_mismatch") throw new BoardMutationFailure({ error: "session_board_storage_mode_mismatch" });
                    throw new BoardMutationFailure({ error: "session_board_revision_conflict" });
                }
                return result.record;
            };
            const changesLayout = sessionBoardMutationUsesLayoutV1(mutation);
            const layout = changesLayout ? await read(null) : null;
            const itemLocalId = mutation.operation === "update_layout"
                ? mutation.itemPlacementParticipant?.itemId ?? null
                : mutation.itemId;
            const item = itemLocalId === null ? null : await read(itemLocalId);
            const fail = (error: SessionBoardErrorV1["error"]): never => {
                throw new BoardMutationFailure({ error, ...(error === "session_board_revision_conflict" ? {
                    currentItemRevision: item?.revision ?? null, currentLayoutRevision: layout?.revision ?? null,
                } : {}) });
            };
            const validate = (id: string | null, content: SessionSystemRecordContent) => {
                const failure = records.validateContent(id, content);
                if (failure) fail(failure === "invalid" ? "session_board_invalid" : "session_board_storage_mode_mismatch");
            };
            const upsert = async (id: string | null, content: SessionSystemRecordContent, revision: string | null) => {
                validate(id, content);
                const result = await records.upsert(id, content, revision);
                if (!("ok" in result) || !result.ok) {
                    if ("code" in result && result.code === "plugin_session_record_internal") throw new Error(result.code);
                    return fail("code" in result && result.code === "plugin_session_record_forbidden" ? "session_board_forbidden" : "session_board_revision_conflict");
                }
                return result.record;
            };
            const outcome = (previous: SessionSystemRecordStored | null, next: SessionSystemRecordStored) =>
                !previous ? "created" as const : previous.revision === next.revision ? "unchanged" as const : "updated" as const;
            let result: SessionBoardMutationResultV1;
            let changed = false;
            if (mutation.operation === "update_layout") {
                const participant = mutation.itemPlacementParticipant;
                if (participant) {
                    if (!item) fail("session_board_item_not_found");
                    if (item?.revision !== participant.expectedItemRevision) {
                        fail("session_board_revision_conflict");
                    }
                    if (mutation.layoutContent.t === "plain") {
                        const next = SessionBoardLayoutV1Schema.parse(mutation.layoutContent.v);
                        if (!next.tabs.some(tab => tab.items.some(placement => placement.itemId === participant.itemId))) {
                            fail("session_board_invalid");
                        }
                    }
                }
                const next = await upsert(null, mutation.layoutContent, mutation.expectedLayoutRevision);
                result = { operation: mutation.operation, outcome: outcome(layout, next), layoutRevision: next.revision };
                changed = layout?.revision !== next.revision;
            } else if (mutation.operation === "upsert_item") {
                if (!item && mutation.expectedItemRevision !== null) fail("session_board_item_not_found");
                validate(mutation.itemId, mutation.itemContent);
                if (item?.content.t === "plain" && mutation.itemContent.t === "plain") {
                    const previous = SessionSurfaceItemV1Schema.parse(item.content.v);
                    const next = SessionSurfaceItemV1Schema.parse(mutation.itemContent.v);
                    if (!isSessionSurfaceItemSourceCompatible(previous, next)) fail("session_board_source_conflict");
                }
                const itemContent = !item && mutation.itemContent.t === "plain" && mutation.itemContent.v.destination === undefined
                    && (mutation.destination !== undefined || mutation.placement === undefined)
                    ? { t: "plain" as const, v: { ...mutation.itemContent.v, destination: mutation.destination ?? "transcript" as const } }
                    : mutation.itemContent;
                const nextItem = await upsert(mutation.itemId, itemContent, mutation.expectedItemRevision);
                const nextLayout = mutation.placement ? await upsert(null, mutation.placement.layoutContent, mutation.placement.expectedLayoutRevision) : null;
                if (mutation.placement?.layoutContent.t === "plain") {
                    validate(null, mutation.placement.layoutContent);
                    const next = SessionBoardLayoutV1Schema.parse(mutation.placement.layoutContent.v);
                    if (!next.tabs.some(tab => tab.items.some(placement => placement.itemId === mutation.itemId))) fail("session_board_invalid");
                }
                result = { operation: mutation.operation, itemId: mutation.itemId, outcome: outcome(item, nextItem), itemRevision: nextItem.revision,
                    ...(nextLayout ? { layoutRevision: nextLayout.revision } : {}) };
                changed = item?.revision !== nextItem.revision || (nextLayout !== null && layout?.revision !== nextLayout.revision);
            } else {
                if (mutation.layoutContent) validate(null, mutation.layoutContent);
                if (mutation.layoutContent?.t === "plain") {
                    const next = SessionBoardLayoutV1Schema.parse(mutation.layoutContent.v);
                    if (next.tabs.some(tab => tab.items.some(placement => placement.itemId === mutation.itemId))) fail("session_board_invalid");
                }
                if (!item) {
                    if (mutation.layoutContent && (!layout || !isDeepStrictEqual(layout.content, mutation.layoutContent))) return fail("session_board_revision_conflict");
                    result = { operation: mutation.operation, outcome: "removed", itemId: mutation.itemId,
                        ...(layout ? { layoutRevision: layout.revision } : {}) };
                } else {
                    const removed = await records.remove(mutation.itemId, mutation.expectedItemRevision);
                    if (!("ok" in removed) || !removed.ok) fail("session_board_revision_conflict");
                    const next = mutation.layoutContent && mutation.expectedLayoutRevision !== undefined
                        ? await upsert(null, mutation.layoutContent, mutation.expectedLayoutRevision) : null;
                    result = { operation: mutation.operation, outcome: "removed", itemId: mutation.itemId,
                        ...(next ? { layoutRevision: next.revision } : {}) };
                    changed = true;
                }
            }
            if (changed) await markSessionProjectionRecipientsChanged({ tx, sessionId: params.sessionId, hint: { v: 1, sessionSurfaces: true } });
            return { ok: true as const, result };
        });
    } catch (error) {
        if (error instanceof BoardMutationFailure) return { ok: false, result: error.result };
        // A competing create can win the unique record-address constraint before
        // this transaction reaches its layout row. The failed transaction has
        // rolled back in full, so one replay of the exact sealed aggregate lets
        // the shared SSR CAS owner settle byte-identical retries or return the
        // now-readable revision conflict. Never expose a Prisma/P2002 transport.
        if (settleCreateRace && isPrismaErrorCode(error, "P2002")) {
            return await mutateSessionBoardAttempt(params, mutation, false);
        }
        if (isPrismaErrorCode(error, "P2002")) {
            return { ok: false, result: { error: "session_board_revision_conflict" } };
        }
        throw error;
    }
}

/** Commit each Board intent and its participant invalidation as one SSR transaction. */
export async function mutateSessionBoard(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    mutation: unknown;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionBoardMutationOutcome> {
    const parsed = SessionBoardMutationV1Schema.safeParse(params.mutation);
    if (!parsed.success) return { ok: false, result: { error: "session_board_invalid" } };
    return await mutateSessionBoardAttempt(params, parsed.data, true);
}
