import { describe, expect, it } from 'vitest';
import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { PersonalFollowOnceOccurrenceV1Schema } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { Message } from '@happier-dev/session-core/messages';
import { createReducer } from '@happier-dev/session-core/reducer';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import { buildActivityOverviewFromCandidates } from '@/activity/attention/buildActivityOverviewSnapshot';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storageStore';

import { buildInboxSessionPresentation, classifyInboxSessionCandidate } from './buildInboxSessionPresentation';
import { buildInboxWorkGroups } from './buildInboxWorkGroups';
import { buildInboxItems } from '@/components/inbox/inboxItems';

function candidate(
    id: string,
    reasons: readonly SessionPersonalAttentionReasonV1[],
    serverId = 'server-a',
    sessionOverrides: Parameters<typeof createSessionFixture>[0] = {},
) {
    const session = createSessionFixture({
        id,
        serverId,
        ...sessionOverrides,
        viewer: {
            latestFailureSeq: null,
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
            attention: {
                needsAttention: reasons.length > 0,
                reasons,
                primary: reasons[0] ?? null,
                presentation: 'full',
            },
        },
    });
    return buildSessionActivityAttention({ session, nowMs: 1_000 });
}

describe('buildInboxSessionPresentation', () => {
    it('carries the canonical effective colour for exact-Home Inbox sessions', () => {
        const first = candidate('same-id', ['permission_required'], 'a');
        const second = candidate('same-id', ['permission_required'], 'b');
        const color = { kind: 'accent', key: 'purple' } as const;
        const result = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([first, second]),
            appearanceColorsBySessionKey: new Map([[sessionAddressKey({ serverId: 'a', sessionId: 'same-id' }), color]]),
        });
        expect(result.sessionsNeedingAttention.find(entry => entry.candidate.serverId === 'a')).toHaveProperty('appearanceColor', color);
        expect(result.sessionsNeedingAttention.find(entry => entry.candidate.serverId === 'b')).toHaveProperty('appearanceColor', null);
    });
    it('does not publish a request type when the candidate has no admitted Inbox section', () => {
        const permission = candidate('quiet-permission', ['permission_required']);
        expect(classifyInboxSessionCandidate({ ...permission, hasAttention: false }))
            .toEqual({ section: null, type: null });
        expect(classifyInboxSessionCandidate(candidate('quiet', [])))
            .toEqual({ section: null, type: null });
    });
    it.each(['ready', 'cancelled', 'failed'] as const)('retains the accepted original %s completion while a newer turn is working, anchoring only known source context', (event) => {
        for (const transcriptSeq of [18, 0, undefined]) {
            const onceDelivery = PersonalFollowOnceOccurrenceV1Schema.parse({ event, turnId: 'original-turn',
                agentStateVersion: 4, ...(transcriptSeq === undefined ? {} : { transcriptSeq }) });
            const base = candidate('once-session', [event === 'failed' ? 'failed' : 'ready_after_read'], 'server-a', {
                active: true, activeAt: 1_000, latestTurnId: 'newer-turn', latestTurnStatus: 'in_progress',
            });
            const session = { ...base.session, viewer: { ...base.session.viewer!,
                follow: { ...base.session.viewer!.follow, onceDelivery },
            } };
            const current = buildSessionActivityAttention({ session, nowMs: 1_000 });
            const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([current]) });
            const workGroups = buildInboxWorkGroups({ sessionEntries: sessionPresentation.sessionsNeedingAttention,
                workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [], stalledSessions: [], landings: [],
                snoozed: [], resolveSession: () => session, resolveOriginRunId: () => null });
            const input = { sessionPresentation, workGroups, workflowServerId: null, accountServerId: 'server-a', notices: [] };
            const rows = buildInboxItems(input);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ type: 'update', source: { onceDelivery } });
            expect(rows[0]?.pageRoute).toBe(`/session/once-session?serverId=server-a${transcriptSeq ? `&jumpSeq=${transcriptSeq}` : ''}`);
            expect(buildInboxItems(input, rows)).toBe(rows);

            const revisedDelivery = { ...onceDelivery, agentStateVersion: 5 };
            const revise = (value: SessionActivityAttention) => ({ ...value, session: { ...value.session,
                viewer: { ...value.session.viewer!, follow: { ...value.session.viewer!.follow, onceDelivery: revisedDelivery } } } });
            const revised = buildInboxItems({ ...input,
                sessionPresentation: { ...sessionPresentation, readySessions: sessionPresentation.readySessions.map(revise) },
                workGroups: workGroups.map(group => ({ ...group, items: group.items.map(item => item.kind === 'session'
                    ? { ...item, entry: { ...item.entry, candidate: revise(item.entry.candidate) } } : item) })),
            }, rows);
            expect(revised[0]?.source).toMatchObject({ onceDelivery: revisedDelivery });
        }
    });

    it('preserves a blocked question type from the actual pending request owner', () => {
        const question = candidate('blocked-question', ['user_action_required'], 'server-a', {
            active: true, activeAt: 1_000,
            agentState: { requests: { blocked: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 950,
                questionV1: { mode: 'wait', type: 'blocked', lasting: false }, currentHandler: { kind: 'person' },
            } } },
        });
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([question]) });
        const workGroups = buildInboxWorkGroups({ sessionEntries: sessionPresentation.sessionsNeedingAttention,
            workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [], stalledSessions: [], landings: [],
            snoozed: [], resolveSession: () => question.session, resolveOriginRunId: () => null });
        expect(buildInboxItems({ workGroups, sessionPresentation, workflowServerId: null, accountServerId: 'server-a', notices: [] })[0])
            .toMatchObject({ type: 'blocked', view: 'needs_you' });
    });

    it('does not offer an inactive native dialog as an answerable Inbox request', () => {
        const inactive = candidate('inactive', ['user_action_required'], 'server-a', { active: false,
            agentState: { requests: { dialog: { tool: 'AskUserQuestion', kind: 'user_action',
                source: 'claude_unified_terminal_dialog_choice', arguments: { questions: [{ question: 'How should this resume?' }] }, createdAt: 950 } } } });
        const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([inactive]) });
        expect(result.sessionsNeedingAttention[0]?.pendingUserActions).toEqual([]);
        expect(result.sessionsNeedingAttention[0]?.requestDetails?.userActions).toMatchObject([
            { id: 'dialog', arguments: { questions: [{ question: 'How should this resume?' }] } },
        ]);
        expect(result.pendingRequestHydrationTargets).toEqual([]);
    });
    it('does not recover a missing exact-Home transcript from the ambient same-id session', () => {
        const previous = storage.getState();
        const foreignMessage: Message = { id: 'foreign', kind: 'tool-call', localId: null, createdAt: 950,
            tool: { id: 'foreign-tool', name: 'Bash', state: 'running', input: { command: 'foreign command' }, createdAt: 950,
                startedAt: null, completedAt: null, description: null, permission: { id: 'foreign-request', status: 'pending' } }, children: [] };
        const permission = candidate('same-id', ['permission_required'], 'home-a', { active: true, activeAt: 1_000 });
        storage.setState({ sessions: { 'same-id': createSessionFixture({ id: 'same-id', serverId: 'home-b' }) },
            sessionMessages: { 'same-id': { messageIdsOldestFirst: ['foreign'], messagesById: { foreign: foreignMessage },
                messagesMap: { foreign: foreignMessage }, reducerState: createReducer(), latestThinkingMessageId: null,
                latestThinkingMessageActivityAtMs: null, messagesVersion: 1, isLoaded: true } } });
        try {
            const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([permission]), resolveMessages: () => undefined });
            expect(result.sessionsNeedingAttention[0]?.pendingPermissions).toEqual([]);
            expect(result.pendingRequestHydrationTargets).toEqual([{ serverId: 'home-a', sessionId: 'same-id' }]);
        } finally {
            storage.setState({ sessions: previous.sessions, sessionMessages: previous.sessionMessages });
        }
    });

    it('requests exact-Home hydration for summary-only decisions, not quiet or unreadable rows', () => {
        const permission = candidate('permission', ['permission_required']);
        const question = candidate('question', ['user_action_required'], 'server-b', { active: true, activeAt: 1_000 });
        const locked = { ...candidate('locked', ['permission_required']), awareness: { ...permission.awareness, encryption: 'locked' as const } };
        const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([
            permission, question, locked, candidate('quiet', []),
        ]) });
        expect(result.pendingRequestHydrationTargets).toEqual([
            { serverId: 'server-a', sessionId: 'permission' },
            { serverId: 'server-b', sessionId: 'question' },
        ]);
    });

    it('carries a hydrated request without scheduling another load', () => {
        const permission = candidate('permission', ['permission_required'], 'server-a', {
            active: true, activeAt: 1_000,
            agentState: { controlledByUser: false, requests: { request: { tool: 'Bash', arguments: { command: 'mkdir work' }, createdAt: 950 } } },
        });
        const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([permission]) });
        expect(result.sessionsNeedingAttention[0]?.pendingPermissions).toMatchObject([{ id: 'request', tool: 'Bash' }]);
        expect(result.pendingRequestHydrationTargets).toEqual([]);
    });

    it('acquires absent request state before using a retained inactive row to decide answer entitlement', () => {
        const retained = candidate('worker', ['user_action_required'], 'home-a', { active: false, agentState: null });
        const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([retained]) });
        expect(result.sessionsNeedingAttention[0]?.pendingUserActions).toEqual([]);
        expect(result.pendingRequestHydrationTargets).toEqual([{ serverId: 'home-a', sessionId: 'worker' }]);
    });

    it('reads transcript-only decisions for readable content with status-only notifications', () => {
        const base = candidate('permission', ['permission_required'], 'server-a', { active: true, activeAt: 1_000 });
        const permission = { ...base, personalAttention: { ...base.personalAttention, presentation: 'status_only' as const } };
        const messages: Message[] = [{ id: 'message', kind: 'tool-call', localId: null, createdAt: 950,
            tool: { id: 'tool', name: 'Bash', state: 'running', input: { command: 'mkdir work' }, createdAt: 950,
                startedAt: null, completedAt: null, description: null, permission: { id: 'request', status: 'pending' } }, children: [] }];
        const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([permission]), resolveMessages: () => messages });
        expect(result.sessionsNeedingAttention[0]?.pendingPermissions).toMatchObject([{ id: 'request', tool: 'Bash' }]);
        expect(result.pendingRequestHydrationTargets).toEqual([]);
    });

    it('does not admit quiet offline sessions or discard explicit viewer attention for being offline', () => {
        const quiet = candidate('quiet', [], 'server-a', { active: false, presence: 1 });
        const manual = candidate('manual', ['manual'], 'server-a', { active: false, presence: 1 });
        const result = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([quiet, manual]) });
        expect(result.sessionsNeedingAttention.map(entry => entry.candidate.sessionId)).toEqual(['manual']);
    });

    it('keeps every personal reason in its truthful section and only marks transcript progress as read', () => {
        const failed = candidate('failed', ['failed']);
        const permissionAndUnread = candidate('permission', ['permission_required', 'unread']);
        const discussion = candidate('discussion', ['unread_discussion']);
        const mentioned = candidate('mentioned', ['mentioned']);
        const unread = candidate('unread', ['unread']);
        const readyAfterRead = candidate('ready', ['ready_after_read']);
        const reminder = candidate('reminder', ['reminder_due']);
        const manual = candidate('manual', ['manual']);

        // Summary admission and the eventual row consume this one classification.
        // Manual attention remains an Updates row and is not cleared by session read.
        expect(classifyInboxSessionCandidate(manual)).toEqual({ section: 'needs_attention', type: 'update' });
        expect(classifyInboxSessionCandidate(permissionAndUnread)).toEqual({ section: 'needs_attention', type: 'approval' });
        expect(classifyInboxSessionCandidate(mentioned)).toEqual({ section: 'needs_attention', type: 'mention' });
        expect(classifyInboxSessionCandidate(readyAfterRead)).toEqual({ section: 'ready', type: 'update' });

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([
                failed,
                permissionAndUnread,
                discussion,
                mentioned,
                unread,
                readyAfterRead,
                reminder,
                manual,
            ]),
        });

        expect(presentation.sessionsNeedingAttention.map((entry) => entry.candidate.sessionId)).toEqual(expect.arrayContaining([
            'failed',
            'permission',
            'discussion',
            'mentioned',
            'reminder',
            'manual',
        ]));
        expect(presentation.sessionsNeedingAttention).toHaveLength(6);
        const rows = buildInboxItems({ sessionPresentation: presentation,
            workGroups: buildInboxWorkGroups({ sessionEntries: presentation.sessionsNeedingAttention,
                workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [], stalledSessions: [],
                landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            workflowServerId: null, accountServerId: 'server-a', notices: [],
        });
        expect(Object.fromEntries(rows.map(row => [row.source.id, [row.type, row.view]]))).toMatchObject({
            failed: ['update', 'updates'], permission: ['approval', 'needs_you'], discussion: ['update', 'updates'],
            mentioned: ['mention', 'mentions'], reminder: ['update', 'updates'], manual: ['update', 'updates'], ready: ['update', 'updates'],
        });
        expect(presentation.readySessions.map((entry) => entry.sessionId)).toEqual(['ready']);
        // Discussion unread and mentions are Discussion-owned: a session-scoped
        // manual read does not clear them, so Inbox never offers them here.
        expect(presentation.markAllReadTargets.map((target) => target.sessionId).sort()).toEqual([
            'ready',
        ]);
        expect(presentation.markAllReadTargets.every((target) => target.readState === 'unread')).toBe(true);
    });

    it('addresses the same session id on two Homes as two distinct read targets', () => {
        const onHomeA = candidate('session-x', ['unread'], 'home-a');
        const onHomeB = candidate('session-x', ['unread'], 'home-b');

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([onHomeA, onHomeB]),
        });

        expect(presentation.readySessions).toHaveLength(0);
        expect(presentation.markAllReadTargets).toHaveLength(0);
    });

    it('lists an actionable session that is also unread once without inventing a read target', () => {
        const both = candidate('both', ['permission_required', 'unread'], 'server-a', {
            latestTurnStatus: 'completed',
            lastTurnCompletedAt: 900,
        });

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([both]),
        });

        expect(presentation.sessionsNeedingAttention.map((entry) => entry.candidate.sessionId)).toEqual(['both']);
        expect(presentation.readySessions).toHaveLength(0);
        expect(presentation.markAllReadTargets).toHaveLength(0);
    });

    it.each(['unread', 'ready_after_read'] as const)('defers ordinary %s attention while the canonical runtime projection is working', (reason) => {
        const workingUnread = candidate('working-unread', [reason], 'server-a', {
            active: true,
            presence: 'online',
            latestTurnStatus: 'in_progress',
        });

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([workingUnread]),
        });

        expect(workingUnread.awareness.operational.reasons).toContain('working');
        expect(presentation.readySessions).toHaveLength(0);
        expect(presentation.sessionsNeedingAttention).toHaveLength(0);
        expect(presentation.markAllReadTargets).toHaveLength(0);
    });

    it('presents a completed unseen turn as ready for review through the canonical operational state', () => {
        const completedUnread = candidate('completed-unread', ['ready_after_read'], 'server-a', {
            active: true, activeAt: 1_000, presence: 'online',
            latestTurnStatus: 'completed',
            lastTurnCompletedAt: 900,
        });

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([completedUnread]),
        });

        expect(completedUnread.attentionState).toBe('finished_unseen');
        expect(presentation.readySessions.map((entry) => entry.sessionId)).toEqual(['completed-unread']);
        expect(presentation.markAllReadTargets.map((target) => target.sessionId)).toEqual(['completed-unread']);
    });

    it('defers a ready unread turn while canonical background activity is still running', () => {
        const backgroundActiveUnread = candidate('background-active-unread', ['unread'], 'server-a', {
            encryptionMode: 'plain',
            active: true,
            latestTurnStatus: 'completed',
            lastTurnCompletedAt: 900,
            activeAt: 950,
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 950,
            runtimeActivityRevision: 1,
            metadata: {
                path: '/Users/tester/project',
                homeDir: '/Users/tester',
                host: 'tester.local',
                machineId: 'machine-1',
                runtimeMode: 'background',
            },
        });

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([backgroundActiveUnread]),
        });

        expect(backgroundActiveUnread.awareness.operational.reasons).toContain('background_activity');
        expect(presentation.readySessions).toHaveLength(0);
        expect(presentation.markAllReadTargets).toHaveLength(0);
    });

    it('keeps concurrent actionable attention while deferring a working session read target', () => {
        const workingPermission = candidate(
            'working-permission',
            ['permission_required', 'unread'],
            'server-a',
            {
                active: true,
                presence: 'online',
                latestTurnStatus: 'in_progress',
            },
        );

        const presentation = buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates([workingPermission]),
        });

        expect(presentation.sessionsNeedingAttention.map((entry) => entry.candidate.sessionId))
            .toEqual(['working-permission']);
        expect(presentation.readySessions).toHaveLength(0);
        expect(presentation.markAllReadTargets).toHaveLength(0);
    });
});
