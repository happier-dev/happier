import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { encodeBase64 } from "privacy-kit";
import {
    ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
    SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    encodeMembershipSessionDataKeyEnvelopeCursorV1,
    sealEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
} from "@happier-dev/protocol";

import { admitTeamMemberInTx } from "@/app/teams/memberships/membershipService";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    applyMembershipSessionDataKeyEnvelopes,
    readMembershipSessionDataKeyEnvelopePage,
    type MembershipSessionDataKeyEnvelopeSubject,
} from "./membershipSessionDataKeyEnvelopeService";

/**
 * Named-corpus measurement for the canonical history query.
 *
 * This is evidence, not a timeout or product limit. It runs the real SQLite
 * owner with 10,000 authorized Sessions and reports database/service time for a
 * first page, a continuation near the tail, a whole keyset traversal, the
 * cursorless exception aggregate over a fully prepared target, and one bounded
 * atomic PATCH with its recipient-private invalidation fan-out.
 *
 * Where a number is asserted it is a *shape* guard derived from another
 * measurement taken in the same run on the same host — never an absolute
 * wall-clock budget and never a product limit. The falsified implementation is
 * explicit at each site: a continuation that re-reads the authorized corpus
 * prefix in application code, or an aggregate that reports a caller exception
 * for a target that is already prepared.
 */
const CORPUS_SIZE = 10_000;
const TAIL_CURSOR_SESSION_ID = "scale-session-09899";

function sessionIdAt(index: number): string {
    return `scale-session-${String(index).padStart(5, "0")}`;
}

/** Canonical v1 length with an unsupported version byte: structurally invalid, never a codec crash. */
function unsupportedVersionEnvelope() {
    const bytes = new Uint8Array(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).fill(7);
    bytes[0] = 255;
    return Buffer.from(bytes);
}

