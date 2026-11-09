import { describe, expect, it } from 'vitest';
import { fixture } from './sessionSpaceMembership.testHelpers';

const { setSessionSpaceMembership, ensureSessionSpaceMembershipTag } = await import('./sessionSpaceMembership');

describe('Space membership with a cold organization projection', () => {
    it('adds, moves and removes using tag relations without writing Account settings', async () => {
        const f = await fixture();
        const settings = f.read().raw;
        expect(await setSessionSpaceMembership({ input: f.input('a'), context: f.context })).toMatchObject({ ok: true });
        const first = f.read().assigned.find(tagId => tagId !== 'ordinary');
        expect(first).toBeDefined();
        expect(f.read().raw).toEqual(settings);
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer(f.serverId);
        expect(await setSessionSpaceMembership({ input: f.input('b', 'move', 'a'), context: f.context })).toMatchObject({ ok: true });
        expect(f.read().assigned).not.toContain(first);
        expect(f.read().assigned).toHaveLength(2);
        getStorage().getState().clearSessionOrganizationForServer(f.serverId);
        expect(await setSessionSpaceMembership({ input: f.input('b', 'remove'), context: f.context })).toMatchObject({ ok: true });
        expect(f.read().assigned).toEqual(['ordinary']);
        expect(f.read().raw).toEqual(settings);
    });

    it.each(['add', 'remove', 'move'] as const)('resolves persisted membership through the reader for cold %s', async operation => {
        const f = await fixture();
        const a = f.seedAssociated('a', { assigned: operation !== 'add' });
        const b = f.seedAssociated('b');
        const before = f.read();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationServerKey } = await import('@/sync/domains/session/organization');
        expect(getStorage().getState().sessionOrganizationTagsByTagKey[buildSessionOrganizationServerKey(f.serverId, a)]).toBeUndefined();
        expect(await setSessionSpaceMembership({ input: operation === 'move'
            ? f.input('b', 'move', 'a') : f.input('a', operation), context: f.context })).toMatchObject({ ok: true });
        expect(f.read().assigned).toEqual(operation === 'remove' ? ['ordinary'] : ['ordinary', operation === 'move' ? b : a]);
        expect(f.read().tags).toEqual(before.tags);
        expect(f.read().raw).toEqual(before.raw);
    });

    it('resolves an existing persisted membership for New with a cold organization projection', async () => {
        const f = await fixture();
        const tagId = f.seedAssociated('a');
        expect(await ensureSessionSpaceMembershipTag({ spaceId: 'a', spaceSettingsTarget: f.target,
            serverId: f.serverId, expectedAccountId: f.accountId })).toEqual({ ok: true, tagId });
        expect(f.read().assigned).toEqual(['ordinary']);
        expect(f.read().tags.map(tag => tag.tagId)).toEqual(['ordinary', tagId]);
    });

    it.each(['ordinary', 'foreign', 'unreadable', 'archived', 'missing'] as const)(
        'refuses a cold persisted association with %s content without replacing it', async kind => {
            const f = await fixture();
            f.seedAssociated('a', { assigned: true, ...(kind === 'archived' ? { archivedAt: 1 } : {}),
                ...(kind === 'ordinary' ? { display: { t: 'plain' as const, v: { label: 'Ordinary' } } }
                    : kind === 'foreign' ? { display: { t: 'plain' as const, v: {
                        kind: 'space_membership', spaceId: 'b', spaceSettingsTarget: f.target,
                    } } } : kind === 'unreadable' ? { display: { t: 'encrypted' as const, c: 'unreadable' } } : {}),
            });
            if (kind === 'missing') f.read().tags.splice(1);
            const before = { assigned: [...f.read().assigned], tags: [...f.read().tags], raw: f.read().raw };
            expect(await setSessionSpaceMembership({ input: f.input('a'), context: f.context }))
                .toMatchObject({ ok: false, errorCode: 'space_membership_unavailable' });
            expect(f.read()).toEqual(before);
        });

});
