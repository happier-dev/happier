import { describe, expect, it } from 'vitest';

import type { SessionAttentionStandingPolicy } from '../../organization/attentionStanding';
import { computeVisibleSessionListIndex } from '../computeVisibleSessionListIndex';
import type { SessionListIndexItem } from '../sessionListIndex';
import type { SessionListRenderableSession } from '../sessionListRenderable';

function makeSessionRow(
    id: string,
    partial?: Partial<SessionListRenderableSession>,
): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...(partial ?? {}),
    };
}

function makeResolver(rowsByKey: Record<string, SessionListRenderableSession>) {
    return (serverId: string | null | undefined, sessionId: string) => {
        const key = `${String(serverId ?? '').trim()}:${String(sessionId ?? '').trim()}`;
        return rowsByKey[key] ?? null;
    };
}

describe('attention standing in the visible session list index', () => {
    it('orders the standing floor behind earned attention reasons and ahead of the working band', () => {
        const now = 1_000_000;
        const groupKey = 'server:s1:day:2026-08-19';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'standing', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'working', serverId: 's1', section: 'active', groupKey, groupKind: 'date' },
        ];
        const standingPolicy: SessionAttentionStandingPolicy = {
            defaultStanding: false,
            overridesBySessionKey: { 's1:standing': true },
        };

        const result = computeVisibleSessionListIndex({
            source,
            resolveSessionRow: makeResolver({
                's1:standing': makeSessionRow('standing', {
                    seq: 4,
                    lastViewedSessionSeq: 4,
                    hasUnreadMessages: false,
                    updatedAt: now - 5_000,
                    meaningfulActivityAt: now - 5_000,
                }),
                's1:unread': makeSessionRow('unread', {
                    seq: 9,
                    lastViewedSessionSeq: 4,
                    hasUnreadMessages: true,
                    unreadSince: now - 20_000,
                    updatedAt: now - 20_000,
                }),
                's1:working': makeSessionRow('working', {
                    active: true,
                    presence: 'online',
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: now - 1_000,
                    updatedAt: now - 1_000,
                }),
            }),
            hideInactiveSessions: false,
            pinnedSessionKeysV1: [],
            sessionListGroupOrderV1: {},
            presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
            attentionPromotion: { mode: 'global', standingPolicy },
            workingPlacement: { mode: 'global' },
            nowMs: now,
        })!;

        expect(result.map((item) => (item.type === 'header'
            ? `h:${item.headerKind ?? 'unknown'}`
            : `s:${item.sessionId}:${item.attentionPromotionReason ?? 'none'}:${item.workingPlacementReason ?? 'none'}`
        ))).toEqual([
            'h:attention',
            's:unread:unread:none',
            's:standing:standing:none',
            'h:working',
            's:working:none:working',
        ]);
    });

    describe('hide inactive sessions', () => {
        const now = 2_000_000;
        const groupKey = 'server:s1:day:2026-08-19';
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
            { type: 'session', sessionId: 'standing', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
            { type: 'session', sessionId: 'unread', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        ];
        const resolveSessionRow = makeResolver({
            's1:standing': makeSessionRow('standing', {
                seq: 4,
                lastViewedSessionSeq: 4,
                hasUnreadMessages: false,
                updatedAt: now - 5_000,
                meaningfulActivityAt: now - 5_000,
            }),
            's1:unread': makeSessionRow('unread', {
                seq: 9,
                lastViewedSessionSeq: 4,
                hasUnreadMessages: true,
                unreadSince: now - 20_000,
                updatedAt: now - 20_000,
            }),
        });

        function computeRows(params: Readonly<{
            standingPolicy: SessionAttentionStandingPolicy;
            hideInactiveSessions: boolean;
        }>): string[] {
            const result = computeVisibleSessionListIndex({
                source,
                resolveSessionRow,
                hideInactiveSessions: params.hideInactiveSessions,
                pinnedSessionKeysV1: [],
                sessionListGroupOrderV1: {},
                presentation: { enabled: false, presentation: 'grouped', selectedServerIds: [] },
                attentionPromotion: { mode: 'global', standingPolicy: params.standingPolicy },
                workingPlacement: { mode: 'off' },
                nowMs: now,
            })!;
            return result.flatMap((item) => (item.type === 'session'
                ? [`${item.sessionId}:${item.attentionPromotionReason ?? 'none'}`]
                : []));
        }

        it('keeps a session standing by explicit override visible', () => {
            expect(computeRows({
                standingPolicy: { defaultStanding: false, overridesBySessionKey: { 's1:standing': true } },
                hideInactiveSessions: true,
            })).toEqual(['unread:unread', 'standing:standing']);
        });

        it('hides a session standing only by the account default', () => {
            expect(computeRows({
                standingPolicy: { defaultStanding: true, overridesBySessionKey: {} },
                hideInactiveSessions: true,
            })).toEqual(['unread:unread']);
        });

        it('shows a session standing by the account default while inactive sessions are shown', () => {
            expect(computeRows({
                standingPolicy: { defaultStanding: true, overridesBySessionKey: {} },
                hideInactiveSessions: false,
            })).toEqual(['unread:unread', 'standing:standing']);
        });

        it('keeps an inactive unread session promoted while inactive sessions are hidden', () => {
            expect(computeRows({
                standingPolicy: { defaultStanding: false, overridesBySessionKey: {} },
                hideInactiveSessions: true,
            })).toEqual(['unread:unread']);
        });
    });
});
