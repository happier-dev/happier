import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db } from '@/storage/db';
import { listSessionsForAccount } from './service';
import { createV2SessionListServerTiming } from './timing';

export async function verifySessionSpaceMembershipListing() {
    vi.stubEnv('HAPPIER_FEATURE_SHARING_SESSION__ENABLED', '1');
    const prefix = `space-membership-${randomUUID()}`;
    const [viewer, other] = await Promise.all([0, 1].map(index => db.account.create({ data: {
        publicKey: `${prefix}-${index}`, encryptionMode: 'plain',
    } })));
    const team = await db.team.create({ data: { name: prefix } });
    await db.teamMembership.create({ data: {
        teamId: team.id, accountId: viewer.id, role: 'member', sessionAccessStartsAt: null,
    } });
    const [smartFolder, manualFolder, excludedFolder] = await Promise.all([0, 1, 2].map(() =>
        db.sessionOrganizationFolder.create({ data: {
            accountId: viewer.id, folderKey: randomUUID(), folderHash: randomUUID(),
        } })));
    const [membershipTag, ordinaryTag] = await Promise.all([0, 1].map(() =>
        db.sessionOrganizationTag.create({ data: {
            accountId: viewer.id, tagKey: randomUUID(), tagHash: randomUUID(),
        } })));
    const ids = ['smart', 'manual', 'unrefined', 'ordinary', 'archived', 'foreign', 'other-assignment', 'outside-team']
        .map(name => `${prefix}-${name}`);
    try {
        await db.session.createMany({ data: ids.map((id, index) => ({
            id, tag: id, accountId: index === 5 ? other.id : viewer.id,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: '{"v":1}',
            ownerMetadata: '{"t":"plain","v":{"v":1}}', meaningfulActivityAt: new Date(index === 1 ? 1 : 100 + index),
            ...(index === 4 ? { archivedAt: new Date(1) } : {}),
        })) });
        await db.sessionFolderAssignment.createMany({ data: ids.map((sessionId, index) => ({
            accountId: viewer.id, sessionId,
            folderId: index === 0 ? smartFolder.id : index === 2 ? excludedFolder.id : manualFolder.id,
        })) });
        await db.sessionTeamGrant.createMany({ data: ids.filter((_, index) => index !== 5 && index !== 7).map(sessionId => ({
            sessionId, teamId: team.id, effectiveAt: new Date(1), accessLevel: 'view',
        })) });
        await db.sessionTagAssignment.createMany({ data: [
            ...ids.map(sessionId => ({ accountId: viewer.id, sessionId, tagId: ordinaryTag.id })),
            ...ids.filter((_, index) => index !== 0 && index !== 3 && index !== 6).map(sessionId => ({
                accountId: viewer.id, sessionId, tagId: membershipTag.id,
            })),
            { accountId: other.id, sessionId: ids[6]!, tagId: membershipTag.id },
        ] });
        const read = async (mode: 'filter_or_manual' | 'manual_only', attention = 'any', scope = 'my_work', tagIds = [membershipTag.id], includeFilter = true,
            refinements: { attention?: 'needs_my_attention'; smartCoordinator?: boolean } = {}) => {
            const result: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await listSessionsForAccount({
                    userId: viewer.id, authentication: createPresentUserSessionAccessAuthentication(),
                    source: { kind: 'query', query: SessionListQueryV1Schema.parse({
                        v: 1, storage: 'active', includeInactive: true, scope: 'my_work', attention: refinements.attention ?? 'any',
                        audiences: [{ kind: 'team', teamId: team.id }], tagIds: [ordinaryTag.id],
                        folderIds: [smartFolder.id, manualFolder.id], limit: 1,
                        membership: { mode, tagIds, ...(includeFilter ? { filter: {
                            scope, attention, audiences: [], tagIds: [], folderIds: [smartFolder.id],
                            ...(refinements.smartCoordinator ? { coordinator: 'coordinator' } : {}),
                        } } : {}) }, ...(cursor ? { cursor } : {}),
                    }) }, rowRepresentabilityWhere: {}, timing: createV2SessionListServerTiming({}),
                });
                expect(page).not.toBeNull();
                if (!page) throw new Error('Expected a membership page');
                expect('membershipUnavailableReason' in page! ? page.membershipUnavailableReason : undefined)
                    .toBe(mode === 'filter_or_manual' && scope === 'following' ? 'following' : undefined);
                expect(page!.sessions.length).toBeLessThanOrEqual(1);
                result.push(...page!.sessions.map(row => row.id));
                for (const row of page!.sessions) {
                    expect(row.viewer?.tagIds).toContain(ordinaryTag.id);
                    if (row.id === ids[1]) expect(row.viewer?.tagIds).toContain(membershipTag.id);
                }
                cursor = page!.hasNext ? page!.nextCursor ?? undefined : undefined;
                expect(result.length).toBeLessThanOrEqual(2);
                if (page!.hasNext) expect(cursor).toBeTruthy();
            } while (cursor);
            return result;
        };
        expect(await read('filter_or_manual')).toEqual([ids[0], ids[1]]);
        expect(await read('manual_only')).toEqual([ids[1]]);
        expect(await read('manual_only', 'any', 'my_work', [])).toEqual([]);
        expect(await read('filter_or_manual', 'any', 'my_work', [], false)).toEqual([]);
        // A smart attention miss never removes independently proven manual membership.
        expect(await read('filter_or_manual', 'needs_my_attention')).toEqual([ids[1]]);
        expect(await read('filter_or_manual', 'any', 'my_work', [membershipTag.id], true, { smartCoordinator: true })).toEqual([ids[1]]);
        // Temporary attention refinements narrow both branches of the saved union.
        expect(await read('filter_or_manual', 'any', 'my_work', [membershipTag.id], true, { attention: 'needs_my_attention' })).toEqual([]);
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED', '0');
        expect(await read('filter_or_manual', 'any', 'following')).toEqual([ids[1]]);
    } finally {
        await db.session.deleteMany({ where: { id: { in: ids } } });
        await db.team.delete({ where: { id: team.id } });
        await db.account.deleteMany({ where: { id: { in: [viewer.id, other.id] } } });
    }
}
