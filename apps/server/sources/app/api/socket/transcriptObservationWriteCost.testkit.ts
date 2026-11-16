import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { eventRouter } from "@/app/events/eventRouter";
import { createAuthenticatedFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { db } from "@/storage/db";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { observePrismaRequests, observeSqliteRequests } from "@/testkit/observeSqliteRequests";

type ObservedRequest = Readonly<{ model?: string; action: string; args: unknown; transactionId?: string }>;

function isSessionRowWrite(request: ObservedRequest): boolean {
    if (request.model === "Session") return /^(update|upsert)/.test(request.action);
    if (request.model !== undefined || !/Raw/.test(request.action)) return false;
    const query = (request.args as { query?: unknown } | undefined)?.query;
    return typeof query === "string" && /^\s*UPDATE\s+"(public"\.")?Session"/i.test(query);
}

function isSessionRowRead(request: ObservedRequest): boolean {
    return request.model === "Session" && /^find/.test(request.action);
}

/** The Session audience census (`readSessionAccountCursorAudienceInTx`) reads every relation edge of its Sessions. */
function isAudienceCensusRead(request: ObservedRequest): boolean {
    const where = (request.args as { where?: { OR?: unknown } } | undefined)?.where;
    return request.model === "SessionFollowEdge" && request.action === "findMany" && Array.isArray(where?.OR);
}

/**
 * The per-line storage cost of a streamed transcript observation on the real socket handler.
 * Every streamed line and every committed message pays this transaction, so its repeated work
 * is counted per line in steady state (after the Session's first lines).
 */
type StreamedLines = Readonly<{
    sessionId: string;
    acks: ReadonlyArray<{ ok: boolean; seq?: number }>;
    localIds: readonly string[];
    published: readonly string[];
    inTransaction: readonly ObservedRequest[];
    /** Requests outside the lines' transactions: their post-commit work (fan-out, alerts). */
    postCommit: readonly ObservedRequest[];
}>;

/** A session-scoped publisher streams `lines` steady-state transcript lines on the real handler. */
async function streamTranscriptLines(provider: "sqlite" | "postgres", lines: number,
    setup?: (ids: Readonly<{ ownerId: string; sessionId: string }>) => Promise<void>): Promise<StreamedLines> {
    const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" }, select: { id: true } });
    const machineId = `machine-${randomUUID()}`;
    await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
    const session = await db.session.create({
        data: { accountId: owner.id, tag: `session-${randomUUID()}`, metadata: "{}", active: false,
            lastActiveAt: new Date("2026-11-07T07:00:00.000Z"),
            runtimeActivityState: "unknown", runtimeActivityActiveCount: 0, runtimeActivityRevision: 0n },
        select: { id: true },
    });
    await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });
    await setup?.({ ownerId: owner.id, sessionId: session.id });
    const socket = createAuthenticatedFakeSocket();
    sessionUpdateHandler(owner.id, socket as never,
        { connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id } as never,
        { presence: createSessionPublisherPresence(), binding: { accountId: owner.id, machineId, sessionId: session.id } });
    await getSocketHandler(socket, "transcript-observation-capability-v1")({ v: 1, sessionId: session.id }, () => {});
    await getSocketHandler(socket, "session-runtime-activity-snapshot")({
        sessionId: session.id, mutationId: `runtime-activity-snapshot:${session.id}`, snapshot: { state: "idle", activeCount: 0 },
    }, () => {});
    const published: string[] = [];
    vi.spyOn(eventRouter, "emitUpdate").mockImplementation((params) => {
        const body = (params.payload as { body: { t: string; message?: { localId?: string } } }).body;
        if (body.t === "new-message" && body.message?.localId) published.push(body.message.localId);
    });
    const createdAt = Date.parse("2026-11-12T18:00:00.000Z");
    const send = async (localId: string, index: number) => {
        let ack: unknown;
        await getSocketHandler(socket, "transcript-observation-v1")({
            v: 1, sessionId: session.id, localId, messageRole: "agent", content: `line-${index}`,
            createdAt: createdAt + index, updatedAt: createdAt + index,
            provenance: { kind: "non_dependent", source: "external" },
        }, (value: unknown) => { ack = value; });
        return ack as { ok: boolean; seq?: number };
    };
    for (let index = 0; index < 3; index++) expect(await send(`warm-${index}-${randomUUID()}`, index)).toMatchObject({ ok: true });
    // Let the warm-up lines' fire-and-forget post-commit work finish before observing.
    await new Promise(resolve => setTimeout(resolve, 300));

    const inTransaction: ObservedRequest[] = [];
    const postCommit: ObservedRequest[] = [];
    const observer = { before: (request: ObservedRequest) => {
        (request.transactionId !== undefined ? inTransaction : postCommit).push(request);
    } };
    const stop = provider === "sqlite" ? observeSqliteRequests(observer) : observePrismaRequests(db, observer);
    const localIds = Array.from({ length: lines }, (_, index) => `line-${index}-${randomUUID()}`);
    const acks: Array<{ ok: boolean; seq?: number }> = [];
    try {
        for (const [index, localId] of localIds.entries()) acks.push(await send(localId, 10 + index));
        await new Promise(resolve => setTimeout(resolve, 300));
    } finally { stop(); }
    return { sessionId: session.id, acks, localIds, published, inTransaction, postCommit };
}

/**
 * The per-line storage cost of a streamed transcript observation on the real socket handler.
 * Every streamed line and every committed message pays this transaction, so its repeated work
 * is counted per line in steady state (after the Session's first lines).
 */
