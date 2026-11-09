import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { artifactHtmlBundleFromBodyV1 } from "@happier-dev/protocol/artifacts/artifactHtmlV1";
import { mutateSessionBoard } from "@/app/session/board/service";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import { runSessionSystemRecordBackfillOperator } from "./sessionSystemRecordBackfillOperator";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "./sessionSystemRecordProtocolContract";
import {
    deleteSessionSystemRecordV1,
    upsertSessionSystemRecord,
    upsertSessionSystemRecordV1,
    readPublishedSessionSurfaceItemInTx,
} from "./sessionSystemRecordService";

const authentication = createPresentUserSessionAccessAuthentication();

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported SessionSystemRecord DB contract provider: ${raw}`);
}

function synopsisContent(value: string) {
    return {
        t: "plain" as const,
        v: { v: 1 as const, seqTo: 1, updatedAtMs: 1, synopsis: value },
    };
}

async function createAccountAndSession(suffix: string) {
    const account = await db.account.create({
        data: { publicKey: `ssr-contract-${suffix}`, encryptionMode: "plain" },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `ssr-contract-${suffix}`,
            encryptionMode: "plain",
            metadata: "{}",
        },
        select: { id: true },
    });
    return { account, session };
}

async function deleteAccountFixture(accountId: string): Promise<void> {
    await db.session.deleteMany({ where: { accountId } });
    await db.account.delete({ where: { id: accountId } });
}

async function withAccountFenceInterleaving<T>(peer: () => Promise<void>, operation: () => Promise<T>) {
    const originalTransaction = db.$transaction;
    let publishingPeer = false;
    // Coordinate at the genuine Prisma/PostgreSQL boundary. Domain reads,
    // CAS, cursor statements, retries and commits remain real. The peer
    // commits after discovery on each attempt, without sleeps/retry overrides.
    db.$transaction = new Proxy(originalTransaction, {
        apply(target, thisArg, args) {
            const callback: unknown = args[0];
            if (typeof callback !== "function" || publishingPeer) return Reflect.apply(target, thisArg, args);
            return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                let advanced = false;
                return Reflect.apply(callback, undefined, [new Proxy(tx, {
                    get(owner, property, receiver) {
                        if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, receiver);
                        return async (query: string, ...values: unknown[]) => {
                            if (!advanced && query.includes('"Account"')
                                && (query.includes("FOR NO KEY UPDATE") || query.includes("FOR UPDATE") || query.includes('SET "seq"'))) {
                                advanced = true;
                                publishingPeer = true;
                                try { await peer(); } finally { publishingPeer = false; }
                            }
                            return Reflect.apply(owner.$queryRawUnsafe, owner, [query, ...values]);
                        };
                    },
                })]);
            }, args[1]]);
        },
    });
    try { return await operation(); }
    finally { db.$transaction = originalTransaction; }
}

describe("SessionSystemRecord native CONTRACT database behavior", () => {
    const provider = resolveContractProvider();

    it.each(['owner', 'collaborator', 'team collaborator'])('keeps Board upsert placement and removal usable by the %s and refuses a revoked new request', async actor => {
        const { account, session } = await createAccountAndSession(`board-admission-${randomUUID()}`);
        const collaborator = await db.account.create({ data: { publicKey: `board-editor-${randomUUID()}`, encryptionMode: 'plain' } });
        const team = actor === 'team collaborator' ? await db.team.create({ data: { name: 'Board collaborators',
            memberships: { create: { accountId: collaborator.id, role: 'member' } } } }) : null;
        const share = team ? null : await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: account.id,
            sharedWithUserId: collaborator.id, accessLevel: 'edit' } });
        if (team) await db.sessionTeamGrant.create({ data: { sessionId: session.id, teamId: team.id,
            accessLevel: 'edit', effectiveAt: new Date() } });
        const actorUserId = actor === 'owner' ? account.id : collaborator.id;
        const invoke = (mutation: unknown) => mutateSessionBoard({ actorUserId, sessionId: session.id, authentication, mutation });
        const itemContent = { t: 'plain', v: { v: 1, title: 'Admitted', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Owner and collaborator' } } } } };
        const layoutContent = { t: 'plain', v: { v: 1, tabs: [{ id: 'main', title: 'Main', items: [{ itemId: 'visual', width: 'medium' }] }] } };
        try {
            const created = await invoke({ operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null, itemContent,
                placement: { expectedLayoutRevision: null, layoutContent } });
            expect(created).toMatchObject({ ok: true, result: { outcome: 'created' } });
            if (!created.ok || created.result.operation !== 'upsert_item') throw new Error('Expected created item');
            const { itemRevision, layoutRevision } = created.result;
            const changed = await invoke({ operation: 'upsert_item', itemId: 'visual', expectedItemRevision: itemRevision,
                itemContent: { ...itemContent, v: { ...itemContent.v, title: 'Updated' } } });
            if (!changed.ok || changed.result.operation !== 'upsert_item') throw new Error('Expected updated item');
            expect(changed.result.itemRevision).not.toBe(itemRevision);
            await expect(invoke({ operation: 'update_layout', expectedLayoutRevision: layoutRevision, layoutContent,
                itemPlacementParticipant: { itemId: 'visual', expectedItemRevision: itemRevision } }))
                .resolves.toMatchObject({ ok: false, result: { error: 'session_board_revision_conflict' } });
            await expect(invoke({ operation: 'update_layout', expectedLayoutRevision: layoutRevision, layoutContent,
                itemPlacementParticipant: { itemId: 'visual', expectedItemRevision: changed.result.itemRevision } }))
                .resolves.toMatchObject({ ok: true });
            await expect(invoke({ operation: 'remove_item', itemId: 'visual', expectedItemRevision: changed.result.itemRevision,
                expectedLayoutRevision: layoutRevision, layoutContent: { t: 'plain', v: { v: 1, tabs: [] } } }))
                .resolves.toMatchObject({ ok: true, result: { outcome: 'removed' } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id, kind: 'item.v1' } })).toBe(0);
            if (share) await db.sessionShare.delete({ where: { id: share.id } });
            if (team) await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: collaborator.id }, data: { status: 'suspended' } });
            await expect(mutateSessionBoard({ actorUserId: collaborator.id, sessionId: session.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'revoked', expectedItemRevision: null, itemContent } }))
                .resolves.toEqual({ ok: false, result: { error: 'session_board_forbidden' } });
            if (team) await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: collaborator.id }, data: { status: 'active' } });
            else await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: account.id,
                sharedWithUserId: collaborator.id, accessLevel: 'edit' } });
            await expect(mutateSessionBoard({ actorUserId: collaborator.id, sessionId: session.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'revoked', expectedItemRevision: null, itemContent } }))
                .resolves.toMatchObject({ ok: true, result: { outcome: 'created' } });
        } finally {
            await deleteAccountFixture(account.id);
            await deleteAccountFixture(collaborator.id);
            if (team) await db.team.delete({ where: { id: team.id } });
        }
    });

    it('retains exact record publication independently of later transcript changes and current access', async () => {
        const { account, session } = await createAccountAndSession(`record-publication-${randomUUID()}`);
        const viewer = await db.account.create({ data: { publicKey: `record-viewer-${randomUUID()}`, encryptionMode: 'plain' } });
        const share = await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: account.id,
            sharedWithUserId: viewer.id, accessLevel: 'view' } });
        const write = (revision: string | null, title: string) => mutateSessionBoard({ authentication, actorUserId: account.id, sessionId: session.id,
            mutation: { operation: 'update_layout', expectedLayoutRevision: revision,
                layoutContent: { t: 'plain', v: { v: 1, tabs: [{ id: 'main', title, items: [] }] } } } });
        try {
            const created = await write(null, 'First');
            expect(created).toMatchObject({ ok: true, result: { outcome: 'created' } });
            if (!created.ok || created.result.operation !== 'update_layout') throw new Error('Expected layout creation');
            const record = await db.sessionSystemRecord.findFirstOrThrow({ where: { sessionId: session.id } });
            await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id, hint: { lastMessageSeq: 1 } }));
            const target = { v: 1, sessionRecords: { sessionId: session.id,
                address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } } };
            const changes = await db.accountChange.findMany({ where: { kind: 'account', entityId: `session-record:${record.id}` },
                select: { accountId: true, hint: true, cursor: true } });
            expect(changes).toEqual(expect.arrayContaining([
                { accountId: account.id, hint: target, cursor: expect.any(Number) },
                { accountId: viewer.id, hint: target, cursor: expect.any(Number) },
            ]));
            expect(changes).toHaveLength(2);
            const ownerCursor = changes.find(change => change.accountId === account.id)?.cursor;
            await write(created.result.layoutRevision, 'First');
            expect((await db.accountChange.findFirstOrThrow({ where: { kind: 'account', entityId: `session-record:${record.id}`, accountId: account.id } })).cursor).toBe(ownerCursor);
            await db.sessionShare.delete({ where: { id: share.id } });
            const viewerCursor = changes.find(change => change.accountId === viewer.id)?.cursor;
            await write(created.result.layoutRevision, 'Second');
            expect((await db.accountChange.findFirstOrThrow({ where: { kind: 'account', entityId: `session-record:${record.id}`, accountId: viewer.id } })).cursor).toBe(viewerCursor);
        } finally {
            await deleteAccountFixture(account.id);
            await deleteAccountFixture(viewer.id);
        }
    });

    it.skipIf(provider !== 'postgres')('readmits standalone plugin record storage mode after a transition wins before admission', async () => {
        const { account, session } = await createAccountAndSession(`mode-readmission-${randomUUID()}`);
        const originalTransaction = db.$transaction;
        let changed = false;
        db.$transaction = new Proxy(originalTransaction, { apply(transaction, receiver, args: unknown[]) {
            const operation: unknown = args[0];
            if (typeof operation !== 'function') return Reflect.apply(transaction, receiver, args);
            return Reflect.apply(transaction, receiver, [async (tx: Tx) => operation(new Proxy(tx, { get(client, property, txReceiver) {
                if (property !== 'sessionFollowEdge' && property !== 'sessionSystemRecord') return Reflect.get(client, property, txReceiver);
                const delegate = client[property];
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const query: unknown = Reflect.get(model, method, modelReceiver);
                    if (method !== (property === 'sessionFollowEdge' ? 'findMany' : 'findFirst') || typeof query !== 'function') return query;
                    return async (...values: unknown[]) => {
                        // Old standalone writers first reach the record lookup;
                        // admitted writers first discover their Session audience.
                        // In either shape the real transition wins before entry locks.
                        if (!changed) {
                            changed = true;
                            await inTx(async peer => {
                                await acquireAccountSessionOwnerMetadataFenceInTx(peer, account.id, 'exclusive');
                                await peer.session.update({ where: { id: session.id }, data: { encryptionMode: 'e2ee' } });
                            });
                        }
                        return await Reflect.apply(query, model, values);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await upsertSessionSystemRecordV1({ authentication, actorUserId: account.id, sessionId: session.id,
                pluginId: 'acme.notes', address: { owner: 'plugin', namespace: 'notes', kind: 'entry.v1', localId: 'mode-readmission' },
                content: { t: 'plain', v: { title: 'Must not cross a mode transition' } }, expectedRevision: null });
            expect(changed).toBe(true);
            expect(result).toEqual({ ok: false, code: 'plugin_session_record_invalid_query' });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(0);
        } finally {
            db.$transaction = originalTransaction;
            await deleteAccountFixture(account.id);
        }
    });

    it.skipIf(provider !== "postgres")("commits a Board write while an unrelated Account cursor writer commits after its initial reads", async () => {
        const { account, session } = await createAccountAndSession(`board-account-contention-${randomUUID()}`);
        let peerCommitted = false;
        let operationError: unknown;
        try {
            const result = await withAccountFenceInterleaving(async () => {
                await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: "unrelated-projection" }),
                    { isolationLevel: "ReadCommitted" });
                peerCommitted = true;
            }, () => mutateSessionBoard({ authentication, actorUserId: account.id, sessionId: session.id,
                mutation: { operation: "upsert_item", itemId: "visual", expectedItemRevision: null,
                    itemContent: { t: "plain", v: { v: 1, title: "Concurrent visual", frame: "card",
                        height: { mode: "auto", fallback: "regular" }, source: { kind: "declarative",
                            document: { version: 1, root: { kind: "markdown", text: "Committed visual" } } } } } } }));
            expect(peerCommitted).toBe(true);
            expect(result).toMatchObject({ ok: true, result: { outcome: "created" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: session.id } })).toBe(1);
            const changes = await db.accountChange.findMany({ where: { accountId: account.id, cursor: { gt: 0 } },
                orderBy: { cursor: "asc" }, select: { cursor: true, entityId: true } });
            const record = await db.sessionSystemRecord.findFirstOrThrow({ where: { sessionId: session.id } });
            expect(changes.map(change => change.entityId)).toEqual(["unrelated-projection", `session-record:${record.id}`]);
            expect(changes[1].cursor).toBeGreaterThan(changes[0].cursor);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: changes[1].cursor });
        } catch (error) { operationError = error; throw error; }
        finally {
            try { await deleteAccountFixture(account.id); }
            catch (cleanupError) {
                if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Board contention and fixture cleanup failed");
                throw cleanupError;
            }
        }
    });

    it("settles concurrent exact Board creation and leaves no item from a losing aggregate", async () => {
        const exactFixture = await createAccountAndSession(`board-exact-race-${randomUUID()}`);
        const competingFixture = await createAccountAndSession(`board-competing-race-${randomUUID()}`);
        const content = (title: string) => ({ t: "plain", v: { v: 1, title, frame: "card",
            height: { mode: "auto", fallback: "regular" }, source: { kind: "declarative",
                document: { version: 1, root: { kind: "markdown", text: title } } } } });
        const mutation = (itemId: string) => ({ operation: "upsert_item", itemId, expectedItemRevision: null,
            itemContent: content(itemId), placement: { expectedLayoutRevision: null,
                layoutContent: { t: "plain", v: { v: 1, tabs: [{ id: "overview", title: "Overview", items: [{ itemId, width: "medium" }] }] } } } });
        const invoke = (fixture: typeof exactFixture, value: unknown) => mutateSessionBoard({ authentication,
            actorUserId: fixture.account.id, sessionId: fixture.session.id, mutation: value });
        const settle = async (attempts: ReturnType<typeof invoke>[]) => (await Promise.allSettled(attempts)).map(outcome => {
            if (outcome.status === "rejected") throw outcome.reason;
            return outcome.value;
        });
        let operationError: unknown;
        try {
            const exactCreates = await settle([
                invoke(exactFixture, mutation("same")),
                invoke(exactFixture, mutation("same")),
            ]);
            expect(exactCreates).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
            if (!exactCreates[0]?.ok || !exactCreates[1]?.ok) throw new Error("Expected byte-identical create settlement");
            if (exactCreates[0].result.operation !== "upsert_item" || exactCreates[1].result.operation !== "upsert_item") {
                throw new Error("Expected upsert-item settlement");
            }
            expect(exactCreates[1].result.itemRevision).toBe(exactCreates[0].result.itemRevision);
            expect(exactCreates[1].result.layoutRevision).toBe(exactCreates[0].result.layoutRevision);
            expect(await db.sessionSystemRecord.count({ where: { sessionId: exactFixture.session.id } })).toBe(2);

            const firstCreates = await settle([
                invoke(competingFixture, mutation("first")),
                invoke(competingFixture, mutation("second")),
            ]);
            expect(firstCreates.filter(result => result.ok)).toHaveLength(1);
            expect(firstCreates.find(result => !result.ok)).toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: competingFixture.session.id } })).toBe(2);
            const winner = firstCreates.find(result => result.ok);
            if (!winner?.ok || winner.result.operation !== "upsert_item") throw new Error("Expected an acknowledged first create");
            const winnerItemId = winner.result.itemId;
            const expectedLayoutRevision = winner.result.layoutRevision;
            const competing = await settle(["third", "fourth"].map(itemId => invoke(competingFixture, { ...mutation(itemId),
                placement: { expectedLayoutRevision, layoutContent: { t: "plain", v: { v: 1,
                    tabs: [{ id: "overview", title: "Overview", items: [{ itemId: winnerItemId, width: "medium" }, { itemId, width: "medium" }] }] } } } })));
            expect(competing.filter(result => result.ok)).toHaveLength(1);
            expect(competing.find(result => !result.ok)).toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: competingFixture.session.id } })).toBe(3);
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            try {
                await deleteAccountFixture(exactFixture.account.id);
                await deleteAccountFixture(competingFixture.account.id);
            } catch (cleanupError) {
                if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Board operation and fixture cleanup failed");
                throw cleanupError;
            }
        }
    });

    it("preserves Board aggregate atomicity, source authority, placement deletion, and opaque replay", async () => {
        const plainFixture = await createAccountAndSession(`board-aggregate-${randomUUID()}`);
        const encryptedFixture = await createAccountAndSession(`board-encrypted-${randomUUID()}`);
        const itemContent = (title: string) => ({ t: "plain" as const, v: { v: 1 as const, title, frame: "card" as const,
            height: { mode: "auto" as const, fallback: "regular" as const }, source: { kind: "declarative" as const,
                document: { version: 1 as const, root: { kind: "markdown" as const, text: title } } } } });
        const layoutContent = (title: string, itemIds: readonly string[]) => ({ t: "plain" as const, v: { v: 1 as const,
            tabs: [{ id: "overview", title, items: itemIds.map(itemId => ({ itemId, width: "medium" as const })) }] } });
        const invoke = (fixture: typeof plainFixture, mutation: unknown) => mutateSessionBoard({ authentication,
            actorUserId: fixture.account.id, sessionId: fixture.session.id, mutation });
        let operationError: unknown;
        try {
            const initialItem = itemContent("Initial");
            const initialLayout = layoutContent("Overview", ["note"]);
            const created = await invoke(plainFixture, { operation: "upsert_item", itemId: "note",
                itemContent: initialItem, expectedItemRevision: null,
                placement: { layoutContent: initialLayout, expectedLayoutRevision: null } });
            expect(created).toMatchObject({ ok: true, result: { operation: "upsert_item", outcome: "created" } });
            if (!created.ok || created.result.operation !== "upsert_item") throw new Error("Expected initial Board item creation");

            const converted = await invoke(plainFixture, { operation: "upsert_item", itemId: "note",
                itemContent: { ...initialItem, v: { ...initialItem.v,
                    source: { kind: "hostedHtml", source: artifactHtmlBundleFromBodyV1("<p>Different source</p>") } } },
                expectedItemRevision: created.result.itemRevision });
            expect(converted).toEqual({ ok: false, result: { error: "session_board_source_conflict" } });

            const advancedLayout = layoutContent("Advanced", ["note"]);
            const advanced = await invoke(plainFixture, { operation: "update_layout", layoutContent: advancedLayout,
                expectedLayoutRevision: created.result.layoutRevision });
            expect(advanced).toMatchObject({ ok: true, result: { operation: "update_layout", outcome: "updated" } });
            if (!advanced.ok || advanced.result.operation !== "update_layout") throw new Error("Expected layout update");

            const beforeRollback = await db.sessionSystemRecord.findMany({ where: { sessionId: plainFixture.session.id },
                orderBy: { localId: "asc" }, select: { localId: true, content: true, version: true } });

            const rolledBack = await invoke(plainFixture, { operation: "upsert_item", itemId: "note",
                itemContent: itemContent("Must roll back"), expectedItemRevision: created.result.itemRevision,
                placement: { layoutContent: layoutContent("Stale", ["note"]), expectedLayoutRevision: created.result.layoutRevision } });
            expect(rolledBack).toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
            const afterRollback = await db.sessionSystemRecord.findMany({ where: { sessionId: plainFixture.session.id },
                orderBy: { localId: "asc" }, select: { localId: true, content: true, version: true } });
            expect(afterRollback).toEqual(beforeRollback);

            const stillPlaced = await invoke(plainFixture, { operation: "remove_item", itemId: "note",
                expectedItemRevision: created.result.itemRevision, layoutContent: advancedLayout,
                expectedLayoutRevision: advanced.result.layoutRevision });
            expect(stillPlaced).toEqual({ ok: false, result: { error: "session_board_invalid" } });
            expect(await db.sessionSystemRecord.count({ where: { sessionId: plainFixture.session.id, localId: "note" } })).toBe(1);

            const removalLayout = layoutContent("Advanced", []);
            const removal = { operation: "remove_item", itemId: "note", expectedItemRevision: created.result.itemRevision,
                layoutContent: removalLayout, expectedLayoutRevision: advanced.result.layoutRevision };
            const removed = await invoke(plainFixture, removal);
            expect(removed).toMatchObject({ ok: true, result: { operation: "remove_item", outcome: "removed" } });
            await expect(invoke(plainFixture, removal)).resolves.toEqual(removed);
            expect(await db.sessionSystemRecord.findMany({ where: { sessionId: plainFixture.session.id },
                select: { localId: true, content: true } })).toEqual([{ localId: "layout", content: removalLayout }]);

            await db.session.update({ where: { id: encryptedFixture.session.id }, data: { encryptionMode: "e2ee" } });
            const encryptedMutation = { operation: "upsert_item", itemId: "sealed", expectedItemRevision: null,
                itemContent: { t: "encrypted", c: "sealed-item-bytes" },
                placement: { expectedLayoutRevision: null, layoutContent: { t: "encrypted", c: "sealed-layout-bytes" } } };
            const encrypted = await invoke(encryptedFixture, encryptedMutation);
            expect(encrypted).toMatchObject({ ok: true, result: { operation: "upsert_item", outcome: "created" } });
            if (!encrypted.ok || encrypted.result.operation !== "upsert_item") throw new Error("Expected encrypted Board item creation");
            await expect(invoke(encryptedFixture, encryptedMutation)).resolves.toEqual({
                ok: true,
                result: {
                    operation: "upsert_item",
                    outcome: "unchanged",
                    itemId: "sealed",
                    itemRevision: encrypted.result.itemRevision,
                    layoutRevision: encrypted.result.layoutRevision,
                },
            });
            expect(await db.sessionSystemRecord.findMany({ where: { sessionId: encryptedFixture.session.id },
                orderBy: { localId: "asc" }, select: { localId: true } })).toEqual([{ localId: "layout" }, { localId: "sealed" }]);
            await expect(inTx(tx => readPublishedSessionSurfaceItemInTx(tx, { accountId: encryptedFixture.account.id,
                sessionId: encryptedFixture.session.id, itemId: "sealed", encryptionMode: "e2ee" })))
                .resolves.toMatchObject({ content: encryptedMutation.itemContent });
            expect(await db.sessionSystemRecord.findFirst({ where: { sessionId: encryptedFixture.session.id, localId: "layout" },
                select: { content: true } })).toEqual({ content: encryptedMutation.placement.layoutContent });
            await expect(invoke(encryptedFixture, { ...encryptedMutation,
                itemContent: { t: "encrypted", c: "different-sealed-item-bytes" } })).resolves
                .toMatchObject({ ok: false, result: { error: "session_board_revision_conflict" } });
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            try {
                await deleteAccountFixture(plainFixture.account.id);
                await deleteAccountFixture(encryptedFixture.account.id);
            } catch (cleanupError) {
                if (operationError !== undefined) throw new AggregateError([operationError, cleanupError], "Board operation and fixture cleanup failed");
                throw cleanupError;
            }
        }
    });

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = "optional";
        process.env.HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SHARING_SESSION__ENABLED = "1";
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    });

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await db.$disconnect();
    });

    it("exposes only the canonical address identity and list indexes after contraction", async () => {
        const columns = provider === "mysql"
            ? await db.$queryRaw<Array<{
                column_name: string;
                is_nullable: string;
                character_maximum_length: bigint | number | null;
            }>>`
                SELECT
                    COLUMN_NAME AS column_name,
                    IS_NULLABLE AS is_nullable,
                    CHARACTER_MAXIMUM_LENGTH AS character_maximum_length
                FROM information_schema.columns
                WHERE table_schema = DATABASE()
                AND table_name = 'SessionSystemRecord'
                AND column_name IN (
                    'namespace', 'kind', 'ownerKind', 'pluginId',
                    'namespaceAddressKey', 'recordAddressKey', 'version'
                )
            `
            : await db.$queryRaw<Array<{
                column_name: string;
                is_nullable: string;
                character_maximum_length: number | null;
            }>>`
                SELECT column_name, is_nullable, character_maximum_length
                FROM information_schema.columns
                WHERE table_schema = 'public'
                AND table_name = 'SessionSystemRecord'
                AND column_name IN (
                    'namespace', 'kind', 'ownerKind', 'pluginId',
                    'namespaceAddressKey', 'recordAddressKey', 'version'
                )
            `;
        const byName = new Map(columns.map((column) => [column.column_name, column]));

        expect(byName.get("ownerKind")?.is_nullable).toBe("NO");
        expect(byName.get("pluginId")?.is_nullable).toBe("YES");
        expect(byName.get("namespaceAddressKey")?.is_nullable).toBe("NO");
        expect(byName.get("recordAddressKey")?.is_nullable).toBe("NO");
        expect(byName.get("version")?.is_nullable).toBe("NO");
        if (provider === "mysql") {
            expect(Number(byName.get("namespace")?.character_maximum_length)).toBe(64);
            expect(Number(byName.get("kind")?.character_maximum_length)).toBe(64);
        }

        const indexes = provider === "mysql"
            ? await db.$queryRaw<Array<{ index_name: string }>>`
                SELECT DISTINCT INDEX_NAME AS index_name
                FROM information_schema.statistics
                WHERE table_schema = DATABASE()
                AND table_name = 'SessionSystemRecord'
            `
            : await db.$queryRaw<Array<{ index_name: string }>>`
                SELECT indexname AS index_name
                FROM pg_indexes
                WHERE schemaname = 'public'
                AND tablename = 'SessionSystemRecord'
            `;
        const indexNames = indexes.map((index) => index.index_name);
        expect(indexNames).toContain("SessionSystemRecord_account_session_record_key");
        expect(indexNames).toContain("SessionSystemRecord_account_namespace_kind_updated_idx");
        expect(indexNames).not.toContain("SessionSystemRecord_accountId_sessionId_namespace_localId_key");
        expect(indexNames).not.toContain("SessionSystemRecord_account_kind_updated_idx");
    });

    it("persists canonical host records and makes a derived-key mismatch fail the final audit", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(suffix);
        const localId = `memory:synopsis:v1:${suffix}`;
        try {
            await expect(upsertSessionSystemRecord({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: synopsisContent("one"),
            })).resolves.toMatchObject({ ok: true, didCreate: true, didUpdate: false });

            await expect(upsertSessionSystemRecord({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                namespace: "memory",
                kind: "synopsis.v1",
                localId,
                content: synopsisContent("two"),
            })).resolves.toMatchObject({ ok: true, didCreate: false, didUpdate: true });

            const expected = deriveSessionSystemRecordAddressKeys({
                ownerKind: "host",
                pluginId: null,
                namespace: "memory",
                localId,
            });
            const stored = await db.sessionSystemRecord.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    sessionId: session.id,
                    recordAddressKey: expected.recordAddressKey,
                },
            });
            expect(stored.ownerKind).toBe("host");
            expect(stored.pluginId).toBeNull();
            expect(stored.namespaceAddressKey).toHaveLength(32);
            expect(stored.recordAddressKey).toHaveLength(32);
            expect(stored.version).toBe(2);

            await expect(runSessionSystemRecordBackfillOperator({
                pageSize: 100,
                timeBudgetMs: 10_000,
            })).resolves.toMatchObject({
                outcome: "drained",
                processed: 0,
                updated: 0,
                audit: { nullRows: 0, mismatchedRows: 0 },
            });

            await db.sessionSystemRecord.update({
                where: { id: stored.id },
                data: { recordAddressKey: Buffer.alloc(32, 0xa5) },
            });
            await expect(runSessionSystemRecordBackfillOperator({
                pageSize: 100,
                timeBudgetMs: 10_000,
            })).resolves.toMatchObject({
                outcome: "verification_failed",
                audit: { nullRows: 0, mismatchedRows: 1 },
            });
        } finally {
            await deleteAccountFixture(account.id);
        }
    });

    it("keeps plugin-qualified revisions distinct and enforces conditional update and delete", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`plugin-${suffix}`);
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: `note:${suffix}`,
        };
        try {
            const first = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "One" } },
                expectedRevision: null,
            });
            expect(first).toMatchObject({ ok: true, record: { revision: expect.stringMatching(/^ssr1\./) } });
            if (!first.ok) throw new Error("Expected first plugin record write to succeed");

            const secondPlugin = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.other",
                address,
                content: { t: "plain", v: { title: "Other" } },
                expectedRevision: null,
            });
            expect(secondPlugin).toMatchObject({ ok: true });

            const updated = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Two" } },
                expectedRevision: first.record.revision,
            });
            expect(updated).toMatchObject({ ok: true, record: { revision: expect.stringMatching(/^ssr1\./) } });
            if (!updated.ok) throw new Error("Expected conditional plugin record update to succeed");
            expect(updated.record.revision).not.toBe(first.record.revision);

            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: first.record.revision,
            })).resolves.toMatchObject({ ok: false, code: "plugin_session_record_revision_conflict" });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: updated.record.revision,
            })).resolves.toEqual({ ok: true });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                expectedRevision: updated.record.revision,
            })).resolves.toEqual({ ok: true });
        } finally {
            await deleteAccountFixture(account.id);
        }
    });

    it("distinguishes omitted settlement from create-only and caller-CAS revisions", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`settlement-${suffix}`);
        const address = {
            owner: "plugin" as const,
            namespace: "notes",
            kind: "entry.v1",
            localId: `note:${suffix}`,
        };
        try {
            const created = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Created" } },
                expectedRevision: null,
            });
            if (!created.ok) throw new Error("Expected create-only plugin record write to succeed");

            const settled = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Settled" } },
            });
            expect(settled).toMatchObject({
                ok: true,
                record: { content: { t: "plain", v: { title: "Settled" } } },
            });
            if (!settled.ok) throw new Error("Expected omitted revision to settle the current plugin record");
            expect(settled.record.revision).not.toBe(created.record.revision);

            await expect(upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Create only" } },
                expectedRevision: null,
            })).resolves.toEqual({
                ok: false,
                code: "plugin_session_record_revision_conflict",
                currentRevision: settled.record.revision,
            });
            await expect(upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Stale CAS" } },
                expectedRevision: created.record.revision,
            })).resolves.toEqual({
                ok: false,
                code: "plugin_session_record_revision_conflict",
                currentRevision: settled.record.revision,
            });

            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
            const recreated = await upsertSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
                content: { t: "plain", v: { title: "Recreated" } },
                expectedRevision: null,
            });
            expect(recreated).toMatchObject({ ok: true });
            await expect(deleteSessionSystemRecordV1({ authentication,
                actorUserId: account.id,
                sessionId: session.id,
                pluginId: "acme.notes",
                address,
            })).resolves.toEqual({ ok: true });
        } finally {
            await deleteAccountFixture(account.id);
        }
    });

    it("stores byte-distinct same-session identities for case Unicode and punctuation", async () => {
        const suffix = randomUUID();
        const { account, session } = await createAccountAndSession(`identity-${suffix}`);
        const localIds = ["Case", "case", "é", "e\u0301", "punct:[]!._-"] as const;
        try {
            const storedKeys: Buffer[] = [];
            for (const localId of localIds) {
                const keys = deriveSessionSystemRecordAddressKeys({
                    ownerKind: "host",
                    pluginId: null,
                    namespace: "memory",
                    localId,
                });
                const stored = await db.sessionSystemRecord.create({
                    data: {
                        accountId: account.id,
                        sessionId: session.id,
                        namespace: "memory",
                        kind: "synopsis.v1",
                        localId,
                        content: synopsisContent(localId),
                        ownerKind: "host",
                        pluginId: null,
                        namespaceAddressKey: keys.namespaceAddressKey,
                        recordAddressKey: keys.recordAddressKey,
                        version: 1,
                    },
                });
                storedKeys.push(Buffer.from(stored.recordAddressKey ?? []));
            }

            expect(new Set(storedKeys.map((key) => key.toString("hex"))).size).toBe(localIds.length);
            expect(storedKeys[0]!.equals(storedKeys[1]!)).toBe(false);
            expect(storedKeys[2]!.equals(storedKeys[3]!)).toBe(false);
        } finally {
            await deleteAccountFixture(account.id);
        }
    });
});
