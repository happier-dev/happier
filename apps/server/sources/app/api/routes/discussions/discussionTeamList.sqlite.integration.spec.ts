import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiscussionListResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { createDiscussion } from '@/app/discussions/mutations';
import { setDiscussionGrant } from '@/app/discussions/accessService';
import { db } from '@/storage/db';
import { registerDiscussionRoutes } from './registerDiscussionRoutes';

const authentication = createPresentUserSessionAccessAuthentication();

describe('Selected-Team native Discussion HTTP pages', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({
        tempDirPrefix: 'discussion-team-list-', initAuth: false, initEncrypt: true,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1',
            HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_SHARING__SESSION__ENABLED: '1' },
    }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('filters before paging, preserves private Group provenance and qualifies the exact request credential', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'e2ee', publicKey: crypto.randomUUID() } });
        await makeShareEligibleForTest(owner.id, viewer.id);
        const team = await db.team.create({ data: { name: 'Selected Team' } });
        const otherTeam = await db.team.create({ data: { name: 'Other Team' } });
        for (const teamId of [team.id, otherTeam.id]) {
            await db.teamMembership.create({ data: { teamId, accountId: owner.id, role: 'owner' } });
        }
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'admin' } });
        await db.teamMembership.create({ data: { teamId: otherTeam.id, accountId: viewer.id, role: 'member' } });
        const ownGroup = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('Own Group') } });
        const hiddenGroup = await db.teamGroup.create({ data: { teamId: team.id, name: storedPlainPrivateLabel('PRIVATE_OTHER_GROUP') } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: ownGroup.id,
            teamMembershipId: membership.id, nativeContribution: true } });
        const teamPrincipal = { kind: 'team', teamId: team.id } as const;
        const ownGroupPrincipal = { kind: 'group', teamId: team.id, groupId: ownGroup.id } as const;
        const hiddenGroupPrincipal = { kind: 'group', teamId: team.id, groupId: hiddenGroup.id } as const;
        const create = async (index: number, principals: readonly PrincipalRefV1[]) => {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: `Discussion ${index}` } },
                firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: { v: 1,
                    parts: [{ t: 'text', text: 'Review' }] } }, mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            const id = created.value.discussion.id;
            for (const principal of principals) {
                const grant = await setDiscussionGrant({ authentication, actorAccountId: owner.id, discussionId: id,
                    request: { principal, accessLevel: 'view' } });
                if (!grant.ok) throw new Error(grant.error);
            }
            await db.discussion.update({ where: { id }, data: { lastMessageAt: new Date(index + 1) } });
            return id;
        };
        const selected = [await create(0, [teamPrincipal]), await create(1, [ownGroupPrincipal]),
            await create(2, [teamPrincipal, ownGroupPrincipal]), await create(3, [teamPrincipal, hiddenGroupPrincipal])];
        const independent = await create(4, [hiddenGroupPrincipal, { kind: 'account', accountId: viewer.id }]);
        const hidden = await create(5, [hiddenGroupPrincipal]);
        const other = await create(6, [{ kind: 'team', teamId: otherTeam.id }]);
        const direct = await create(7, [{ kind: 'account', accountId: viewer.id }]);
        const scopedIds = [independent, ...selected.slice().reverse()];
        const app = createAuthenticatedTestApp();
        registerDiscussionRoutes(app);
        const headers = { 'x-test-user-id': viewer.id };
        const read = (query: string, requestHeaders: Record<string, string> = headers) => app.inject({ method: 'GET',
            url: `/v1/discussions?${query}`, headers: requestHeaders });
        try {
            const ordinary = await read('limit=100');
            expect(ordinary.statusCode).toBe(200);
            const globalPage = DiscussionListResponseV1Schema.parse(ordinary.json());
            expect(new Set(globalPage.discussions.map(row => row.id))).toEqual(new Set([...selected, independent, other, direct]));
            expect(globalPage.discussions.every(row => row.sharedWithTeamScope === undefined)).toBe(true);
            const pages = [];
            let cursor: string | null = null;
            do {
                const response = await read(`sharedWithTeamId=${team.id}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                expect(response.statusCode).toBe(200);
                const page = DiscussionListResponseV1Schema.parse(response.json());
                expect(page.discussions).toHaveLength(1);
                pages.push(...page.discussions);
                cursor = page.nextCursor;
            } while (cursor !== null);
            expect(pages.map(row => row.id)).toEqual(scopedIds);
            expect(pages.map(row => row.sharedWithTeamScope)).toEqual(['group', 'team', 'team_and_group', 'group', 'team']);
            const projected = JSON.stringify(pages);
            for (const privateValue of [hidden, other, direct, hiddenGroup.id, 'PRIVATE_OTHER_GROUP']) expect(projected).not.toContain(privateValue);
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
                v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
            } } });
            const refused = await read(`sharedWithTeamId=${team.id}`);
            expect(refused.statusCode).toBe(403);
            expect(refused.json()).toEqual({ error: 'team_authentication_required' });
            const qualified = await read(`sharedWithTeamId=${team.id}`, { ...headers,
                'x-test-authentication-evidence': JSON.stringify([{ kind: 'home_method', methodId: 'key_challenge' }]) });
            expect(qualified.statusCode).toBe(200);
            expect(DiscussionListResponseV1Schema.parse(qualified.json()).discussions.map(row => row.id)).toEqual(scopedIds);
            await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 1, mode: 'restricted', accepted: [] } } });
            const unavailable = await read(`sharedWithTeamId=${team.id}`);
            expect(unavailable.statusCode).toBe(403);
            expect(unavailable.json()).toEqual({ error: 'team_authentication_unavailable' });
        } finally { await app.close(); }
    });
});
