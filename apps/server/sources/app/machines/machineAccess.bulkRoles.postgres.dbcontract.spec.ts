import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { parseMachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
    listMachineAccessGrantsInTx,
    readAccessibleMachineOpeningsInTx,
    resolveCurrentMachineRecipientAccountIdsInTx,
    resolveEffectiveMachineAccessForMachinesInTx,
    resolveEffectiveMachineRoleInTx,
    resolveMachineAccessInTx,
    resolveMachineAdmissionInTx,
} from './machineAccess';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine bulk permission SQL (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await db.$disconnect(); });

    it('projects only the admitted actor memberships as granted Team and Group populations grow', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent(parseMachinePublishedMetadataV1({ host: 'actor-projection', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' })),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        const team = await db.team.create({ data: { name: 'Actor projection team' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Actor projection group', nameKey: randomUUID() } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: actor.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machineTeamGrant.create({ data: { machineId: machine.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machineGroupGrant.create({ data: { machineId: machine.id, teamGroupId: group.id, accessLevel: 'admin', createdByAccountId: owner.id } });

        const others: string[] = [];
        const growAudience = async (count: number) => {
            const added = Array.from({ length: count }, () => ({ accountId: randomUUID(), membershipId: randomUUID() }));
            await db.account.createMany({ data: added.map(person => ({ id: person.accountId, encryptionMode: 'plain' })) });
            await db.teamMembership.createMany({ data: added.map(person => ({ id: person.membershipId, teamId: team.id, accountId: person.accountId, role: 'member' })) });
            await db.teamGroupMembership.createMany({ data: added.map(person => ({ teamId: team.id, teamGroupId: group.id, teamMembershipId: person.membershipId, nativeContribution: true })) });
            await db.machineAccountGrant.createMany({ data: added.map(person => ({ machineId: machine.id, accountId: person.accountId, accessLevel: 'view', createdByAccountId: owner.id })) });
            others.push(...added.map(person => person.accountId));
        };
        await growAudience(2);

        const projected: { directGrants: number; teamMemberships: number; groupMemberships: number }[] = [];
        const record = (value: unknown): Record<string, unknown> | null =>
            typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
        const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
        // Pass through the real Prisma/PostgreSQL boundary and count hydrated
        // relation rows before policy can filter them; never replace Tx logic.
        const traced = client.$extends({ query: { machine: { async $allOperations({ args, query }) {
            const result = await query(args);
            for (const value of Array.isArray(result) ? result : [result]) {
                const row = record(value);
                if (!row || !('accountGrants' in row)) continue;
                projected.push({
                    directGrants: array(row.accountGrants).length,
                    teamMemberships: array(row.teamGrants).reduce<number>((sum, grant) =>
                        sum + array(record(record(grant)?.team)?.memberships).length, 0),
                    groupMemberships: array(row.groupGrants).reduce<number>((sum, grant) =>
                        sum + array(record(record(grant)?.teamGroup)?.memberships).length, 0),
                });
            }
            return result;
        } } } });
        const originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            const measure = async (actorAccountId: string) => {
                const input = { actorAccountId, machineId: machine.id };
                const reads = [
                    { name: 'admission', read: async () => {
                        const admission = await inTx(tx => resolveMachineAdmissionInTx(tx, input));
                        expect(admission, admission.kind === 'denied' ? admission.code : undefined)
                            .toMatchObject({ kind: 'admitted', role: 'manage' });
                    } },
                    { name: 'opening', read: async () => {
                        expect((await inTx(tx => readAccessibleMachineOpeningsInTx(tx, { actorAccountId, machineIds: [machine.id] }))).get(machine.id))
                            .toMatchObject({ access: { role: 'manage', accessState: 'ready' } });
                    } },
                    { name: 'role', read: async () => {
                        expect(await inTx(tx => resolveEffectiveMachineRoleInTx(tx, input))).toBe('manage');
                    } },
                    { name: 'access', read: async () => {
                        expect(await inTx(tx => resolveMachineAccessInTx(tx, input))).toMatchObject({ role: 'manage', accessState: 'ready' });
                    } },
                    { name: 'bulk-singleton', read: async () => {
                        expect((await inTx(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [machine.id], accountIds: [actorAccountId] })))
                            .get(machine.id)?.get(actorAccountId)).toBe('manage');
                    } },
                ];
                const costs = [];
                for (const read of reads) {
                    projected.length = 0;
                    statements.length = 0;
                    await read.read();
                    const rows = projected.reduce((sum, row) => ({ directGrants: sum.directGrants + row.directGrants,
                        teamMemberships: sum.teamMemberships + row.teamMemberships, groupMemberships: sum.groupMemberships + row.groupMemberships }),
                    { directGrants: 0, teamMemberships: 0, groupMemberships: 0 });
                    costs.push({ reader: read.name, rows, bindings: statements.filter(event => /^SELECT\b/i.test(event.query))
                        .map(event => (JSON.parse(event.params) as unknown[]).length) });
                    expect.soft(rows, read.name).toEqual({ directGrants: 1, teamMemberships: 1, groupMemberships: 1 });
                }
                return costs;
            };
            const small = await measure(actor.id);
            await growAudience(32);
            const large = await measure(actor.id);
            console.info('MACHINE_ACTOR_PROJECTION_SQL', JSON.stringify({ otherRecipients: others.length, small, large }));
            expect.soft(large.map(cost => cost.rows)).toEqual(small.map(cost => cost.rows));

            // These are genuine full-audience consumers, not actor admission.
            expect(await inTx(tx => resolveCurrentMachineRecipientAccountIdsInTx(tx, machine.id)))
                .toEqual([owner.id, actor.id, ...others].sort());
            const grants = await inTx(tx => listMachineAccessGrantsInTx(tx, { actorAccountId: owner.id, machineId: machine.id }));
            if ('kind' in grants) throw new Error(grants.code);
            expect(grants.grants.find(grant => grant.principal.kind === 'group')?.audience.map(person => person.accountId).sort())
                .toEqual([actor.id, ...others].sort());

            projected.length = 0;
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: owner.id, machineId: machine.id })))
                .toMatchObject({ kind: 'admitted', role: 'manage' });
            expect(projected).toEqual([]);
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: outsider.id, machineId: machine.id })))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: actor.id, machineId: machine.id })))
                .toMatchObject({ kind: 'admitted', role: 'use' });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: actor.id, machineId: machine.id })))
                .toMatchObject({ kind: 'admitted', role: 'use' });
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: actor.id, machineId: machine.id })))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'active' } });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: actor.id, machineId: machine.id })))
                .toMatchObject({ kind: 'admitted', role: 'use' });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: actor.id, machineId: machine.id })))
                .toEqual({ kind: 'denied', code: 'access_denied' });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
            await db.account.update({ where: { id: actor.id }, data: { status: 'suspended' } });
            expect(await inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: actor.id, machineId: machine.id })))
                .toEqual({ kind: 'denied', code: 'access_denied' });
        } finally { db.$transaction = originalTransaction; }
    });

    it('set-reads only permission facts and preserves singular roles across current and withdrawn grants', async () => {
        const people = await Promise.all(Array.from({ length: 9 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
        const [owner, otherOwner, direct, administrator, member, groupMember, removed, inactive, outsider] = people;
        await db.account.update({ where: { id: inactive!.id }, data: { status: 'suspended' } });
        const team = await db.team.create({ data: { name: 'Machine permission team' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Machine permission group', nameKey: 'machine-permission-group' } });
        const memberships = await Promise.all([member!, groupMember!, removed!].map(person => db.teamMembership.create({
            data: { teamId: team.id, accountId: person.id, role: 'member' },
        })));
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: memberships[1]!.id, nativeContribution: true } });
        await db.teamMembership.update({ where: { id: memberships[2]!.id }, data: { status: 'suspended' } });
        const machines = await Promise.all([owner!, otherOwner!, owner!].map((person, index) => db.machine.create({ data: {
            id: randomUUID(), accountId: person.id, metadata: 'unneeded-owner-metadata'.repeat(1000),
            daemonState: 'unneeded-daemon-state'.repeat(1000), revokedAt: index === 2 ? new Date() : null,
        } })));
        await db.machineAccountGrant.createMany({ data: machines.flatMap(machine => [
            { machineId: machine.id, accountId: direct!.id, accessLevel: 'view' as const, createdByAccountId: owner!.id },
            { machineId: machine.id, accountId: administrator!.id, accessLevel: 'admin' as const, createdByAccountId: owner!.id },
            { machineId: machine.id, accountId: inactive!.id, accessLevel: 'admin' as const, createdByAccountId: owner!.id },
        ]) });
        await db.machineTeamGrant.createMany({ data: machines.map(machine => ({
            machineId: machine.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner!.id,
        })) });
        await db.machineGroupGrant.createMany({ data: machines.map(machine => ({
            machineId: machine.id, teamGroupId: group.id, accessLevel: 'admin', createdByAccountId: owner!.id,
        })) });
        const missing = randomUUID();
        const machineIds = [...machines.map(machine => machine.id), machines[0]!.id, missing];
        const accountIds = people.map(person => person.id);
        const originalTransaction = db.$transaction;
        // Observe engine-emitted SQL at the real database transport; retain inTx
        // budgets and every internal authorization/membership calculation.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        try {
            const measure = async (ids: readonly string[]) => {
                statements.length = 0;
                const roles = await inTx(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: ids, accountIds }));
                const selects = statements.filter(event => /^SELECT\b/i.test(event.query));
                const machineReads = selects.filter(event => /FROM "(?:public"\.")?Machine"(?:\s|$)/.test(event.query));
                return { roles, selects, machineReads };
            };
            const one = await measure([machines[0]!.id]);
            const many = await measure(machineIds);
            expect([...many.roles.keys()]).toEqual([...new Set(machineIds)]);
            for (const machineId of new Set(machineIds)) for (const actorAccountId of accountIds) {
                const singular = await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { machineId, actorAccountId }));
                expect(many.roles.get(machineId)?.get(actorAccountId)).toBe(singular);
            }
            const roles = many.roles.get(machines[0]!.id)!;
            expect(roles.get(owner!.id)).toBe('manage');
            expect(roles.get(direct!.id)).toBe('use');
            expect(roles.get(administrator!.id)).toBe('manage');
            expect(roles.get(member!.id)).toBe('use');
            expect(roles.get(groupMember!.id)).toBe('manage');
            for (const person of [otherOwner!, removed!, inactive!, outsider!]) expect(roles.get(person.id)).toBeNull();
            expect([...many.roles.get(missing)!.values()].every(role => role === null)).toBe(true);
            // Revocation is a separate admission fact, not a new role rule.
            expect(many.roles.get(machines[2]!.id)?.get(owner!.id)).toBe('manage');
            const contentColumns = ['metadata', 'metadataVersion', 'daemonState', 'daemonStateVersion', 'dataEncryptionKey'];
            const selectedContentColumns = contentColumns.filter(column => many.selects.some(event => event.query.includes(`"${column}"`)));
            console.info('MACHINE_BULK_ROLE_SQL', JSON.stringify({ distinctMachines: new Set(machineIds).size,
                one: { selects: one.selects.length, machineReads: one.machineReads.length },
                many: { selects: many.selects.length, machineReads: many.machineReads.length }, selectedContentColumns }));
            expect.soft(many.machineReads).toHaveLength(1);
            expect.soft(many.selects.length).toBe(one.selects.length);
            expect.soft(selectedContentColumns).toEqual([]);

            await db.machineAccountGrant.deleteMany({ where: { machineId: { in: machines.map(machine => machine.id) }, accountId: direct!.id } });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            await db.teamMembership.update({ where: { id: memberships[0]!.id }, data: { status: 'suspended' } });
            const withdrawn = await measure(machineIds);
            for (const machineId of machines.map(machine => machine.id)) {
                expect(withdrawn.roles.get(machineId)?.get(direct!.id)).toBeNull();
                expect(withdrawn.roles.get(machineId)?.get(member!.id)).toBeNull();
                // Group admin was withdrawn; its still-active Team membership remains Use.
                expect(withdrawn.roles.get(machineId)?.get(groupMember!.id)).toBe('use');
            }
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            await db.account.update({ where: { id: owner!.id }, data: { status: 'suspended' } });
            await db.machine.update({ where: { id: machines[1]!.id }, data: { kind: 'ephemeral_session_runner' } });
            const restricted = await measure(machineIds);
            for (const machineId of new Set(machineIds)) for (const actorAccountId of accountIds) {
                expect(restricted.roles.get(machineId)?.get(actorAccountId)).toBe(
                    await inTx(tx => resolveEffectiveMachineRoleInTx(tx, { machineId, actorAccountId })),
                );
            }
            expect(restricted.roles.get(machines[0]!.id)?.get(owner!.id)).toBeNull();
            expect(restricted.roles.get(machines[0]!.id)?.get(groupMember!.id)).toBeNull();
            expect(restricted.roles.get(machines[0]!.id)?.get(administrator!.id)).toBe('manage');
            expect(restricted.roles.get(machines[1]!.id)?.get(administrator!.id)).toBeNull();
            expect(restricted.roles.get(machines[1]!.id)?.get(otherOwner!.id)).toBe('manage');
            statements.length = 0;
            expect(await inTx(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, { machineIds: [], accountIds }))).toEqual(new Map());
            expect(statements.filter(event => /^SELECT\b/i.test(event.query))).toEqual([]);
        } finally { db.$transaction = originalTransaction; }
    });
});
