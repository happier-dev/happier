import { describe, expect, it } from 'vitest';
import { resolveSessionForkVisualReferenceTargetV1 } from './forkVisualCopies.js';

describe('fork visual reference target', () => {
    it('resolves only the exact original Home/Session/Item to child-owned content without a parent fallback', () => {
        const reference = { address: { serverId: 'home', sessionId: 'parent' }, itemId: 'graph' };
        const childAddress = { serverId: 'home', sessionId: 'child' };
        const copies = [{ originServerId: 'home', originSessionId: 'parent', originItemId: 'graph', status: 'copied' as const, itemId: 'child-graph' }];
        expect(resolveSessionForkVisualReferenceTargetV1({ reference, childAddress, copies })).toEqual({ status: 'copied', address: childAddress, itemId: 'child-graph' });
        expect(resolveSessionForkVisualReferenceTargetV1({ reference: { ...reference, address: { ...reference.address, serverId: 'other' } }, childAddress, copies })).toEqual({ status: 'not_copied' });
        expect(resolveSessionForkVisualReferenceTargetV1({ reference, childAddress, copies: [{ ...copies[0]!, status: 'not_copied' }] })).toEqual({ status: 'not_copied' });
        expect(resolveSessionForkVisualReferenceTargetV1({ reference, childAddress, copies: [] })).toEqual({ status: 'not_copied' });
    });
});
