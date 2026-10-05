import { describe, expect, it } from 'vitest';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { resolvePendingReorderIds } from './pendingReorder';

const scope = { serverId: 'home-a', accountId: 'account-a' };
function row(id: string, extra: Partial<PendingMessage> = {}): PendingMessage {
    return { id: `projection-${id}`, localId: id, source: 'server_pending', text: id, rawRecord: {},
        createdAt: 1, updatedAt: 1, pendingDeliveryStatus: 'server_queued', ...extra };
}
const input = { scope, sessionId: 'session-a', recipient: null, sourceId: 'a', position: { anchorId: 'b', placement: 'after' as const } };

describe('exact pending queue semantic reorder', () => {
    it('moves current projection identities while retaining insertions and the exact recipient', () => {
        const messages = [row('a'), row('inserted'), row('run', { recipient: { kind: 'execution_run', runId: 'run-a' } }), row('b')];
        expect(resolvePendingReorderIds(messages, input)).toEqual(['inserted', 'b', 'a']);
        expect(resolvePendingReorderIds(messages, { ...input, sourceId: 'projection-a', position: { anchorId: 'projection-b', placement: 'after' } })).toEqual(['inserted', 'b', 'a']);
        expect(resolvePendingReorderIds(messages, { ...input, recipient: { kind: 'execution_run', runId: 'run-a' } })).toBeNull();
    });
    it('refuses deleted anchors, foreign custody, and local sender-owned input', () => {
        expect(resolvePendingReorderIds([row('a')], input)).toBeNull();
        expect(resolvePendingReorderIds([row('a', { pendingOutboxScope: { ...scope, serverId: 'home-b' } }), row('b')], input)).toBeNull();
        expect(resolvePendingReorderIds([row('a', { source: 'local_outbound' }), row('b')], input)).toBeNull();
    });
    it('does not move provider-effect-possible slots, including indirectly crossing them', () => {
        expect(resolvePendingReorderIds([row('a'), row('fenced', { pendingDeliveryStatus: 'external_handoff' }), row('b')], input)).toBeNull();
        expect(resolvePendingReorderIds([row('a'), row('b'), row('fenced', { pendingDeliveryStatus: 'external_handoff' })], input)).toEqual(['b', 'a', 'fenced']);
    });
});