export function transcriptObservationWriteCostContract(provider: "sqlite" | "postgres") {
    it("reads the Session once per owner, writes it once beyond the dialect's writer lock, censuses its audience once and does no post-commit work for nobody", async () => {
        const lines = 8;
        const { sessionId, acks, localIds, published, inTransaction, postCommit } = await streamTranscriptLines(provider, lines);

        // Responses, ordering and fan-out are unchanged by the cost contract.
        expect(acks.map(ack => ack.ok)).toEqual(localIds.map(() => true));
        expect(acks.map(ack => ack.seq)).toEqual(localIds.map((_, index) => 4 + index));
        expect(published.slice(-lines)).toEqual(localIds);
        const stored = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { seq: true, meaningfulActivityAt: true } });
        const last = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId, localId: localIds.at(-1)! } },
            select: { createdAt: true } });
        expect({ seq: stored.seq, meaningfulActivityAt: stored.meaningfulActivityAt?.getTime() })
            .toEqual({ seq: 3 + lines, meaningfulActivityAt: last.createdAt.getTime() });

        const perLine = (count: number) => count / lines;
        const cost = {
            // Publisher fence, one owner context read that also serves its access projection and current
            // recipients, plus the audience census (PostgreSQL). The change row links the Session the line's
            // own update wrote, with no existence read (SQLite; RED at HEAD 660e99616d9: 3).
            sessionRowReads: perLine(inTransaction.filter(isSessionRowRead).length),
            sessionRowWrites: perLine(inTransaction.filter(isSessionRowWrite).length),
            audienceCensusReads: perLine(inTransaction.filter(isAudienceCensusRead).length),
            // The owner's default Follow policy selects no streamed message: no alert can follow.
            postCommitRequests: perLine(postCommit.length),
        };
        console.info("TRANSCRIPT_LINE_WRITE_COST", JSON.stringify({ provider, lines, ...cost,
            transactionRequests: perLine(inTransaction.length) }));
        // SQLite: the publisher fence's guarded update is its single-writer lock; PostgreSQL holds
        // the Session row lock from the audience fence. Either way only the sequence write follows.
        expect(cost).toEqual(provider === "sqlite"
            ? { sessionRowReads: 2, sessionRowWrites: 2, audienceCensusReads: 0, postCommitRequests: 0 }
            : { sessionRowReads: 3, sessionRowWrites: 1, audienceCensusReads: 1, postCommitRequests: 0 });
    });

    it("decides an Account message write from one Session read after the audience census and still reaches every current recipient", async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" }, select: { id: true } });
        const viewer = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" }, select: { id: true } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: `session-${randomUUID()}`, metadata: "{}", active: false, lastActiveAt: new Date("2026-11-07T07:00:00.000Z"),
                runtimeActivityState: "unknown", runtimeActivityActiveCount: 0, runtimeActivityRevision: 0n },
            select: { id: true },
        });
        await db.sessionGrant.create({ data: { principalKind: "account", sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: "view" } });
        const authentication = readSessionAccessAuthenticationFromRequest({ authAuthority: "present_user" });
        const send = (localId: string) => createSessionMessage({ actorUserId: owner.id, inputAdmission: "authenticatedAccount", authentication,
            sessionId: session.id, localId, content: { t: "encrypted", c: Buffer.from(localId).toString("base64") } });
        for (let index = 0; index < 2; index++) expect(await send(`warm-${index}-${randomUUID()}`)).toMatchObject({ ok: true });
        await new Promise(resolve => setTimeout(resolve, 300));

        const lines = 4;
        const inTransaction: ObservedRequest[] = [];
        const observer = { before: (request: ObservedRequest) => { if (request.transactionId !== undefined) inTransaction.push(request); } };
        const stop = provider === "sqlite" ? observeSqliteRequests(observer) : observePrismaRequests(db, observer);
        const results = [];
        try {
            for (let index = 0; index < lines; index++) results.push(await send(`line-${index}-${randomUUID()}`));
            await new Promise(resolve => setTimeout(resolve, 300));
        } finally { stop(); }

        // Fan-out is unchanged: both current recipients receive this write's change cursor.
        for (const result of results) {
            expect(result).toMatchObject({ ok: true, didWrite: true });
            if (!result.ok) continue;
            expect(result.recipientCursors.map(cursor => cursor.accountId).sort()).toEqual([owner.id, viewer.id].sort());
        }
        const cost = {
            // One Session read serves the mutation context, the access decision and the current recipients.
            // PostgreSQL adds the audience census. SQLite (no census) links each change row to the written
            // Session without an existence read (RED at HEAD 660e99616d9: 3).
            sessionRowReads: inTransaction.filter(isSessionRowRead).length / lines,
        };
        console.info("ACCOUNT_MESSAGE_WRITE_COST", JSON.stringify({ provider, lines, ...cost, transactionRequests: inTransaction.length / lines }));
        expect(cost).toEqual({ sessionRowReads: provider === "sqlite" ? 1 : 2 });
    });

    it("still evaluates remote alerts per line when a follower's policy selects streamed messages", async () => {
        const lines = 4;
        const { postCommit } = await streamTranscriptLines(provider, lines, async ({ ownerId, sessionId }) => {
            const follower = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" }, select: { id: true } });
            await db.sessionGrant.create({ data: { principalKind: "account", sessionId, createdByAccountId: ownerId, accountId: follower.id, accessLevel: "view" } });
            await db.accountSessionFollow.create({ data: { accountId: follower.id, sessionId, following: true, hasPersistentFollow: true,
                followPolicy: JSON.stringify({ preset: "everything" }) } });
        });
        // The alert owner reaches its device read for every line (the follower has no device, so nothing is sent).
        expect(postCommit.filter(request => request.model === "AccountPushToken").length).toBe(lines);
    });
}
