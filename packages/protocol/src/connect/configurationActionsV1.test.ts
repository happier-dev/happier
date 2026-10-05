import { describe, expect, it } from 'vitest';
import { reorderConnectedServicePoolMembersV1 } from './configurationActionsV1.js';

describe('Pool member order owner', () => {
    it('uses the member-id tiebreaker for a semantic move without moving tied neighbours', async () => {
        const group = { members: [{ accountId: 'c', priority: 100 }, { accountId: 'b', priority: 100 }, { accountId: 'a', priority: 100 }] };
        const result = await reorderConnectedServicePoolMembersV1({ group,
            move: { accountId: 'c', position: { anchorId: 'a', placement: 'before' } },
            members: current => current.members,
            // Persistence is the boundary. The writer and ordering/admission remain real.
            patch: async (current, accountId, priority) => ({ members: current.members.map(member => member.accountId === accountId ? { ...member, priority } : member) }),
        });
        expect([...result!.members].sort((a, b) => a.priority - b.priority).map(member => member.accountId)).toEqual(['c', 'a', 'b']);
    });
});
