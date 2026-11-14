import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { artifactGrantStorageAdapter } from '@/app/artifacts/artifactGrantStorageAdapter';
import { resourceGrantArmWheres, resourceGrantAccessSqlPredicate, resolveResourceGrantAccessFromFacts } from './resourceGrantAccess';

describe('grant policy facts / Prisma / SQL equivalence', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'grant-policy-matrix-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('distinguishes owner, Team guest, explicit person/Group guest, member and suspended principal', async () => {
        const account = () => db.account.create({ data: { encryptionMode: 'plain' } });
        const [owner, teamGuest, groupGuest, directGuest, member, suspended] = await Promise.all(Array.from({ length: 6 }, account));
        const team = await db.team.create({ data: { name: 'Grant matrix' } });
        await db.teamMembership.createMany({ data: [...[teamGuest, groupGuest, directGuest, suspended].map(actor => ({
            teamId: team.id, accountId: actor.id, role: 'guest' as const,
        })), { teamId: team.id, accountId: member.id, role: 'member' } ] });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Explicit group' } });
        for (const actor of [groupGuest, suspended]) {
            const membership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: actor.id } } });
            await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        }
        await db.account.update({ where: { id: suspended.id }, data: { status: 'suspended' } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'group', artifactId: artifact.id, teamGroupId: group.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGrant.createMany({ data: [directGuest, suspended].map(actor => ({ principalKind: 'account' as const,
            artifactId: artifact.id, accountId: actor.id, accessLevel: 'view' as const, createdByAccountId: owner.id,
        })) });
        await inReadSnapshot(async tx => {
            const facts = await artifactGrantStorageAdapter.readAccessFactsInTx(tx, artifact.id);
            expect(facts).not.toBeNull();
            for (const [actor, allowed] of [[owner, true], [teamGuest, false], [groupGuest, true], [directGuest, true], [member, true], [suspended, false]] as const) {
                const arms = resourceGrantArmWheres(actor.id);
                const prismaRows = await tx.artifact.findMany({ where: { id: artifact.id, OR: [
                    { accountId: actor.id }, { grants: { some: arms.account } },
                    { grants: { some: arms.team } }, { grants: { some: arms.group } },
                ] }, select: { id: true } });
                const predicate = resourceGrantAccessSqlPredicate({ actorAccountId: actor.id, resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' });
                const sqlRows = await tx.$queryRaw<{ id: string }[]>(prismaRuntime.sql`SELECT a.id FROM "Artifact" a WHERE a.id = ${artifact.id} AND ${predicate}`);
                expect({ facts: facts !== null && resolveResourceGrantAccessFromFacts(facts, actor.id) !== null,
                    prisma: prismaRows.length === 1, sql: sqlRows.length === 1 }).toEqual({ facts: allowed, prisma: allowed, sql: allowed });
            }
        });
    });
});
