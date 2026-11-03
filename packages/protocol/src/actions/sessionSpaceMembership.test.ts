import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

describe('space membership Action admission', () => {
    it('requires the captured catalog and an explicit Move source, without accepting smart exclusions', () => {
        const action = getActionSpec('session.space_membership.set');
        const input = { sessionId: 's1', spaceId: 'destination', spaceSettingsTarget: { serverId: 'catalog-home', accountId: 'catalog-account' } };
        expect(action.inputSchema.safeParse({ ...input, operation: 'add' }).success).toBe(true);
        expect(action.inputSchema.safeParse({ ...input, operation: 'move', sourceSpaceId: 'source' }).success).toBe(true);
        expect(action.inputSchema.safeParse({ ...input, operation: 'move' }).success).toBe(false);
        expect(action.inputSchema.safeParse({ ...input, operation: 'add', sourceSpaceId: 'source' }).success).toBe(false);
        expect(action.inputSchema.safeParse({ ...input, operation: 'remove', exclude: true }).success).toBe(false);
        expect(action.inputSchema.safeParse({ sessionId: 's1', spaceId: 'destination', operation: 'add' }).success).toBe(false);
    });
});
