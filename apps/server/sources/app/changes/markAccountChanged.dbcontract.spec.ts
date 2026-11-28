import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConnectedServicesAccountChangeV1, readSessionFollowSourceChangedV1, readSessionFollowReceiverAvailabilityChangedV1, readSessionTranscriptRevisedV1, SessionDeletedChangeHintV1Schema } from '@happier-dev/protocol/changes';

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import { inTx, transactionResult } from "@/storage/inTx";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { markAccountChanged, markAccountsChanged, markSessionAccountsChanged, markAccountProjectionChanges } from "./markAccountChanged";
import { acquireSessionAccountCursorLocksInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { recordConnectedServiceAccountProfileChange } from '@/app/api/routes/connect/connectedServicesAccountProfileChange';
import { markDiscussionPrivateReaderChangedInTx } from '@/app/discussions/changes';
import { invalidateSessionRelationProjectionsInTx } from '@/app/session/relations/sessionRelationChanges';
import { readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { observeLazyPrismaQuery } from './accountPublicationContention.testkit';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = String(
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres",
    ).trim().toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported AccountChange DB contract provider: ${raw}`);
}

const provider = resolveContractProvider();
const publicKeyPrefix = "dbcontract-account-change-coalescing-";

describe("AccountChange coalescing database contract", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for db contract tests).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        eventRouter.clearIo();
        await db.session.deleteMany({ where: { account: { publicKey: { startsWith: publicKeyPrefix } } } });
        await db.artifact.deleteMany({ where: { account: { publicKey: { startsWith: publicKeyPrefix } } } });
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) await db.$disconnect();
    });

    it('carries on each Account wake exactly the rows its transaction stored, from both publishers', async () => {
        const owner = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const viewer = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: `rows-${randomUUID()}`, metadata: '{}' } });
        const emitted: Array<{ userId: string; rows: unknown }> = [];
        const emitUpdate = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation((params) => {
            if (params.accountChangeFromCursor !== undefined) emitted.push({ userId: params.userId, rows: params.accountChangeRows });
        });
        try {
            // The point writer coalesces Session hints in SQL; the set writer allocates for many Accounts at once.
            await inTx(async tx => {
                await markAccountChanged(tx, { accountId: owner.id, kind: 'session', entityId: session.id,
                    hint: { pendingCount: 1, pendingVersion: 1 } });
                await markAccountChanged(tx, { accountId: owner.id, kind: 'session', entityId: session.id,
                    hint: { pendingCount: 2, pendingVersion: 2 } });
                await markAccountChanged(tx, { accountId: owner.id, kind: 'account', entityId: 'public-profile' });
            });
            await inTx(tx => markAccountsChanged(tx, { accountIds: [owner.id, viewer.id], kind: 'machine', entityId: `machine-${randomUUID()}` }));
            const stored = async (accountId: string) => (await db.accountChange.findMany({ where: { accountId },
                select: { cursor: true, kind: true, entityId: true, changedAt: true, hint: true } }))
                .map(row => ({ ...row, hint: row.hint ?? null }));
            const pushedFor = (accountId: string) => emitted.filter(entry => entry.userId === accountId)
                .flatMap(entry => entry.rows as unknown[]);
            const byCursor = (rows: unknown[]) => [...rows].sort((left, right) =>
                (left as { cursor: number }).cursor - (right as { cursor: number }).cursor);
            expect(byCursor(pushedFor(owner.id))).toEqual(byCursor(await stored(owner.id)));
            expect(byCursor(pushedFor(viewer.id))).toEqual(byCursor(await stored(viewer.id)));
            expect(pushedFor(owner.id)).toHaveLength(3);
        } finally {
            emitUpdate.mockRestore();
        }
    });

    it('retains every known Artifact kind through transitions and keeps unknown catch-up coarse', async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id,
            kind: 'v1:other:bot_template.v1', header: Buffer.from('header'), body: Buffer.from('body'), dataEncryptionKey: Buffer.from('key') } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
            accountId: account.id, kind: 'artifact', entityId: artifact.id,
        } } });
        const publish = (hint?: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'artifact', entityId: artifact.id, hint,
        }));
        await publish();
        expect((await read()).hint).toMatchObject({ artifactKinds: ['v1:other:bot_template.v1'] });
        await db.artifact.update({ where: { id: artifact.id }, data: { kind: 'v1:prompt:prompt_doc.v2' } });
        await publish({ artifactKinds: ['v1:other:bot_template.v1', 'v1:prompt:prompt_doc.v2'] });
        await publish();
        expect((await read()).hint).toMatchObject({ artifactKinds: expect.arrayContaining([
            'v1:other:bot_template.v1', 'v1:prompt:prompt_doc.v2',
        ]) });
        await db.artifact.update({ where: { id: artifact.id }, data: { kind: null } });
        await publish();
        await db.artifact.update({ where: { id: artifact.id }, data: { kind: 'v1:other:bot_template.v1' } });
        await publish();
        expect((await read()).hint).not.toHaveProperty('artifactKinds');
    });

    it(`retains receiver availability across point and batch coalescing only for unconsumed readers on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const point = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint,
        }));
        await point({ pendingVersion: 1 });
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), 0)).toBe(false);
        await inTx(tx => markSessionProjectionRecipientsChanged({ tx, sessionId: session.id,
            recipientAccountIds: [account.id], hint: { runtimeActivityRevision: 1 }, followSourceChanged: false,
            followReceiverAvailabilityChanged: true }));
        const availability = await read();
        await point({ metadataVersion: 2, followSourceChanged: false });
        const title = await read();
        expect(readSessionFollowReceiverAvailabilityChangedV1(title, availability.cursor - 1)).toBe(true);
        expect(readSessionFollowReceiverAvailabilityChangedV1(title, availability.cursor)).toBe(false);
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), availability.cursor - 1)).toBe(true);
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), title.cursor)).toBe(false);
        expect(readSessionFollowSourceChangedV1(await read(), title.cursor)).toBe(true);
        await point({ lastMessageSeq: 2 });
        expect(readSessionFollowReceiverAvailabilityChangedV1(await read(), title.cursor)).toBe(false);
        expect(readSessionFollowSourceChangedV1(await read(), title.cursor)).toBe(true);
        const deletion = SessionDeletedChangeHintV1Schema.parse({ v: 1, lifecycle: 'deleted' });
        await point({ runtimeActivityRevision: 2, followReceiverAvailabilityChanged: true });
        await point(deletion);
        expect((await read()).hint).toEqual(deletion);
        await point({ runtimeActivityRevision: 3, followReceiverAvailabilityChanged: true });
        await inTx(tx => markAccountProjectionChanges(tx, 'session', new Map([[session.id, [account.id]]]), deletion));
        expect((await read()).hint).toEqual(deletion);
    });

    it(`keeps Workflow origin delivery visible under later point and batch changes on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const point = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint,
        }));
        await point({ lastMessageSeq: 1 });
        const append = await read();
        expect(append.hint).toMatchObject({ workflowOriginUnchangedSinceCursor: append.cursor - 1 });
        await point({ kind: 'workflow-run-delivery', runId: 'origin-run', revision: 2 });
        const delivery = await read();
        expect(delivery.hint).not.toHaveProperty('workflowOriginUnchangedSinceCursor');
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect((await read()).hint).toMatchObject({ workflowOriginUnchangedSinceCursor: delivery.cursor });
        await point({ lastMessageSeq: 2, workflowOriginUnchangedSinceCursor: 0 });
        expect((await read()).hint).toMatchObject({ workflowOriginUnchangedSinceCursor: delivery.cursor });
    });

    it(`retains a transcript revision under later append and batch coalescing only for unconsumed readers on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id },
        } });
        const point = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'session', entityId: session.id, hint,
        }));
        await point({ lastMessageSeq: 1, transcriptRevisedAtCursor: 1 });
        expect(readSessionTranscriptRevisedV1(await read(), 0)).toBe(false);
        await point({ updatedMessageSeq: 1, updatedMessageId: 'revised' });
        const revision = await read();
        expect(readSessionTranscriptRevisedV1(revision, revision.cursor - 1)).toBe(true);
        await point({ lastMessageSeq: 2 });
        expect(readSessionTranscriptRevisedV1(await read(), revision.cursor - 1)).toBe(true);
        expect(readSessionTranscriptRevisedV1(await read(), revision.cursor)).toBe(false);
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        await point({ lastMessageSeq: 3 });
        expect(readSessionTranscriptRevisedV1(await read(), revision.cursor - 1)).toBe(true);
        expect(readSessionTranscriptRevisedV1(await read(), revision.cursor)).toBe(false);
    });

    it(`retains a cursor-relative Follow receiver wake across unrelated Session writes on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const entityId = `session-follow-receiver:${session.id}`;
        const read = (after: number) => db.accountChange.findMany({ where: { accountId: account.id,
            kind: 'account', entityId, cursor: { gt: after } } });
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { pendingVersion: 1 } }));
        expect(await read(0)).toHaveLength(0);
        await inTx(tx => invalidateSessionRelationProjectionsInTx(tx, [session.id]));
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { pendingVersion: 2 } }));
        const rows = await read(0);
        expect(rows).toHaveLength(1);
        expect(readSessionFollowReceiverChangeV1(rows[0]!)).toBe(session.id);
        expect(await read(rows[0]!.cursor)).toHaveLength(0);
    });

    it(`keeps projection-only Session changes distinguishable without hiding a coalesced original on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const read = () => db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: 'session', entityId: session.id } },
        });
        const metadata = (version: number) => inTx(tx => markSessionProjectionRecipientsChanged({ tx,
            sessionId: session.id, recipientAccountIds: [account.id], hint: { metadataVersion: version }, followSourceChanged: false,
        }));
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id,
            hint: { lastMessageSeq: 1 } }));
        const original = await read();
        await metadata(1);
        await metadata(2);
        const projection = await read();
        expect(projection.hint).toMatchObject({ metadataVersion: 2, followSourceChanged: false,
            followReceiverAvailabilityChanged: false,
            followSourceUnchangedSinceCursor: original.cursor });
        await inTx(tx => markSessionAccountsChanged(tx, new Map([[session.id, [account.id]]])));
        expect(readSessionFollowSourceChangedV1(await read(), projection.cursor)).toBe(true);
        const changed = await read();
        await metadata(3);
        expect((await read()).hint).toMatchObject({ followSourceChanged: false,
            followSourceUnchangedSinceCursor: changed.cursor });
        const beforePoint = await read();
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'session', entityId: session.id }));
        const point = await read();
        expect(readSessionFollowSourceChangedV1(point, beforePoint.cursor)).toBe(true);
        await metadata(4);
        expect((await read()).hint).toMatchObject({ followSourceChanged: false,
            followSourceUnchangedSinceCursor: point.cursor });
    });

    it(`publishes Team source changes only for the changed service on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const team = await db.team.create({ data: { name: 'Service publication scope' } });
        const shared = { pluginId: 'test.connected', localId: 'shared' };
        const unrelated = { ...shared, localId: 'unshared' };
        try {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'owner' } });
            const resource = await db.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: account.id, displayName: 'Source scope',
                disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed',
                sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account',
                    target: { kind: 'account', account: { service: shared, accountId: 'source-account' } },
                    credentialIncarnation: 'source-incarnation' }),
            } });
            let checkpoint = 0;
            const teamPublications = async (service?: typeof shared) => {
                await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id,
                    ...(service ? { service } : {}) }));
                const rows = await db.accountChange.findMany({ where: { accountId: account.id,
                    kind: 'account', entityId: 'teams', cursor: { gt: checkpoint } } });
                checkpoint = (await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq;
                return rows.length;
            };
            expect(await teamPublications(unrelated)).toBe(0);
            expect(await teamPublications(shared)).toBe(1);
            await db.teamCredentialResource.update({ where: { id: resource.id }, data: {
                sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_pool',
                    target: { kind: 'group', service: shared, groupId: 'source-pool' }, poolIncarnation: 'source-pool-incarnation' }),
            } });
            expect(await teamPublications(unrelated)).toBe(0);
            expect(await teamPublications(shared)).toBe(1);
            expect(await teamPublications()).toBe(1);
            await db.teamCredentialResource.update({ where: { id: resource.id }, data: { sourceBindingJson: '{}' } });
            // An unreadable binding cannot prove a service irrelevant; retain
            // the broad wake so current admission can withdraw stale material.
            expect(await teamPublications(unrelated)).toBe(1);
        } finally { await db.team.delete({ where: { id: team.id } }); }
    });

    it.each(['read-first', 'resource-first'] as const)(`retains the union of private Discussion read-state and resource changes (%s) on ${provider}`, async order => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const entityId = `discussion-${order}`;
        const readState = (tx: Parameters<typeof markAccountChanged>[0]) => markDiscussionPrivateReaderChangedInTx({
            tx, accountId: account.id, discussionId: entityId,
        });
        const resource = (tx: Parameters<typeof markAccountChanged>[0]) => markAccountsChanged(tx, {
            accountIds: [account.id], kind: 'discussion', entityId,
            hint: { v: 1, discussions: true, changes: { resource: true } },
        });
        const first = order === 'read-first' ? readState : resource;
        const second = order === 'read-first' ? resource : readState;
        await inTx(async tx => { await first(tx); });
        const readHint = async () => (await db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: 'discussion', entityId } },
            select: { hint: true },
        })).hint;
        expect(await readHint()).toEqual({ v: 1, discussions: true,
            changes: order === 'read-first' ? { readState: true } : { resource: true } });
        await inTx(async tx => { await second(tx); await readState(tx); });
        expect(await readHint()).toEqual({ v: 1, discussions: true, changes: { readState: true, resource: true } });
        expect(await db.accountChange.count({ where: { accountId: account.id, kind: 'discussion', entityId } })).toBe(1);
    });

    it(`retains earlier Discussion message changes across a later whole-resource change on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const entityId = 'discussion-with-changed-messages';
        const readChange = () => db.accountChange.findUniqueOrThrow({
            where: { accountId_kind_entityId: { accountId: account.id, kind: 'discussion', entityId } },
            select: { cursor: true, hint: true },
        });
        const publish = async (seq?: number) => {
            await inTx(tx => markAccountsChanged(tx, {
                accountIds: [account.id], kind: 'discussion', entityId,
                hint: { v: 1, discussions: true, changes: { resource: true },
                    ...(seq === undefined ? {} : { messageChanges: { latestSeq: seq, previousResourceCursor: 0, previous: [] } }) },
            }));
            return readChange();
        };
        const resource = await publish();
        const first = await publish(2);
        const second = await publish(3);
        const laterResource = await publish();
        expect(second.hint).toMatchObject({ messageChanges: { latestSeq: 3, previousResourceCursor: resource.cursor,
            previous: [{ seq: 2, cursor: first.cursor }] } });
        expect(laterResource.hint).toMatchObject({ messageChanges: { previousResourceCursor: resource.cursor,
            previous: [{ seq: 2, cursor: first.cursor }, { seq: 3, cursor: second.cursor }] } });
        expect(laterResource.cursor).toBeGreaterThan(second.cursor);
    });

    it(`keeps connected service entities cursor-relative and independent of self changes on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const first = { pluginId: 'test.connected', localId: 'first' };
        const second = { pluginId: 'test.connected', localId: 'second' };
        const firstChange = buildConnectedServicesAccountChangeV1(first);
        const secondChange = buildConnectedServicesAccountChangeV1(second);
        const broadChange = buildConnectedServicesAccountChangeV1();
        const readChanges = (after = 0) => db.accountChange.findMany({
            where: { accountId: account.id, cursor: { gt: after } }, orderBy: { cursor: 'asc' },
            select: { kind: true, entityId: true, hint: true },
        });
        await inTx(async tx => {
            // Retained predecessor self flags are replaced by ordinary self facts.
            await markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
                hint: { connectedServices: true } });
            await recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: first });
            await recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: second });
            await markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
                hint: { settingsVersion: 7 } });
        });
        expect(await readChanges()).toEqual([
            firstChange, secondChange, { kind: 'account', entityId: 'self', hint: { settingsVersion: 7 } },
        ]);
        await inTx(tx => markAccountChanged(tx, { accountId: account.id, kind: 'account', entityId: 'self',
            hint: { username: true } }));
        expect((await readChanges()).at(-1)).toEqual({ kind: 'account', entityId: 'self', hint: { username: true } });
        await inTx(tx => markAccountsChanged(tx, { accountIds: [account.id], kind: 'account', entityId: 'self' }));
        expect((await readChanges()).at(-1)?.hint).toBeNull();
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id }));
        expect(await readChanges()).toHaveLength(4);
        expect((await readChanges()).at(-1)).toEqual(broadChange);
        const checkpoint = (await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq;
        await inTx(tx => recordConnectedServiceAccountProfileChange({ tx, accountId: account.id, service: first }));
        expect(await readChanges(checkpoint)).toEqual([firstChange]);
    });

    it(`retains queued Session and Machine removal changes after domain work deletes their rows on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const pointSession = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const batchSession = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}" } });
        const pointMachine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const batchMachine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}" } });
        const emit = vi.fn();
        eventRouter.setIo({ to: () => ({ emit, disconnectSockets: vi.fn() }) });

        const changes = await inTx(async tx => {
            const pointSessionChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "session", entityId: pointSession.id, hint: { removed: true },
            });
            const [batchSessionChange] = await markSessionAccountsChanged(tx, new Map([[batchSession.id, [account.id]]]));
            const pointMachineChange = await markAccountChanged(tx, {
                accountId: account.id, kind: "machine", entityId: pointMachine.id, hint: { removed: true },
            });
            const [batchMachineChange] = await markAccountsChanged(tx, {
                accountIds: [account.id], kind: "machine", entityId: batchMachine.id, hint: { removed: true, batch: true },
            });
            await tx.session.deleteMany({ where: { id: { in: [pointSession.id, batchSession.id] } } });
            await tx.machine.deleteMany({ where: { id: { in: [pointMachine.id, batchMachine.id] } } });
            expect(emit).not.toHaveBeenCalled();
            return transactionResult(() => [
                { kind: "session", entityId: pointSession.id, cursor: pointSessionChange.resolveCursor(), hint: expect.objectContaining({ removed: true, followReceiverAvailabilityChanged: false }) },
                { kind: "session", entityId: batchSession.id, cursor: batchSessionChange.resolveCursor(), hint: expect.objectContaining({ followReceiverAvailabilityChanged: false }) },
                { kind: "machine", entityId: pointMachine.id, cursor: pointMachineChange.resolveCursor(), hint: { removed: true } },
                { kind: "machine", entityId: batchMachine.id, cursor: batchMachineChange.resolveCursor(), hint: { removed: true, batch: true } },
            ]);
        });

        expect(changes.map(change => change.cursor).sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
        await expect(db.accountChange.findMany({ where: { accountId: account.id }, orderBy: { cursor: "asc" },
            select: { kind: true, entityId: true, cursor: true, hint: true,
                sessionId: true, machineId: true, artifactId: true, accountPetPackageId: true } }))
            .resolves.toEqual(changes.map(change => ({ ...change,
                sessionId: null, machineId: null, artifactId: null, accountPetPackageId: null,
            })).sort((left, right) => left.cursor - right.cursor));
        expect(emit).toHaveBeenCalledWith("update", expect.objectContaining({ seq: 4,
            body: expect.objectContaining({ t: "account-change", changeKinds: ["session", "machine"],
                entityIds: [pointSession.id, batchSession.id, pointMachine.id, batchMachine.id] }),
        }));
    });

    it.skipIf(provider !== "postgres")("allocates cursors in terminal commit order and never exposes a late cursor below the checkpoint", async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        let recorded!: () => void;
        const firstRecorded = new Promise<void>(resolve => { recorded = resolve; });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        const first = inTx(async tx => {
            const publication = await markAccountChanged(tx, { accountId: account.id, kind: "account", entityId: "first" });
            expect(() => publication.resolveCursor()).toThrow();
            recorded();
            await mayCommit;
            return publication;
        }, { isolationLevel: "ReadCommitted" });
        const firstOutcome = Promise.allSettled([first]);
        await Promise.race([firstRecorded, firstOutcome.then(() => { throw new Error("First writer ended before recording publication"); })]);
        let checkpoint = 0;
        let setupFailure: unknown;
        try {
            expect(await db.accountChange.findMany({ where: { accountId: account.id } })).toEqual([]);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
            const second = await inTx(tx => markAccountChanged(tx, {
                accountId: account.id, kind: "account", entityId: "second",
            }), { isolationLevel: "ReadCommitted" });
            checkpoint = second.resolveCursor();
            expect(checkpoint).toBe(1);
            expect(await db.accountChange.findMany({ where: { accountId: account.id },
                select: { cursor: true, entityId: true } })).toEqual([{ cursor: checkpoint, entityId: "second" }]);
        } catch (error) {
            setupFailure = error;
        } finally { release(); }
        const outcomes = await firstOutcome;
        if (setupFailure !== undefined) throw setupFailure;
        for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
        const page = (after: number) => db.accountChange.findMany({ where: { accountId: account.id, cursor: { gt: after } },
            orderBy: { cursor: "asc" }, take: 1, select: { cursor: true, entityId: true } });
        expect(await page(0)).toEqual([{ cursor: 1, entityId: "second" }]);
        expect(await page(checkpoint)).toEqual([{ cursor: 2, entityId: "first" }]);
        expect(await page(2)).toEqual([]);
    });

    it.skipIf(provider !== "postgres").each(["batch", "hinted", "separate"] as const)("locks the complete terminal audience in order before a later physical row (%s)", async mode => {
        const hinted = mode === "hinted";
        const stem = `batch-lock-${randomUUID()}`;
        // Put b before a in the heap so an unordered UPDATE's scan disagrees
        // with the Session cursor owner's sorted Account acquisition order.
        const second = await db.account.create({ data: { id: `${stem}-b`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const first = await db.account.create({ data: { id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        let releaseHolder!: () => void;
        const holderMayContinue = new Promise<void>(resolve => { releaseHolder = resolve; });
        let holderReady!: () => void;
        const holderHasAccount = new Promise<void>(resolve => { holderReady = resolve; });
        const holder = inTx(async tx => {
            await tx.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE', first.id);
            holderReady();
            await holderMayContinue;
        }, { isolationLevel: "ReadCommitted" });
        const holderResult = Promise.allSettled([holder]);
        await holderHasAccount;
        let batchPid = -1;
        let batchFinished = false;
        const batch = inTx(async tx => {
            const [row] = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
            batchPid = row.pid;
            // Exercise a valid physical scan plan, rather than relying on the
            // planner choosing an index scan that accidentally sorts the writes.
            await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
            await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
            if (mode === "separate") {
                // Separate point calls must join the same complete sorted
                // terminal audience, even when recorded in reverse order.
                await markAccountChanged(tx, { accountId: second.id, kind: "account", entityId: stem });
                await markAccountChanged(tx, { accountId: first.id, kind: "account", entityId: stem });
                return;
            }
            return markAccountsChanged(tx, { accountIds: [second.id, first.id], entityId: stem,
                ...(hinted ? { hintForAccount: (accountId: string) => ({ recipient: accountId }) } : {}),
            });
        }, { isolationLevel: "ReadCommitted" });
        const batchResult = Promise.allSettled([batch]).finally(() => { batchFinished = true; });
        try {
            while (!batchFinished) {
                const [row] = await db.$queryRawUnsafe<{ waiting: boolean }[]>(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock') AS waiting", batchPid,
                );
                if (row.waiting) break;
            }
            await expect(inTx(tx => tx.$queryRawUnsafe<{ id: string }[]>(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', second.id,
            ), { isolationLevel: "ReadCommitted" })).resolves.toEqual([{ id: second.id }]);
        } finally {
            releaseHolder();
            vi.unstubAllEnvs();
            for (const outcome of [...await holderResult, ...await batchResult]) {
                if (outcome.status === "rejected") throw outcome.reason;
            }
        }
        expect(await db.accountChange.findMany({ where: { entityId: stem }, orderBy: { accountId: "asc" },
            select: { accountId: true, hint: true } })).toEqual([first, second].map(account => ({
            accountId: account.id, hint: hinted ? { recipient: account.id } : null,
        })));
    });

    it.skipIf(provider !== "postgres")("admits the complete Follow destination audience compatibly while excluding authority changes", async () => {
        const stem = `follow-publication-${randomUUID()}`;
        const destinationOwner = await db.account.create({ data: { id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const sourceOwner = await db.account.create({ data: { id: `${stem}-z`, publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const source = await db.session.create({ data: { accountId: sourceOwner.id, tag: `${stem}-source`, metadata: '{}' } });
        const destination = await db.session.create({ data: { accountId: destinationOwner.id, tag: `${stem}-destination`, metadata: '{}' } });
        await db.sessionFollowEdge.create({ data: { sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id, policyJson: '{"preset":"quiet"}' } });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        let ready!: () => void;
        const locked = new Promise<void>(resolve => { ready = resolve; });
        const first = inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, [source.id]);
            ready();
            await mayCommit;
        }, { isolationLevel: 'ReadCommitted' });
        const firstOutcome = Promise.allSettled([first]);
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        try {
            await Promise.race([locked, firstOutcome.then(() => { throw new Error('Publication ended before lock acquisition'); })]);
            await expect(inTx(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', destinationOwner.id,
            ), { isolationLevel: 'ReadCommitted' })).resolves.toEqual([{ id: destinationOwner.id }]);
            await expect(inTx(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', destinationOwner.id,
            ), { isolationLevel: 'ReadCommitted' })).rejects.toThrow();
        } finally {
            release();
            vi.unstubAllEnvs();
            for (const outcome of await firstOutcome) if (outcome.status === 'rejected') throw outcome.reason;
        }
    });

    it.skipIf(provider !== "postgres").each(["unpublished", "inactive"] as const)("fences a granted %s reader before publication can expand the audience", async state => {
        const stem = `audience-prospective-${randomUUID()}`;
        const owner = await db.account.create({ data: {
            id: `${stem}-z`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        const reader = await db.account.create({ data: {
            id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
            status: state === "inactive" ? "suspended" : "active",
        } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: stem, encryptionMode: "plain", metadata: "{}",
            currentStorageState: state === "unpublished" ? "external" : "hosted",
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: reader.id, accessLevel: "view",
        } });
        let locked!: () => void;
        const locksAcquired = new Promise<void>(resolve => { locked = resolve; });
        let release!: () => void;
        const mayCommit = new Promise<void>(resolve => { release = resolve; });
        // This probe deliberately observes NOWAIT refusal while the holder is
        // live; do not spend the production retry/backoff before releasing it.
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        const holder = inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, [session.id]);
            locked();
            await mayCommit;
        }, { isolationLevel: "ReadCommitted" });
        const holderOutcome = Promise.allSettled([holder]);
        try {
            await Promise.race([locksAcquired, holderOutcome.then(() => {
                throw new Error("Publication ended before Account acquisition");
            })]);
            await expect(inTx(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', reader.id,
            ), { isolationLevel: "ReadCommitted" })).rejects.toMatchObject({ code: "database_transaction_conflict_exhausted",
                cause: { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "55P03" } } } } });
        } finally {
            release();
            vi.unstubAllEnvs();
            for (const outcome of await holderOutcome) if (outcome.status === "rejected") throw outcome.reason;
        }
    });

    it.skipIf(provider !== "postgres")("keeps Account lock order when a lower-id reader is granted after audience discovery", async () => {
        const { putSessionAccessGrantInTx } = await import("@/app/session/access/sessionAccessGrantService");
        const { markSessionProjectionRecipientsChanged } = await import("@/app/session/changeTracking/markSessionProjectionRecipientsChanged");
        type Tx = Parameters<Parameters<typeof inTx>[0]>[0];
        const stem = `audience-expansion-${randomUUID()}`;
        const owner = await db.account.create({ data: {
            id: `${stem}-z`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        const reader = await db.account.create({ data: {
            id: `${stem}-a`, publicKey: `${publicKeyPrefix}${randomUUID()}`, encryptionMode: "plain",
        } });
        await db.userRelationship.createMany({ data: [
            { fromUserId: owner.id, toUserId: reader.id, status: "friend" },
            { fromUserId: reader.id, toUserId: owner.id, status: "friend" },
        ] });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: stem, encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
        } });
        const rawDriverFailures: unknown[] = [];
        let discovered!: () => void;
        const oldAudienceDiscovered = new Promise<void>(resolve => { discovered = resolve; });
        let allowInitialLock!: () => void;
        const grantMayCommitFirst = new Promise<void>(resolve => { allowInitialLock = resolve; });
        let interceptInitialLock = true;
        let attempts = 0;

        // The real DB transport alone is intercepted: every grant, audience
        // resolver, Account lock and cursor publication executes unchanged.
        const observeTransport = (tx: Tx, interleave: boolean): Tx => new Proxy(tx, {
            get(target, key) {
                if (key === "$queryRawUnsafe") return async <T>(query: string, ...values: unknown[]): Promise<T> => {
                    const pause = interleave && interceptInitialLock
                        && query.includes('FROM "Account"') && query.includes("FOR KEY SHARE");
                    if (pause) {
                        interceptInitialLock = false;
                        expect(Array.isArray(values[0]) ? values[0] : [values[0]]).toEqual([owner.id]);
                        discovered();
                        await grantMayCommitFirst;
                    }
                    try {
                        const result = await target.$queryRawUnsafe<T>(query, ...values);
                        return result;
                    } catch (error) {
                        rawDriverFailures.push(error);
                        throw error;
                    }
                };
                const member: unknown = Reflect.get(target, key, target);
                return typeof member === "function" ? member.bind(target) : member;
            },
        });
        const first = inTx(async tx => {
            attempts += 1;
            const observed = observeTransport(tx, true);
            await acquireSessionAccountCursorLocksInTx(observed, [session.id]);
            await observed.session.update({ where: { id: session.id }, data: { metadataVersion: { increment: 1 } } });
            return markSessionProjectionRecipientsChanged({ tx: observed, sessionId: session.id });
        }, { isolationLevel: "ReadCommitted" });
        const firstOutcome = Promise.allSettled([first]);
        let setupFailure: unknown;
        try {
            await Promise.race([oldAudienceDiscovered, firstOutcome.then(([outcome]) => {
                if (outcome.status === "rejected") throw outcome.reason;
                throw new Error("Publication ended before initial audience discovery");
            })]);
            await expect(inTx(tx => putSessionAccessGrantInTx(tx, {
                actorAccountId: owner.id,
                sessionId: session.id,
                subject: { kind: "account", accountId: reader.id },
                grant: { accessLevel: "view", canApprovePermissions: false },
                authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
            }), { isolationLevel: "Serializable" })).resolves.toMatchObject({ ok: true, changed: true });
            allowInitialLock();
        } catch (error) {
            setupFailure = error;
        } finally {
            allowInitialLock();
        }
        const outcomes = await firstOutcome;
        if (setupFailure !== undefined) throw setupFailure;
        // A swallowed/retried 40P01 still falsifies the Account-order contract.
        expect(rawDriverFailures).toEqual([]);
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { metadataVersion: true } }))
            .toEqual({ metadataVersion: session.metadataVersion + 1 });
        for (const outcome of outcomes) {
            if (outcome.status === "rejected") throw outcome.reason;
            expect(outcome.value.map(cursor => cursor.accountId)).toEqual([reader.id, owner.id]);
        }
    });

    it.each([1, 18])(`publishes a hint-free Machine to %s recipients with durable cursors and nullable Machine identity on ${provider}`, async recipientCount => {
        const accounts = await Promise.all(Array.from({ length: recipientCount }, () => db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, updatedAt: new Date(1_000) }, select: { id: true },
        })));
        const accountIds = accounts.map(account => account.id).sort();
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: accounts[0].id, metadata: "{}",
        } });
        // Mix inserts and updates to preserve Machine identity and each
        // provider's existing point-writer semantics for omitted hints.
        const retainedAccountIds = new Set(accountIds.filter((_, index) => index % 2 === 0));
        await inTx(async tx => {
            for (const accountId of retainedAccountIds) await markAccountChanged(tx, {
                accountId, kind: "machine", entityId: machine.id, hint: { daemonStateVersion: 7 },
            });
        });
        const original = db.$transaction;
        const statements: string[] = [];
        type Tx = Parameters<typeof markAccountChanged>[0];
        // Count consumed SQL at the real Prisma transport, including terminal
        // publication. PostgreSQL must publish the audience in one statement;
        // portable providers exercise the same durable contract through Prisma.
        if (provider === "postgres") db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(owner, property, proxyReceiver) {
                    if (property !== "$queryRawUnsafe") return Reflect.get(owner, property, proxyReceiver);
                    return (sql: string, ...values: unknown[]) => observeLazyPrismaQuery(owner.$queryRawUnsafe(sql, ...values), () => ({
                        started: () => { if (sql.includes('INSERT INTO "AccountChange"')) statements.push(sql); },
                        settled: () => {},
                    }));
                },
            })), ...args.slice(1)]);
        } });
        try {
            const publish = () => inTx(tx => markAccountsChanged(tx, {
                accountIds: [...accountIds].reverse().concat(accountIds[0]), kind: "machine", entityId: machine.id,
            }));
            const publications = await publish();
            const expected = accountIds.map(accountId => ({ accountId, cursor: retainedAccountIds.has(accountId) ? 2 : 1 }));
            expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
                .toEqual(expected);
            const readChanges = () => db.accountChange.findMany({ where: { kind: "machine", entityId: machine.id },
                orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true, machineId: true, hint: true } });
            const expectedHint = (accountId: string) => provider === "postgres" || !retainedAccountIds.has(accountId)
                ? null : { daemonStateVersion: 7 };
            expect(await readChanges()).toEqual(expected.map(row => ({ ...row, machineId: machine.id, hint: expectedHint(row.accountId) })));
            const accountRows = await db.account.findMany({ where: { id: { in: accountIds } }, orderBy: { id: "asc" },
                select: { id: true, seq: true, updatedAt: true } });
            expect(accountRows.map(({ updatedAt: _updatedAt, ...row }) => row))
                .toEqual(expected.map(row => ({ id: row.accountId, seq: row.cursor })));
            if (provider === "postgres") {
                expect(accountRows.every(row => row.updatedAt.getTime() === 1_000)).toBe(true);
                console.info("MACHINE_PUBLICATION_SQL", JSON.stringify({ recipients: recipientCount, statements: statements.length }));
                expect(statements).toHaveLength(1);
            } else expect(accountRows.every(row => row.updatedAt.getTime() > 1_000)).toBe(true);

            await db.machine.delete({ where: { id: machine.id } });
            statements.length = 0;
            const removals = await publish();
            expect(removals.map(publication => publication.resolveCursor())).toEqual(expected.map(row => row.cursor + 1));
            expect(await readChanges()).toEqual(expected.map(row => ({ ...row, cursor: row.cursor + 1,
                machineId: null, hint: expectedHint(row.accountId),
            })));
            if (provider === "postgres") expect(statements).toHaveLength(1);
        } finally {
            db.$transaction = original;
            await db.machine.deleteMany({ where: { id: machine.id } });
        }
    });

    it(`batches hint-free Session changes with the same hints and Session identity as the point writer on ${provider}`, async () => {
        const accounts = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, updatedAt: new Date(1_000) }, select: { id: true },
        })));
        const session = await db.session.create({ data: {
            accountId: accounts[0].id, tag: randomUUID(), metadata: "{}",
        }, select: { id: true } });
        await inTx(async tx => {
            for (const account of accounts) await markAccountChanged(tx, {
                accountId: account.id, kind: "session", entityId: session.id, hint: { sharedMetadataVersion: 7 },
            });
        });
        const publications = await inTx(tx => markAccountsChanged(tx, {
            accountIds: accounts.map(account => account.id), entityId: session.id, kind: "session",
        }));
        const cursors = publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() }));
        expect(cursors.map(cursor => cursor.accountId)).toEqual(accounts.map(account => account.id).sort());
        const changes = await db.accountChange.findMany({ where: { entityId: session.id, kind: "session" },
            orderBy: { accountId: "asc" }, select: { accountId: true, cursor: true, sessionId: true, hint: true } });
        expect(changes).toEqual(cursors.map(cursor => ({ ...cursor, sessionId: session.id,
            hint: { ...(provider === "postgres" ? {} : { sharedMetadataVersion: 7 }), followReceiverAvailabilityChanged: false,
                workflowOriginUnchangedSinceCursor: 0 },
        })));
        const accountTimestamps = await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            select: { updatedAt: true } });
        if (provider === "postgres") expect(accountTimestamps.every(row => row.updatedAt.getTime() === 1_000)).toBe(true);
        else expect(accountTimestamps.every(row => row.updatedAt.getTime() > 1_000)).toBe(true);
        await db.session.delete({ where: { id: session.id } });
        expect(await db.accountChange.findMany({ where: { entityId: session.id }, orderBy: { accountId: "asc" },
            select: { accountId: true, cursor: true, sessionId: true, hint: true } })).toEqual(cursors.map(cursor => ({
            ...cursor, sessionId: null,
            hint: { ...(provider === "postgres" ? {} : { sharedMetadataVersion: 7 }), followReceiverAvailabilityChanged: false,
                workflowOriginUnchangedSinceCursor: 0 },
        })));
    });

    it(`replaces hint-free Account projections and rolls back incomplete audiences on ${provider}`, async () => {
        const accounts = await Promise.all(Array.from({ length: 2 }, () => db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}`, updatedAt: new Date(1_000) }, select: { id: true },
        })));
        const entityId = `projection-${randomUUID()}`;
        await inTx(async tx => {
            for (const account of accounts) await markAccountChanged(tx, {
                accountId: account.id, entityId, kind: "account", hint: { full: true },
            });
        });
        const publications = await inTx(tx => markAccountsChanged(tx, { accountIds: accounts.map(account => account.id), entityId }));
        const cursors = publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() }));
        expect(await db.accountChange.findMany({ where: { entityId }, orderBy: { accountId: "asc" },
            select: { accountId: true, cursor: true, hint: true, sessionId: true } }))
            .toEqual(cursors.map(cursor => ({ ...cursor, hint: null, sessionId: null })));
        expect((await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            select: { updatedAt: true } })).every(row => row.updatedAt.getTime() > 1_000)).toBe(true);
        await expect(inTx(tx => markAccountsChanged(tx, {
            accountIds: [accounts[0].id, "missing-recipient"], entityId,
        }))).rejects.toThrow("every Account recipient must exist");
        expect(await db.account.findMany({ where: { id: { in: accounts.map(account => account.id) } },
            orderBy: { id: "asc" }, select: { id: true, seq: true } }))
            .toEqual(cursors.map(cursor => ({ id: cursor.accountId, seq: cursor.cursor })));
    });

    it(`stamps precise Collection successors with the actual previous cursor on ${provider}`, async () => {
        const account = await db.account.create({ data: { publicKey: `${publicKeyPrefix}${randomUUID()}` } });
        const identity = { pluginDomain: 'dataCollection' as const, pluginId: 'example.contract', collectionId: 'precise',
            contractDigest: 'a'.repeat(43), revision: 1 };
        const entityId = `pluginDomain/${identity.pluginId}/data-collection/${identity.collectionId}`;
        const publish = (hint: unknown) => inTx(tx => markAccountChanged(tx, {
            accountId: account.id, kind: 'pluginDomain', entityId, hint,
        }));
        const full = await publish({ ...identity, full: true });
        const precise = { ...identity, revision: 2, rowIds: ['row-1'],
            indexChanges: { previousCursor: 0, keys: [{ indexId: 'by-kind', key: '0100ff' }] } };
        const first = await publish(precise);
        const read = () => db.accountChange.findUniqueOrThrow({ where: {
            accountId_kind_entityId: { accountId: account.id, kind: 'pluginDomain', entityId },
        }, select: { hint: true } });
        expect(await read()).toEqual({ hint: { ...precise,
            indexChanges: { ...precise.indexChanges, previousCursor: full.resolveCursor() } } });
        await publish({ ...precise, revision: 3 });
        expect(await read()).toEqual({ hint: { ...precise, revision: 3,
            indexChanges: { ...precise.indexChanges, previousCursor: first.resolveCursor() } } });
    });

    it(`keeps a retained Collection full hint broad across a later exact hint on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` },
            select: { id: true },
        });
        const pluginId = "example.contract";
        const collectionId = "tasks";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const fullPublication = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: "a".repeat(43),
                    revision: 4,
                    full: true,
                },
            })
        ));
        const exactPublication = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId,
                    contractDigest: "b".repeat(43),
                    revision: 5,
                    rowIds: ["task-1"],
                },
            })
        ));

        const fullCursor = fullPublication.resolveCursor();
        const exactCursor = exactPublication.resolveCursor();
        expect(exactCursor).toBeGreaterThan(fullCursor);
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: account.id,
                    kind: "pluginDomain",
                    entityId,
                },
            },
            select: { cursor: true, hint: true },
        })).resolves.toEqual({
            cursor: exactCursor,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId,
                contractDigest: "b".repeat(43),
                revision: 5,
                full: true,
            },
        });
    });

    it(`coalesces queued Collection hints without narrowing a full reread on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` }, select: { id: true },
        });
        const pluginId = "example.contract";
        const collectionId = "queued";
        const entityId = `pluginDomain/${pluginId}/data-collection/${collectionId}`;
        const [full, exact] = await inTx(async tx => {
            const full = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "a".repeat(43), revision: 4, full: true },
            });
            const exact = await markAccountChanged(tx, {
                accountId: account.id, kind: "pluginDomain", entityId,
                hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                    contractDigest: "b".repeat(43), revision: 5, rowIds: ["task-1"] },
            });
            return [full, exact] as const;
        });

        expect(exact.resolveCursor()).toBeGreaterThanOrEqual(full.resolveCursor());
        await expect(db.accountChange.findMany({ where: { accountId: account.id },
            select: { entityId: true, cursor: true, hint: true } })).resolves.toEqual([{
            entityId, cursor: exact.resolveCursor(),
            hint: { pluginDomain: "dataCollection", pluginId, collectionId,
                contractDigest: "b".repeat(43), revision: 5, full: true },
        }]);
    });

    it(`preserves exact-only and separate Collection identities on ${provider}`, async () => {
        const account = await db.account.create({
            data: { publicKey: `${publicKeyPrefix}${randomUUID()}` },
            select: { id: true },
        });
        const pluginId = "example.contract";
        const exactCollectionId = "exact-only";
        const fullCollectionId = "separate-full";
        const exactEntityId = `pluginDomain/${pluginId}/data-collection/${exactCollectionId}`;
        const fullEntityId = `pluginDomain/${pluginId}/data-collection/${fullCollectionId}`;

        await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: exactEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: exactCollectionId,
                    contractDigest: "c".repeat(43),
                    revision: 1,
                    rowIds: ["first"],
                },
            })
        ));
        const fullPublication = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: fullEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: fullCollectionId,
                    contractDigest: "d".repeat(43),
                    revision: 3,
                    full: true,
                },
            })
        ));
        const exactPublication = await inTx(async (tx) => (
            await markAccountChanged(tx, {
                accountId: account.id,
                kind: "pluginDomain",
                entityId: exactEntityId,
                hint: {
                    pluginDomain: "dataCollection",
                    pluginId,
                    collectionId: exactCollectionId,
                    contractDigest: "c".repeat(43),
                    revision: 2,
                    rowIds: ["second"],
                },
            })
        ));

        const fullCursor = fullPublication.resolveCursor();
        const exactCursor = exactPublication.resolveCursor();
        await expect(db.accountChange.findMany({
            where: { accountId: account.id, kind: "pluginDomain" },
            orderBy: { entityId: "asc" },
            select: { cursor: true, entityId: true, hint: true },
        })).resolves.toEqual([{
            cursor: exactCursor,
            entityId: exactEntityId,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId: exactCollectionId,
                contractDigest: "c".repeat(43),
                revision: 2,
                rowIds: ["second"],
            },
        }, {
            cursor: fullCursor,
            entityId: fullEntityId,
            hint: {
                pluginDomain: "dataCollection",
                pluginId,
                collectionId: fullCollectionId,
                contractDigest: "d".repeat(43),
                revision: 3,
                full: true,
            },
        }]);
    });
});
