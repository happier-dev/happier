import { describe, expect, it } from 'vitest';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { buildPendingNavigationFromSource, isPendingNavigationRequestAnswerable, selectPendingNavigationTarget } from './buildPendingNavigationFromSource';

describe('pending navigation projection', () => {
    it('uses the actual answer grant for Action confirmations rather than the question input grant', () => {
        const editor = createSessionFixture({ active: true,
            access: createSessionAccessFixture('edit', { submitAgentInput: true, approveRuntimePermissions: false }),
        });
        const question = { id: 'question', tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: {}, createdAt: 10 };
        const confirmation = { ...question, id: 'confirmation', tool: 'Happier Action confirmation', source: 'happier_action' };
        expect(isPendingNavigationRequestAnswerable(editor, question)).toBe(true);
        expect(isPendingNavigationRequestAnswerable(editor, confirmation)).toBe(false);
    });
    it('counts distinct other answerable sessions in their exact Home, excluding delivery and read-only attention', () => {
        const current = createSessionFixture({ id: 'same', serverId: 'a', active: true, agentState: {
            requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 10 } },
        } });
        const other = createSessionFixture({ ...current, serverId: 'b' });
        const delivery = createSessionFixture({ id: 'delivery', serverId: 'a', pendingBlockedCount: 1 });
        const readOnly = createSessionFixture({ ...current, id: 'read-only', access: {
            ...current.access!, capabilities: { ...current.access!.capabilities, approveRuntimePermissions: false, submitAgentInput: false },
        } });
        const source: ActivityAttentionSource = {
            isDataReady: true,
            sessionsById: { same: current, delivery, 'read-only': readOnly },
            sessionListRowsByServerId: {
                a: Object.fromEntries([current, delivery, readOnly].map((s) => [s.id, buildSessionListRenderableFromSession(s)])),
                b: { same: buildSessionListRenderableFromSession(other) },
            },
            ordinarySessionListMembershipByServerId: { a: ['same', 'delivery', 'read-only'], b: ['same'] },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
            activeServerId: 'a',
        };
        expect(buildPendingNavigationFromSource({ source, nowMs: 20, excluding: { serverId: 'a', sessionId: 'same' } })
            .map((c) => c.address)).toEqual([{ serverId: 'b', sessionId: 'same' }]);
    });

    it('selects by request age across sessions, with stable exact-address ties and unknown times last', () => {
        const requests = [
            { address: { serverId: 'a', sessionId: 'newer' }, requestId: 'permission', requestKind: 'permission' as const, createdAt: 200 },
            { address: { serverId: 'b', sessionId: 'older' }, requestId: 'question', requestKind: 'user_action' as const, createdAt: 100 },
            { address: { serverId: 'a', sessionId: 'unknown' }, requestId: 'unknown', requestKind: 'user_action' as const, createdAt: null },
        ];
        expect(selectPendingNavigationTarget(requests)?.address).toEqual({ serverId: 'b', sessionId: 'older' });
        const sameRequest = requests[1]!;
        const ties = [
            { ...sameRequest, address: { serverId: 'b', sessionId: 'same' } },
            { ...sameRequest, address: { serverId: 'a', sessionId: 'same' } },
        ];
        expect(selectPendingNavigationTarget(ties)?.address).toEqual({ serverId: 'a', sessionId: 'same' });
        expect(selectPendingNavigationTarget([...ties].reverse())?.address).toEqual({ serverId: 'a', sessionId: 'same' });
        expect(selectPendingNavigationTarget([])).toBeNull();
    });

    it('keeps locked pending summaries available for an explicit unavailable result without counting them as answerable', () => {
        const locked = createSessionFixture({ id: 'locked', serverId: 'a', active: true,
            encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
            viewer: {
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'status_only' },
            },
        });
        const source: ActivityAttentionSource = { isDataReady: true, sessionsById: { locked },
            sessionListRowsByServerId: { a: { locked: buildSessionListRenderableFromSession(locked) } }, ordinarySessionListMembershipByServerId: { a: ['locked'] },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {}, activeServerId: 'a' };
        expect(buildPendingNavigationFromSource({ source, nowMs: 20 })).toEqual([]);
        expect(buildPendingNavigationFromSource({ source, nowMs: 20, includeUnavailable: true })
            .map(candidate => candidate.address)).toEqual([{ serverId: 'a', sessionId: 'locked' }]);
    });
});
