import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { invalidateSessionRelationProjectionsInTx } from '@/app/session/relations/sessionRelationChanges';
import { markPendingStateChangedRecipients } from '@/app/session/pending/markPendingStateChangedRecipients';
import { updateSessionMetadata } from '@/app/session/sessionWriteService';
import { readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { markSessionProjectionRecipientsChanged } from "./markSessionProjectionRecipientsChanged";
import { eventRouter } from "@/app/events/eventRouter";
import { PrismaClient } from "../../../../generated/sqlite-client";
import { sourceKeyForSessionFollowSourceV1 } from "@/app/session/follow/sessionFollowSourceIdentity";
import { mutateSessionBoard } from '@/app/session/board/service';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';

describe("markSessionProjectionRecipientsChanged publication privacy (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-change-publication-privacy-",
            initAuth: false,
            env: { HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: '1', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' },
        });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 120_000);

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await harness.close();
    });

    afterEach(async () => {
        eventRouter.clearIo();
        await harness.resetDbTables([
            () => db.sessionFollowEdge.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it.each(['pending', 'metadata'] as const)('keeps a receiver Follow wake independent of unrelated Session changes and cursor acknowledgement (%s)', async kind => {
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const receiver = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionFollowEdge.create({ data: { sourceSessionId: source.id, destinationSessionId: receiver.id,
            sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), policyJson: '{"preset":"important"}' } });
        const receiverChange = `session-follow-receiver:${receiver.id}`;
        const reads = (after: number) => db.accountChange.findMany({ where: { accountId: account.id,
            kind: 'account', entityId: receiverChange, cursor: { gt: after } } });
        for (let i = 0; i < 10; i++) {
            if (kind === 'pending') await inTx(tx => markPendingStateChangedRecipients({
                tx, sessionId: source.id, pendingVersion: i, pendingCount: 0,
            }));
            else expect(await updateSessionMetadata({ actorUserId: account.id, sessionId: source.id,
                authentication: createPresentUserSessionAccessAuthentication(), expectedVersion: i,
                metadataCiphertext: JSON.stringify({ name: `Metadata ${i}` }),
            })).toMatchObject({ ok: true });
        }
        expect(await reads(0)).toHaveLength(0);
        const wake = vi.spyOn(eventRouter, 'emitUpdate');
        try {
            await inTx(async tx => {
                await tx.session.update({ where: { id: source.id }, data: { seq: 1 } });
                await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id, hint: { lastMessageSeq: 1 } });
            });
            // Adding a known Follow key must not broaden the existing receiver
            // records invalidation into an Account-wide unknown-domain wake.
            expect(wake.mock.calls.map(([input]) => input.payload.body)).toContainEqual(expect.objectContaining({
                t: 'account-change', sessionSystemRecords: [{ sessionId: receiver.id }],
            }));
        } finally { wake.mockRestore(); }
        // A later generic Session write must not overwrite the pending Follow wake.
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: receiver.id,
            hint: { pendingVersion: 11 } }));
        const changes = await reads(0);
        expect(changes).toHaveLength(1);
        expect(readSessionFollowReceiverChangeV1(changes[0]!)).toBe(receiver.id);
        expect(await reads(changes[0]!.cursor)).toHaveLength(0);
        await expect(inTx(async tx => {
            await invalidateSessionRelationProjectionsInTx(tx, [receiver.id]);
            throw new Error('follow-rollback');
        })).rejects.toThrow('follow-rollback');
        expect(await reads(changes[0]!.cursor)).toHaveLength(0);
    });

    it("keeps relation fanout set-oriented while preserving hints, complete audiences and committed wakes", async () => {
        // Trace real SQL from the disposable harness database. Rebind only the
        // transaction transport; all production owners and database operations run.
        const tracedClient = new PrismaClient({ log: [{ level: "query", emit: "event" }] });
        const statements: string[] = [];
        tracedClient.$on("query", event => statements.push(event.query));
        const originalTransaction = db.$transaction;
        // Provider-generated clients implement the same transaction boundary.
        db.$transaction = new Proxy(originalTransaction, {
            apply(_target, _thisArg, args) {
                return Reflect.apply(tracedClient.$transaction, tracedClient, args);
            },
        });
        const broadcast = vi.spyOn(eventRouter, "emitSessionBroadcast");
        const wake = vi.spyOn(eventRouter, "emitUpdate");
        const settleBroadcasts = async () => {
            for (let settled = -1; settled !== broadcast.mock.results.length;) {
                settled = broadcast.mock.results.length;
                await Promise.all(broadcast.mock.results.map(result => result.type === "return" ? result.value : undefined));
            }
        };
        try {
            const traceFanout = async (audienceSize: number, destinationCount: number) => {
                const accounts = await Promise.all(Array.from({ length: audienceSize }, () => db.account.create({
                    data: { publicKey: `relation-recipient-${crypto.randomUUID()}`, encryptionMode: "plain" },
                    select: { id: true },
                })));
                const owner = accounts[0];
                const source = await db.session.create({ data: {
                    accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}",
                    seq: 2, currentStorageState: "snapshot_complete", acceptedThroughServerSeq: 2,
                    materializationPublicationId: "relation-publication", materializedThroughSourceAt: 20_000n,
                    publishedThroughServerSeq: 2,
                } });
                const destinations = await Promise.all(Array.from({ length: destinationCount }, () => db.session.create({
                    data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain", metadata: "{}" },
                })));
                const lead = destinations[0];
                await db.sessionShare.createMany({ data: [source, ...destinations].flatMap(session => accounts.slice(1).map(account => ({
                    sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: account.id, accessLevel: "view",
                }))) });
                await db.sessionFollowEdge.create({ data: { sourceSessionId: source.id, destinationSessionId: lead.id,
                    sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
                    policyJson: JSON.stringify({ preset: 'important' }),
                    relation: 'manager', managerSourceSessionId: source.id } });
                await db.sessionFollowEdge.createMany({ data: destinations.map(destination => ({
                    sourceSessionId: source.id, destinationSessionId: destination.id,
                    sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }),
                    policyJson: JSON.stringify({ preset: 'important' }),
                })) });
                await db.accountChange.createMany({ data: accounts.map((account, index) => ({
                    accountId: account.id, kind: "session", entityId: lead.id, sessionId: lead.id,
                    cursor: 0, hint: { sharedMetadataVersion: index + 7 },
                })) });

                statements.length = 0;
                wake.mockClear();
                const cursors = await inTx(async tx => {
                    await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
                    const result = await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id,
                        recipientAccountIds: accounts.map(account => account.id),
                        hint: { latestTurnId: "private-turn", latestTurnStatus: "failed" } });
                    expect(broadcast.mock.calls.filter(([input]) => destinations.some(destination => destination.id === input.sessionId))).toEqual([]);
                    expect(wake.mock.calls).toEqual([]);
                    return result;
                });
                // SQLite's shared Account admission owner currently fences each
                // recipient separately. Count the Follow/publication work here,
                // not that provider-wide admission policy (Postgres is set-based).
                const trace = statements.filter(query => !query.startsWith('UPDATE "Account" SET "settingsVersion" = "settingsVersion"'));
                await settleBroadcasts();
                expect(cursors.map(cursor => cursor.accountId)).toEqual([owner.id]);
                const changes = await db.accountChange.findMany({ where: { sessionId: { in: [source.id, ...destinations.map(destination => destination.id)] } },
                    select: { accountId: true, sessionId: true, hint: true, cursor: true } });
                expect(changes.filter(change => change.sessionId === lead.id).map(change => change.accountId).sort())
                    .toEqual(accounts.map(account => account.id).sort());
                for (const [index, account] of accounts.entries()) {
                    expect(changes.find(change => change.sessionId === lead.id && change.accountId === account.id)?.hint)
                        .toEqual({ sharedMetadataVersion: index + 7 });
                }
                expect(changes.filter(change => change.sessionId === source.id)).toEqual([expect.objectContaining({
                    accountId: owner.id, hint: { latestTurnId: "private-turn", latestTurnStatus: "failed" },
                })]);
                for (const destination of destinations) {
                    const destinationChanges = changes.filter(change => change.sessionId === destination.id);
                    expect(destinationChanges.map(change => change.accountId).sort()).toEqual(accounts.map(account => account.id).sort());
                    expect(broadcast.mock.calls.filter(([input]) => input.sessionId === destination.id)
                        .map(([input]) => input.userId).sort()).toEqual(accounts.map(account => account.id).sort());
                    if (destination.id !== lead.id) expect(destinationChanges.every(change => change.hint === null)).toBe(true);
                }
                const beforeRollback = await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
                    orderBy: { id: "asc" }, select: { id: true, seq: true } });
                for (const account of beforeRollback) {
                    expect(account.seq).toBe(2 * destinationCount + (account.id === owner.id ? 1 : 0));
                    const accountCursors = changes.filter(change => change.accountId === account.id).map(change => change.cursor);
                    expect(new Set(accountCursors).size).toBe(accountCursors.length);
                    expect(wake.mock.calls.some(([input]) => input.userId === account.id
                        && input.payload.seq === account.seq && input.payload.body.t === "account-change")).toBe(true);
                }
                broadcast.mockClear();
                wake.mockClear();
                await expect(inTx(async tx => {
                    await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
                    await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id });
                    throw new Error("relation-rollback");
                })).rejects.toThrow("relation-rollback");
                await settleBroadcasts();
                expect(broadcast.mock.calls).toEqual([]);
                expect(wake.mock.calls).toEqual([]);
                expect(await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
                    orderBy: { id: "asc" }, select: { id: true, seq: true } })).toEqual(beforeRollback);
                return trace;
            };
            const small = await traceFanout(2, 1);
            broadcast.mockClear();
            const large = await traceFanout(8, 4);
            // Source publication still uses its hint-sensitive writer. Relation
            // audience/destination growth must not add database round trips.
            expect(large.length).toBeLessThanOrEqual(small.length);
        } finally {
            broadcast.mockRestore();
            wake.mockRestore();
            db.$transaction = originalTransaction;
            await tracedClient.$disconnect();
        }
    });

    it("does not create a collaborator AccountChange for post-publication private state", async () => {
        const [owner, collaborator] = await Promise.all([
            db.account.create({
                data: {
                    publicKey: `pk-session-change-owner-${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            }),
            db.account.create({
                data: {
                    publicKey: `pk-session-change-collaborator-${crypto.randomUUID()}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            }),
        ]);
        const session = await db.session.create({
            data: {
                tag: `session-change-finite-${crypto.randomUUID()}`,
                accountId: owner.id,
                encryptionMode: "plain",
                metadata: "{}",
                agentState: null,
                seq: 2,
                currentStorageState: "snapshot_complete",
                acceptedThroughServerSeq: 2,
                materializationPublicationId: "change-publication-v1",
                materializedThroughSourceAt: 20_000n,
                publishedThroughServerSeq: 2,
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: collaborator.id,
                accessLevel: "view",
            },
        });

        await inTx(async (tx) => await markSessionProjectionRecipientsChanged({
            tx,
            sessionId: session.id,
            hint: {
                latestTurnId: "post-publication-turn",
                latestTurnStatus: "failed",
                pendingPermissionRequestCount: 1,
                latestReadyEventSeq: 9,
                meaningfulActivityAt: 90_000,
            },
        }));

        const changes = await db.accountChange.findMany({
            where: { sessionId: session.id },
            orderBy: { accountId: "asc" },
            select: { accountId: true, hint: true },
        });
        expect(changes).toEqual([
            expect.objectContaining({
                accountId: owner.id,
                hint: expect.objectContaining({
                    latestTurnId: "post-publication-turn",
                    latestTurnStatus: "failed",
                }),
            }),
        ]);
        expect(changes.some((change) => change.accountId === collaborator.id)).toBe(false);

        const result = await mutateSessionBoard({ actorUserId: owner.id, sessionId: session.id,
            authentication: createPresentUserSessionAccessAuthentication(), mutation: { operation: 'update_layout', expectedLayoutRevision: null,
                layoutContent: { t: 'plain', v: { v: 1, tabs: [] } } } });
        expect(result).toMatchObject({ ok: true, result: { outcome: 'created' } });
        const stored = await db.sessionSystemRecord.findFirstOrThrow({ where: { sessionId: session.id } });
        expect(await db.accountChange.findFirst({ where: { kind: 'account', entityId: `session-record:${stored.id}`, accountId: collaborator.id }, select: { hint: true } }))
            .toEqual({ hint: { v: 1, sessionRecords: { sessionId: session.id,
                address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } } } });
    });
});
