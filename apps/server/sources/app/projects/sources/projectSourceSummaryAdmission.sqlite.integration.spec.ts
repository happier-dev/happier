import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { resolveTeamActorContextInTx } from '@/app/teams/actorContext';
import { countScopedTeamProjectSourcesInTx } from './projectSourceQuery';

describe('Source summary structural admission reuse', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'source-summary-admission-', initEncrypt: true }); });
    afterAll(async () => { if (harness) await harness.close(); });

    it('retains native Team and own-Group counts and credential refusal with an already admitted actor', async () => {
        const [viewer, author] = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain' } })));
        const team = await db.team.create({ data: { name: 'Selected Team' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        const [ownGroup, otherGroup] = await Promise.all(['Own', 'Other'].map(name => db.teamGroup.create({ data: { teamId: team.id, name } })));
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: ownGroup.id,
            teamMembershipId: membership.id, nativeContribution: true } });
        const source = (owner: Prisma.InputJsonObject, audience: Prisma.InputJsonObject[]) => db.projectSource.create({ data: {
            name: crypto.randomUUID(), createdByAccountId: author.id, owner, audience, attachments: [],
        } });
        const personalOwner = { kind: 'account', accountId: author.id };
        const grant = (principal: Prisma.InputJsonObject) => ({ principal, level: 'view' });
        const teamGrant = grant({ kind: 'team', teamId: team.id });
        const ownGroupGrant = grant({ kind: 'group', teamId: team.id, groupId: ownGroup.id });
        const otherGroupGrant = grant({ kind: 'group', teamId: team.id, groupId: otherGroup.id });
        await Promise.all([
            source({ kind: 'team', teamId: team.id }, []),
            source(personalOwner, [teamGrant]), source(personalOwner, [ownGroupGrant]),
            source(personalOwner, [teamGrant, otherGroupGrant]),
            source(personalOwner, [otherGroupGrant]),
            source(personalOwner, [grant({ kind: 'account', accountId: viewer.id })]),
        ]);
        await inTx(async tx => {
            const admittedTeamActor = await resolveTeamActorContextInTx(tx, { teamId: team.id, actorAccountId: viewer.id });
            if (!admittedTeamActor) throw new Error('Expected the known-good Team actor');
            for (const actor of [undefined, admittedTeamActor]) {
                const scope = { actorAccountId: viewer.id, sharedWithTeamId: team.id, admittedTeamActor: actor };
                expect(await countScopedTeamProjectSourcesInTx(tx, scope)).toEqual({ ok: true, count: 4 });
                expect(await countScopedTeamProjectSourcesInTx(tx, { ...scope,
                    authentication: { legacyHomeCredential: true } })).toEqual({ ok: false, error: 'source_unavailable' });
            }
        });
    });
});
