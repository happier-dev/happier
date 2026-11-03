import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import * as access from './machineAccess';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { observePrismaReads } from '@/testkit/observePrismaReads';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider === 'mysql')('Machine recipient work (real provider)', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        if (provider === 'sqlite') harness = await createLightSqliteHarness({ tempDirPrefix: 'machine-recipient-work-', initAuth: false });
        else {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
            }
            initDbPostgres();
            await db.$connect();
        }
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); else await db.$disconnect(); });
    async function account() {
        const keys = tweetnacl.box.keyPair();
        return { ...await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } }), keys };
    }
    async function fixture() {
        const owner = await account();
        const key = tweetnacl.randomBytes(32);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: 'encrypted-metadata', daemonState: 'encrypted-state',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: owner.keys.publicKey, randomBytes: tweetnacl.randomBytes }) } });
        return { owner, machine, key };
    }
    const grant = async (actorAccountId: string, machineId: string, accountId: string) => {
        await makeShareEligibleForTest(actorAccountId, accountId);
        return inTx(tx => access.setMachineAccessGrantInTx(tx, {
            actorAccountId, machineId, principal: { kind: 'account', accountId }, level: 'view' }));
    };

    it('acquires structural audience through the shared membership read without opening content or keys', async () => {
        const f = await fixture();
        const recipient = await account();
        const suspended = await account();
        await db.machineAccountGrant.createMany({ data: [recipient, suspended, f.owner].map(account => ({
            machineId: f.machine.id, accountId: account.id, accessLevel: 'view', createdByAccountId: f.owner.id,
        })) });
        await db.account.update({ where: { id: suspended.id }, data: { status: 'suspended' } });
        await inTx(async tx => {
            const observed = observePrismaReads(tx, ['machine', 'account', 'machineKeyEnvelope']);
            const statements: unknown[] = [];
            const traced = new Proxy(observed.tx, { get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(target) : value;
                return (...args: unknown[]) => {
                    statements.push(args[0]);
                    return Reflect.apply(value, target, args);
                };
            } });
            expect(await access.resolveCurrentMachineRecipientAccountIdsInTx(traced, f.machine.id))
                .toEqual([f.owner.id, recipient.id].sort());
            expect(observed.reads).toEqual([]);
            expect(statements).toHaveLength(1);
            expect(statements[0]).not.toMatch(/MachineKeyEnvelope|contentPublicKey|encryptedDataKey|dataEncryptionKey|metadata|daemonState/u);
        });
    });

    it('projects recipient work for a fleet in one set query and clears only a conditionally delivered key', async () => {
        const f = await fixture();
        const ids = Array.from({ length: 128 }, () => crypto.randomUUID());
        await db.machine.createMany({ data: ids.map(id => ({ id, accountId: f.owner.id,
            metadata: f.machine.metadata, daemonState: f.machine.daemonState, dataEncryptionKey: f.machine.dataEncryptionKey,
            installationId: 'recipient-fleet' })) });
        const read = (expectedQueries = 1, includeRecipientWork = true) => inTx(async tx => {
            let recipientQueries = 0;
            const observed = new Proxy(tx, { get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(target) : value;
                return async (...args: unknown[]) => {
                    if (typeof args[0] === 'string' && args[0].includes('MachineKeyEnvelope')) recipientQueries++;
                    return Reflect.apply(value, target, args);
                };
            } });
            const rows = await access.readAccessibleMachineOpeningsInTx(observed, { actorAccountId: f.owner.id, machineIds: ids,
                ...(includeRecipientWork ? { includeRecipientWork: true as const } : {}) });
            expect(recipientQueries).toBe(expectedQueries);
            return rows;
        });
        const ordinaryRows = await read(0, false);
        expect(ordinaryRows.size).toBe(ids.length);
        for (const row of ordinaryRows.values()) expect(row).not.toHaveProperty('recipientWorkPending');
        expect([...await read()].map(([, row]) => row)).toEqual(ids.map(() => expect.objectContaining({ recipientWorkPending: false, recipientWorkCursor: 0 })));
        const recipient = await account();
        const pendingIds = [ids[3]!, ids[17]!, ids[73]!];
        for (const machineId of pendingIds) await grant(f.owner.id, machineId, recipient.id);
        const pending = await read();
        expect(ids.filter(id => pending.get(id)?.recipientWorkPending)).toEqual(pendingIds);
        const machineId = pendingIds[1]!;
        const census = await inTx(tx => access.readMachineRecipientCensusInTx(tx, { actorAccountId: f.owner.id, machineId }));
        if ('kind' in census) throw new Error(census.code);
        expect(census.recipients.map(row => row.recipientAccountId)).toEqual([recipient.id]);
        const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({ dataKey: f.key,
            recipientPublicKey: recipient.keys.publicKey, randomBytes: tweetnacl.randomBytes });
        expect(await inTx(tx => access.commitMachineRecipientKeyEnvelopesInTx(tx, { actorAccountId: f.owner.id, machineId,
            expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!,
            expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!, expectedMetadataVersion: census.content.metadataVersion,
            expectedDaemonStateVersion: census.content.daemonStateVersion,
            recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(encryptedDataKey),
                recipientContentPublicKeyFingerprint: census.recipients[0]!.contentPublicKeyFingerprint! }] })))
            .toEqual({ appliedRecipientAccountIds: [recipient.id], skippedRecipientAccountIds: [] });
        const delivered = await inTx(tx => access.readMachineDataKeyForCallerInTx(tx, { actorAccountId: recipient.id, machineId }));
        expect(delivered).not.toBeNull();
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: delivered!, recipientSecretKeyOrSeed: recipient.keys.secretKey })).toEqual(f.key);
        expect(ids.filter(id => (pending.get(id)?.recipientWorkPending))).toEqual(pendingIds);
        const settled = await read();
        expect(ids.filter(id => settled.get(id)?.recipientWorkPending)).toEqual([pendingIds[0], pendingIds[2]]);
        expect(settled.get(machineId)?.recipientWorkCursor).toBeGreaterThan(0);
        const teamRecipient = await account();
        const groupRecipient = await account();
        const team = await db.team.create({ data: { name: 'Recipient fact Team' } });
        const teamMember = await db.teamMembership.create({ data: { teamId: team.id, accountId: teamRecipient.id, role: 'member' } });
        const groupMember = await db.teamMembership.create({ data: { teamId: team.id, accountId: groupRecipient.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Recipient fact Group', nameKey: 'recipient-fact' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: groupMember.id, nativeContribution: true } });
        await db.machineGroupGrant.create({ data: { machineId, teamGroupId: group.id, accessLevel: 'view', createdByAccountId: f.owner.id } });
        await db.machineTeamGrant.create({ data: { machineId, teamId: team.id, accessLevel: 'view', createdByAccountId: f.owner.id } });
        const workForChangedMachine = async () => {
            const work = (await read()).get(machineId)!;
            const page = await inTx(async tx => {
                const observed = observePrismaReads(tx, ['account', 'machineKeyEnvelope']);
                const page = await access.readMachineRecipientCensusInTx(observed.tx, { actorAccountId: f.owner.id, machineId });
                // The same relational audience/envelope acquisition serves summary and page;
                // a page must not reacquire recipients through per-model follow-up reads.
                expect(observed.reads).toEqual([]);
                return page;
            });
            if ('kind' in page) throw new Error(page.code);
            expect(work.recipientWorkPending).toBe(page.recipients.length > 0);
            // Structural notifications retain custody and delivered recipients;
            // only undelivered recipients appear in action_required key work.
            expect(await inTx(tx => access.resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId)))
                .toEqual([f.owner.id, recipient.id, ...page.recipients.map(row => row.recipientAccountId)].sort());
            return page.recipients.map(row => row.recipientAccountId).sort();
        };
        // The Group overlap is one recipient; each lifecycle transition must
        // agree with the exact route's canonical effective audience.
        expect(await workForChangedMachine()).toEqual([teamRecipient.id, groupRecipient.id].sort());
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await workForChangedMachine()).toEqual([]);
        await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        await db.teamMembership.update({ where: { id: teamMember.id }, data: { status: 'suspended' } });
        expect(await workForChangedMachine()).toEqual([groupRecipient.id]);
        await db.machineTeamGrant.delete({ where: { machineId_teamId: { machineId, teamId: team.id } } });
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        expect(await workForChangedMachine()).toEqual([]);
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: null } });
        expect(await workForChangedMachine()).toEqual([groupRecipient.id]);
        // 1,000 selected IDs cross the canonical portable 999-bind boundary
        // once the Account/change-kind bindings are included. No row is lost.
        const overflowIds = Array.from({ length: 1_000 - ids.length }, () => crypto.randomUUID());
        await db.machine.createMany({ data: overflowIds.map(id => ({ id, accountId: f.owner.id,
            metadata: f.machine.metadata, daemonState: f.machine.daemonState, dataEncryptionKey: f.machine.dataEncryptionKey,
            installationId: 'recipient-fleet' })) });
        ids.push(...overflowIds);
        expect((await read(2)).size).toBe(1_000);
    });
});
