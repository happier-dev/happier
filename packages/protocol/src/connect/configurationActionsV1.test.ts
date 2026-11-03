import { describe, expect, it } from 'vitest';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1, reorderConnectedServicePoolMembersV1 } from './configurationActionsV1.js';

it('accepts Account-origin purpose defaults without a Machine while retaining exact Machine inputs', () => {
    const schema = CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1['connectedServices.purposes.default.set'];
    const input = { purpose: { consumer: { pluginId: 'com.acme.source', localId: 'discover' }, purpose: 'api' },
        target: { kind: 'account', account: { service: { pluginId: 'com.acme.source', localId: 'api' }, accountId: 'own' } } };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.parse({ ...input, machineId: 'selected-machine' })).toEqual({ ...input, machineId: 'selected-machine' });
    expect(schema.safeParse({ ...input, machineId: '' }).success).toBe(false);
    expect(schema.safeParse({ ...input, anotherAccount: 'foreign' }).success).toBe(false);
});

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