describe("Membership history envelope 10k measurement (SQLite)", () => {
    let harness: LightSqliteHarness;
    let managerAccountId: string;
    let subject: MembershipSessionDataKeyEnvelopeSubject;
    let targetEnvelope = Buffer.alloc(0);
    let targetAccountId: string;
    /** Measured cost of one tail keyset continuation; consumed by the corpus-scan comparison. */
    let tailContinuationMs: number | null = null;

    const authentication = {
        env: process.env,
        authority: "present_user",
        authenticationEvidence: undefined,
    } as const;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-membership-envelope-scale-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });

        const signing = tweetnacl.sign.keyPair();
        const managerContent = tweetnacl.box.keyPair();
        const targetSigning = tweetnacl.sign.keyPair();
        const targetContent = tweetnacl.box.keyPair();
        const manager = await db.account.create({ data: {
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(managerContent.publicKey),
            contentPublicKeySig: Buffer.from(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: managerContent.publicKey,
            })),
        } });
        const target = await db.account.create({ data: {
            publicKey: Buffer.from(targetSigning.publicKey).toString("hex"),
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(targetContent.publicKey),
            contentPublicKeySig: Buffer.from(signAccountContentKeyBindingV1({
                accountSigningSecretKey: targetSigning.secretKey,
                contentPublicKey: targetContent.publicKey,
            })),
        } });
        managerAccountId = manager.id;
        targetAccountId = target.id;
        const team = await db.team.create({ data: { name: "10k history" } });
        const admitted = await inTx(async tx => ({
            manager: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: manager.id, role: "owner", historyAccess: "all_existing",
            }),
            target: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: target.id, role: "member", historyAccess: "all_existing",
            }),
        }));
        if (!admitted.manager.ok || !admitted.target.ok) throw new Error("scale membership admission failed");
        subject = {
            kind: "team",
            teamId: team.id,
            teamMembershipId: admitted.target.membership.teamMembershipId,
        };

        const rows = Array.from({ length: CORPUS_SIZE }, (_, index) => ({
            id: sessionIdAt(index),
            tag: `scale-tag-${String(index).padStart(5, "0")}`,
        }));
        await db.session.createMany({ data: rows.map(row => ({
            ...row,
            accountId: manager.id,
            encryptionMode: "e2ee",
            metadata: JSON.stringify({ t: "encrypted", c: "" }),
            seq: 1,
        })) });
        await db.sessionGrant.createMany({ data: (rows.map(row => ({
            sessionId: row.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(0),
        }))).map(data => ({ ...data, principalKind: 'team' })) });
        const dataKey = new Uint8Array(32).fill(73);
        const managerEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey,
            recipientPublicKey: managerContent.publicKey,
            randomBytes: length => new Uint8Array(length).fill(17),
        });
        targetEnvelope = Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey,
            recipientPublicKey: targetContent.publicKey,
            randomBytes: length => new Uint8Array(length).fill(29),
        }));
        await db.sessionDataKeyEnvelope.createMany({ data: rows.map(row => ({
            sessionId: row.id,
            recipientAccountId: manager.id,
            encryptedDataKey: Buffer.from(managerEnvelope),
        })) });
    }, 600_000);

    afterAll(async () => { await harness?.close(); });

    it("measures 10,000 Sessions and starts a continuation strictly after its decoded cursor", async () => {
        const firstStartedAt = performance.now();
        const first = await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: managerAccountId,
            authentication,
            subject,
            query: { state: "action_required", limit: 100 },
        });
        const firstMs = performance.now() - firstStartedAt;
        expect(first.ok && first.page.status === "ready" ? first.page.items.length : -1).toBe(100);
        // Cursorless discovery is the authoritative aggregate owner. Nothing is
        // prepared yet, and every Session is owned by the caller with a valid
        // caller tuple, so both caller-exception buckets are legitimately zero.
        expect(first.ok && first.page.status === "ready" ? first.page.exceptions : null)
            .toEqual({ callerVisibleNonTransferableSessionCount: 0, callerEnvelopeRepairRequiredCount: 0 });

        const cursor = encodeMembershipSessionDataKeyEnvelopeCursorV1("scale-session-08999");
        const continuationStartedAt = performance.now();
        const continuation = await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: managerAccountId,
            authentication,
            subject,
            query: { state: "action_required", limit: 100, cursor },
        });
        const continuationMs = performance.now() - continuationStartedAt;
        if (!continuation.ok || continuation.page.status !== "ready") throw new Error("continuation unavailable");
        expect(continuation.page.items[0]?.sessionId).toBe("scale-session-09000");
        expect(continuation.page.exceptions).toBeNull();
        console.info(JSON.stringify({
            measurement: "membership-history-10k-sqlite",
            sessions: CORPUS_SIZE,
            firstPageMs: Math.round(firstMs),
            continuationNearTailMs: Math.round(continuationMs),
            continuationItems: continuation.page.items.length,
        }));
    }, 300_000);

    it("pages the whole actionable set by keyset without re-reading the delivered prefix", async () => {
        const pageTimingsMs: number[] = [];
        const deliveredSessionIds: string[] = [];
        const servedCursors = new Set<string>();
        let cursor: string | null = null;
        let pages = 0;

        for (;;) {
            const startedAt = performance.now();
            const page = await readMembershipSessionDataKeyEnvelopePage({
                actorAccountId: managerAccountId,
                authentication,
                subject,
                query: cursor === null
                    ? { state: "action_required", limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 }
                    : { state: "action_required", limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1, cursor },
            });
            pageTimingsMs.push(performance.now() - startedAt);
            if (!page.ok || page.page.status !== "ready") throw new Error("traversal page unavailable");
            pages += 1;
            // Only cursorless discovery carries the authoritative aggregate; a
            // continuation that recomputed it would be paying for the whole
            // authorized corpus on every page.
            expect(page.page.exceptions === null).toBe(cursor !== null);
            for (const item of page.page.items) {
                const previous = deliveredSessionIds[deliveredSessionIds.length - 1];
                if (previous !== undefined) expect(item.sessionId > previous).toBe(true);
                deliveredSessionIds.push(item.sessionId);
            }
            if (page.page.nextCursor === null) break;
            expect(servedCursors.has(page.page.nextCursor)).toBe(false);
            servedCursors.add(page.page.nextCursor);
            cursor = page.page.nextCursor;
            expect(pages).toBeLessThanOrEqual(CORPUS_SIZE);
        }

        expect(deliveredSessionIds).toHaveLength(CORPUS_SIZE);
        expect(deliveredSessionIds[0]).toBe(sessionIdAt(0));
        expect(deliveredSessionIds[CORPUS_SIZE - 1]).toBe(sessionIdAt(CORPUS_SIZE - 1));
        expect(pages).toBe(Math.ceil(CORPUS_SIZE / SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1));

        // One bounded tail continuation, kept for the corpus-scan comparison in
        // the next case. Under keyset paging it reads one scan chunk; an
        // application-level prefix rescan would read ~9,900 Sessions here.
        const tailStartedAt = performance.now();
        const tail = await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: managerAccountId,
            authentication,
            subject,
            query: {
                state: "action_required",
                limit: 100,
                cursor: encodeMembershipSessionDataKeyEnvelopeCursorV1(TAIL_CURSOR_SESSION_ID),
            },
        });
        tailContinuationMs = performance.now() - tailStartedAt;
        if (!tail.ok || tail.page.status !== "ready") throw new Error("tail continuation unavailable");
        expect(tail.page.items).toHaveLength(100);
        expect(tail.page.items[0]?.sessionId).toBe(sessionIdAt(9_900));
        expect(tail.page.nextCursor).toBeNull();

        console.info(JSON.stringify({
            measurement: "membership-history-10k-keyset-traversal-sqlite",
            sessions: CORPUS_SIZE,
            pageLimit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
            pages,
            deliveredSessions: deliveredSessionIds.length,
            discoveryPageMs: Math.round(pageTimingsMs[0] ?? 0),
            continuationPagesMs: pageTimingsMs.slice(1).map(value => Math.round(value)),
            totalTraversalMs: Math.round(pageTimingsMs.reduce((total, value) => total + value, 0)),
            tailContinuationMs: Math.round(tailContinuationMs),
        }));
    }, 600_000);

    it("settles a fully prepared 10,000-Session target with zero caller exceptions", async () => {
        await db.sessionDataKeyEnvelope.createMany({ data: Array.from(
            { length: CORPUS_SIZE },
            (_, index) => ({
                sessionId: sessionIdAt(index),
                recipientAccountId: targetAccountId,
                encryptedDataKey: targetEnvelope,
            }),
        ) });

        const startedAt = performance.now();
        const settled = await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: managerAccountId,
            authentication,
            subject,
            query: { state: "action_required", limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 },
        });
        // This request necessarily visits the whole authorized corpus: no Session
        // is actionable, so the walk cannot stop early. It is therefore the
        // same-host, same-run cost of one corpus-wide scan.
        const corpusScanMs = performance.now() - startedAt;
        if (!settled.ok || settled.page.status !== "ready") throw new Error("settled page unavailable");
        expect(settled.page.items).toHaveLength(0);
        expect(settled.page.nextCursor).toBeNull();
        expect(settled.page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 0,
            callerEnvelopeRepairRequiredCount: 0,
        });

        const tailMs = tailContinuationMs;
        if (tailMs === null) throw new Error("tail continuation measurement missing");
        // Shape guard, not a latency budget: a bounded keyset continuation near
        // the tail must cost a small fraction of one corpus-wide scan measured
        // moments earlier on this same host. An implementation that re-read and
        // discarded the ~9,900-Session prefix in application code would land in
        // the same order of magnitude as the scan and fail here.
        expect(tailMs).toBeLessThan(Math.max(200, corpusScanMs / 4));

        console.info(JSON.stringify({
            measurement: "membership-history-10k-settled-aggregate-sqlite",
            sessions: CORPUS_SIZE,
            preparedTargetTuples: CORPUS_SIZE,
            corpusScanMs: Math.round(corpusScanMs),
            tailContinuationMs: Math.round(tailMs),
        }));
    }, 600_000);

    it("keeps unfinished target rows in their exact exception bucket while prepared rows stay silent", async () => {
        const nonTransferable = sessionIdAt(1_000);
        const repairRequired = sessionIdAt(2_000);
        const stillActionable = sessionIdAt(3_000);

        // Three unfinished target rows, distinguished only by the caller's own tuple.
        await db.sessionDataKeyEnvelope.updateMany({
            where: {
                recipientAccountId: targetAccountId,
                sessionId: { in: [nonTransferable, repairRequired, stillActionable] },
            },
            data: { encryptedDataKey: unsupportedVersionEnvelope() },
        });
        await db.sessionDataKeyEnvelope.deleteMany({
            where: { recipientAccountId: managerAccountId, sessionId: nonTransferable },
        });
        await db.sessionDataKeyEnvelope.updateMany({
            where: { recipientAccountId: managerAccountId, sessionId: repairRequired },
            data: { encryptedDataKey: unsupportedVersionEnvelope() },
        });

        const startedAt = performance.now();
        const page = await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: managerAccountId,
            authentication,
            subject,
            query: { state: "action_required", limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 },
        });
        const aggregateMs = performance.now() - startedAt;
        if (!page.ok || page.page.status !== "ready") throw new Error("exception page unavailable");
        // The other 9,997 prepared targets contribute nothing: once the recipient
        // can open the Session, this caller's own tuple is no longer target work.
        expect(page.page.items.map(item => item.sessionId)).toEqual([stillActionable]);
        expect(page.page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 1,
            callerEnvelopeRepairRequiredCount: 1,
        });

        console.info(JSON.stringify({
            measurement: "membership-history-10k-exception-buckets-sqlite",
            sessions: CORPUS_SIZE,
            unfinishedTargetRows: 3,
            aggregateMs: Math.round(aggregateMs),
        }));
    }, 600_000);

    it("commits one bounded history page with exactly one recipient-private invalidation per Session", async () => {
        const entries = Array.from(
            { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 },
            (_, index) => ({
                sessionId: sessionIdAt(index),
                encryptedDataKey: encodeBase64(new Uint8Array(targetEnvelope)),
            }),
        );

        const startedAt = performance.now();
        const applied = await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: managerAccountId,
            authentication,
            subject,
            request: { recipientAccountId: targetAccountId, entries },
        });
        const patchMs = performance.now() - startedAt;
        expect(applied).toEqual({ ok: true, appliedCount: entries.length });

        // Recipient-private `session` invalidation, one per Session, never a
        // shared-room event and never a second `share` row for the same change.
        const invalidations = await db.accountChange.count({
            where: { accountId: targetAccountId, kind: "session" },
        });
        expect(invalidations).toBe(entries.length);
        expect(await db.accountChange.count({
            where: { accountId: targetAccountId, kind: "share" },
        })).toBe(0);
        expect(await db.accountChange.count({
            where: { accountId: managerAccountId, kind: "session" },
        })).toBe(0);

        console.info(JSON.stringify({
            measurement: "membership-history-patch-fanout-sqlite",
            entries: entries.length,
            recipientAccountChanges: invalidations,
            patchMs: Math.round(patchMs),
        }));
    }, 600_000);
});
