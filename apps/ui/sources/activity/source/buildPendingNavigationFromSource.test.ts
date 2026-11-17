import { describe, expect, it } from 'vitest';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { buildPendingNavigationFromSource, isPendingNavigationRequestAnswerable, selectPendingNavigationTarget } from './buildPendingNavigationFromSource';

describe('pending navigation projection', () => {
    it('counts another pending session from an archived destination and clears it when the request settles', () => {
        const archived = createSessionFixture({ id: 'archived', serverId: 'a', archivedAt: 15 });
        const pending = createSessionFixture({ id: 'pending', serverId: 'a', active: true,
            agentState: { requests: { approval: { tool: 'Bash', arguments: {}, createdAt: 10 } } } });
        let source: ActivityAttentionSource = { isDataReady: true, sessionsById: { archived, pending },
            sessionListRowsByServerId: { a: Object.fromEntries([archived, pending].map(s => [s.id, buildSessionListRenderableFromSession(s)])) },
            ordinarySessionListMembershipByServerId: { a: ['archived', 'pending'] },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {}, activeServerId: 'a' };
        const read = () => buildPendingNavigationFromSource({ source, nowMs: 20,
            excluding: { serverId: 'a', sessionId: 'archived' } }).map(candidate => candidate.address.sessionId);
        expect(read()).toEqual(['pending']);
        const settled = createSessionFixture({ ...pending, agentState: { requests: {} } });
        source = { ...source, sessionsById: { archived, pending: settled },
            sessionListRowsByServerId: { a: { archived: buildSessionListRenderableFromSession(archived),
                pending: buildSessionListRenderableFromSession(settled) } } };
        expect(read()).toEqual([]);
    });

    it('excludes inactive native dialogs from the summary count while retaining Action approval grants', () => {
        const inactive = createSessionFixture({ id: 'inactive', serverId: 'a', active: false,
            agentState: { requests: { dialog: { tool: 'AskUserQuestion', kind: 'user_action',
                source: 'claude_unified_terminal_dialog_choice', arguments: {}, createdAt: 10 } } } });
        expect(isPendingNavigationRequestAnswerable(inactive, { kind: 'user_action', source: 'claude_unified_terminal_dialog_choice' })).toBe(false);
        expect(isPendingNavigationRequestAnswerable(inactive, { kind: 'user_action', source: 'happier_action' })).toBe(true);
        const source: ActivityAttentionSource = { isDataReady: true, sessionsById: { inactive },
            sessionListRowsByServerId: { a: { inactive: buildSessionListRenderableFromSession(inactive) } },
            ordinarySessionListMembershipByServerId: { a: ['inactive'] },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {}, activeServerId: 'a' };
        expect(buildPendingNavigationFromSource({ source, nowMs: 20 })).toEqual([]);
    });
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

    it('excludes status-only locked attention from both counting and navigation', () => {
        const locked = createSessionFixture({ id: 'locked', serverId: 'a', active: true,
            encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
            viewer: {
                latestFailureSeq: null,
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
    });

    it('does not count content-unavailable rows as destinations even when retained viewer attention says full', () => {
        const session = createSessionFixture({ id: 'locked', serverId: 'a', active: true,
            encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_content_unavailable',
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] }, follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' },
            },
        });
        const source: ActivityAttentionSource = { isDataReady: true, sessionsById: { locked: session },
            sessionListRowsByServerId: { a: { locked: buildSessionListRenderableFromSession(session) } }, ordinarySessionListMembershipByServerId: { a: ['locked'] },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {}, activeServerId: 'a' };
        expect(buildPendingNavigationFromSource({ source, nowMs: 20 })).toEqual([]);
    });
});
