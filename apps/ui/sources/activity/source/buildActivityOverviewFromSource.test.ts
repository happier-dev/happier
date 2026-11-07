import { buildStableActivityOverviewFingerprint } from '@/activity/attention/buildActivityOverviewSnapshot';
import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionAccessFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildLiveActivitySnapshots } from '@/activity/adapters/ios/liveActivities/buildLiveActivitySnapshots';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';

import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';
import { ACTIVITY_PERSONAL_SESSION_QUERY } from './activityPersonalSessionMembership';

import {
    buildActivityOverviewSummaryFromSource,
    buildActivityOverviewFromSource,
    forEachActivitySummaryCandidate,
    readActivitySourceAttentionMessages,
} from './buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { buildMachineWorkingCounts, machineWorkingKey } from '@/components/machines/work/machineWorkingCounts';
import { readActivitySessionRulePolicies } from './readActivitySessionRulePolicies';
import { projectSessionFollowFactsV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { projectViewerReadStateV1 } from '@happier-dev/protocol/sessions/personal/readState';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';
import { sessionFollowSourceRuntimeStateLabel } from '@/components/sessions/follow/sessionFollowSourcePresentation';
import { buildInboxSessionContextLine } from '@/components/inbox/workGroups/inboxSessionContextLine';
import { projectSessionDisplayV1} from '@happier-dev/protocol/sessions';
import { SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

function pendingAgentState(kind: 'permission' | 'user_action', createdAt = 950) {
    return {
        controlledByUser: null,
        requests: {
            request_1: {
                tool: kind === 'permission' ? 'Bash' : 'Read',
                kind,
                arguments: {},
                createdAt,
            },
        },
    };
}

it.each(['voice_conversation', 'voice_carrier', 'voice_conversation_retired', 'other-hidden-service'])(
    'keeps exact hidden Voice custody from a cold compact row (%s)', key => {
        const session = createSessionFixture({ id: 'cold-custody', serverId: 'server-a', active: true,
            presence: 'online', agentState: pendingAgentState('permission'),
            metadata: { path: '/voice', host: 'host', systemSessionV1: { v: 1, key, hidden: true } } });
        const source = createSource({ sessions: [session] });
        const overview = buildActivityOverviewFromSource({ source: { ...source, sessionsById: {} }, nowMs: 1_000,
            directActionsEnabled: true });
        expect(overview.counts.permissionRequired).toBe(key === 'other-hidden-service' ? 0 : 1);
    },
);

it('drops stale full Voice custody after a metadata-only compact key change', () => {
    const session = createSessionFixture({ id: 'stale-custody', serverId: 'server-a', active: true,
        metadataVersion: 1, presence: 'online', agentState: pendingAgentState('permission'),
        metadata: { path: '/voice', host: 'host', systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } });
    const source = createSource({ sessions: [session] });
    const next = buildSessionListRenderableFromSession({ ...session, metadataVersion: 2,
        metadata: { ...session.metadata!, systemSessionV1: { v: 1, key: 'other-hidden-service', hidden: true } } },
        source.sessionListRowsByServerId?.['server-a']?.[session.id]);
    const overview = buildActivityOverviewFromSource({ source: { ...source,
        sessionListRowsByServerId: { 'server-a': { [session.id]: next } } }, nowMs: 1_000, directActionsEnabled: true });
    expect(overview.counts.permissionRequired).toBe(0);
});

it('carries the real owner display custody fact into a cold layout-1 Activity row and clears it on a key change', () => {
    const session = { ...createSessionFixture({ id: 'owner-display-custody', serverId: 'server-a', active: true,
        metadataLayoutVersion: 1, metadataVersion: 1, metadata: null, ownerMetadataView: null,
        access: createSessionAccessFixture('owner'), pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0 }),
        metadataUndecided: true as const };
    const source = createSource({ sessions: [session] });
    const display = (key: string) => projectSessionDisplayV1({ sharedMetadata: { v: 1 },
        ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1,
            workspace: { path: '/voice', host: 'host' }, system: { systemSessionV1: { v: 1, key, hidden: true } } }) });
    const voice = buildSessionListRenderableFromSession(session, undefined, undefined, undefined, display('voice_conversation_retired'));
    const rowSource = (row: typeof voice) => ({ ...source, sessionsById: {},
        sessionListRowsByServerId: { 'server-a': { [session.id]: row } } });
    const overview = (row: typeof voice) => buildActivityOverviewFromSource({ source: rowSource(row), nowMs: 1_000, directActionsEnabled: true });
    const summary = (row: typeof voice) => buildActivityOverviewSummaryFromSource({ source: rowSource(row), nowMs: 1_000 });
    expect(voice.metadata?.systemSessionKind).toBe('voice_custody');
    expect(overview(voice).counts.permissionRequired).toBe(1);
    expect(summary(voice).needsYouCount).toBe(1);
    const other = buildSessionListRenderableFromSession({ ...session, metadataVersion: 2 }, voice,
        undefined, undefined, display('other-hidden-service'));
    expect(other.metadata?.systemSessionKind).toBeUndefined();
    expect(overview(other).counts.permissionRequired).toBe(0);
    expect(summary(other).needsYouCount).toBe(0);
});

function createSource(params: Readonly<{
    sessions: ReadonlyArray<ReturnType<typeof createSessionFixture>>;
    isDataReady?: boolean;
    workspaceRefsV1?: ActivityAttentionSource['workspaceRefsV1'];
    workspacePathDisplayModeV1?: ActivityAttentionSource['workspacePathDisplayModeV1'];
    sessionListHomeObservationByServerId?: ActivityAttentionSource['sessionListHomeObservationByServerId'];
}>): ActivityAttentionSource {
    const sessionsByServerId = {
        'server-a': params.sessions.filter((session) => session.serverId !== 'server-b'),
        'server-b': params.sessions.filter((session) => session.serverId === 'server-b'),
    };
    return {
        isDataReady: params.isDataReady ?? true,
        sessionsById: Object.fromEntries(params.sessions.map((session) => [session.id, session])),
        sessionListRowsByServerId: Object.fromEntries(Object.entries(sessionsByServerId).map(([serverId, sessions]) => [
            serverId,
            Object.fromEntries(sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)])),
        ])),
        ordinarySessionListMembershipByServerId: Object.fromEntries(Object.entries(sessionsByServerId).map(([serverId, sessions]) => [
            serverId,
            sessions.map((session) => session.id),
        ])),
        sessionListIndexByServerId: {
            'server-a': params.sessions.filter((session) => session.serverId !== 'server-b').map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-a',
                serverName: 'Server A',
            })),
            'server-b': params.sessions.filter((session) => session.serverId === 'server-b').map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-b',
                serverName: 'Server B',
            })),
        },
        concurrentSessionListCacheByServerId: {},
        ...(params.sessionListHomeObservationByServerId
            ? { sessionListHomeObservationByServerId: params.sessionListHomeObservationByServerId }
            : {}),
        workspaceRefsV1: params.workspaceRefsV1 ?? [],
        workspacePathDisplayModeV1: params.workspacePathDisplayModeV1 ?? 'name',
        serverProfilesById: {
            'server-a': {
                id: 'server-a',
                name: 'Saved A',
                serverUrl: 'https://a.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
        },
        activeServer: {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
    };
}

function withPersonalMembership(
    source: ActivityAttentionSource,
    membershipByServerId: Readonly<Record<string, readonly string[]>>,
    statesByServerId?: Readonly<Record<string, SessionListQueryHomeState | undefined>>,
): ActivityAttentionSource {
    return {
        ...source,
        personalSessionListMembershipByServerId: membershipByServerId,
        ...(statesByServerId ? { personalSessionListQueryStatesByServerId: statesByServerId } : {}),
    } as ActivityAttentionSource;
}

function personalQueryState(
    serverId: string,
    overrides: Partial<SessionListQueryHomeState> = {},
): SessionListQueryHomeState {
    const queryKey = buildSessionListQueryKey(serverId, ACTIVITY_PERSONAL_SESSION_QUERY);
    return {
        requestedQueryKey: queryKey,
        appliedQueryKey: queryKey,
        addresses: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: null,
        attentionHasNext: false,
        phase: 'ready',
        freshnessAt: 1,
        homeObservation: { phase: overrides.phase ?? 'ready', lastSuccessAt: overrides.freshnessAt === undefined ? 1 : overrides.freshnessAt },
        failureReason: null,
        failureCode: null,
        appliedSourceKind: 'query',
        ...overrides,
    };
}

describe('buildActivityOverviewFromSource', () => {
    it('reads the authorized rule query corpus without making it authoritative personal membership', () => {
        const session = createSessionFixture({ id: 'rule-query-source', serverId: 'server-a', updatedAt: 950,
            access: createSessionAccessFixture('edit'), viewer: createSessionViewerFixture(),
            agentState: pendingAgentState('user_action') });
        const source: ActivityAttentionSource = { ...createSource({ sessions: [session] }), sessionsById: {},
            ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {},
            personalSessionListMembershipByServerId: { 'server-a': [] },
            personalSessionListQueryStatesByServerId: { 'server-a': personalQueryState('server-a') },
            ruleSessionMembershipByServerId: { 'server-a': [session.id] },
            personalFollowRulesByServerId: { 'server-a': { status: 'ready', accountId: 'alice', rules: [{
                ruleId: 'all-accessible', receiver: { kind: 'account' }, version: 1,
                definition: { v: 1, enabled: true, policy: { preset: 'important' },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server-a'],
                        startedBy: ['you', 'triggers', 'agents'] }) },
            }] } },
        };
        expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, session, 1_000))
            .toEqual([{ preset: 'important' }]);
        expect(buildActivityOverviewFromSource({ source, nowMs: 1_000 }).candidates.map(candidate => candidate.sessionId))
            .toEqual([session.id]);
        expect(source.personalSessionListMembershipByServerId).toEqual({ 'server-a': [] });
        const unavailable = { ...source, personalFollowRulesByServerId: { 'server-a': { status: 'unavailable' as const, reason: 'scope-retired' } } };
        expect(buildActivityOverviewFromSource({ source: unavailable, nowMs: 1_000 }).candidates).toEqual([]);
    });

    it('represents a rule-only foreign source update in Inbox without an explicit Follow or prior read cursor', () => {
        const viewer = createSessionViewerFixture({
            readState: projectViewerReadStateV1({ tracked: false, row: null, visibleSessionSeq: 2 }),
            // Home projects each exact rule's inception boundary without writing a viewer cursor.
            ruleReadStates: [{ ruleId: 'all-accessible', ruleVersion: 1,
                readState: projectViewerReadStateV1({ tracked: true,
                    row: { lastViewedSessionSeq: 1, unreadSince: 950 }, visibleSessionSeq: 2 }) },
                // A different older rule must not move the matching rule's boundary backwards.
                { ruleId: 'unrelated-old-rule', ruleVersion: 1,
                    readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 } }],
            relevance: { relevant: true, reasons: ['shared_directly_with_me'] },
        });
        const session = createSessionFixture({ id: 'foreign-update', serverId: 'server-a', ownerAccountId: 'bob',
            seq: 2, updatedAt: 950, lastTurnCompletedAt: 950, latestTurnStatus: 'completed', latestReadyEventSeq: 2,
            access: createSessionAccessFixture('edit'), viewer });
        const inbox = (value: typeof session, enabled = true, version = 1) => {
            const source = { ...createSource({ sessions: [value] }), sessionsById: {},
                personalFollowRulesByServerId: { 'server-a': { status: 'ready' as const, accountId: 'alice', rules: [{
                    ruleId: 'all-accessible', receiver: { kind: 'account' as const }, version,
                    definition: { v: 1 as const, enabled, policy: { preset: 'everything' as const },
                        filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server-a'],
                            startedBy: ['you', 'triggers', 'agents'] }) },
                }] } },
            };
            expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, value, 1_000))
                .toEqual(enabled ? [{ preset: 'everything' }] : []);
            return buildInboxSessionPresentation({ overview: buildActivityOverviewFromSource({ source, nowMs: 1_000 }) });
        };
        // A real retained private cursor is the discriminating neighbor. The rule and source facts are identical.
        const retained = { ...session, viewer: { ...viewer, readState: projectViewerReadStateV1({ tracked: true,
            row: { lastViewedSessionSeq: 1, unreadSince: 950 }, visibleSessionSeq: 2 }) } };
        expect(inbox(retained).readySessions.map(candidate => candidate.sessionId)).toEqual([session.id]);
        expect(inbox(session).readySessions.map(candidate => candidate.sessionId)).toEqual([session.id]);
        expect(inbox({ ...session, seq: 1, latestReadyEventSeq: 1 }).readySessions).toEqual([]);
        expect(inbox({ ...session, seq: 1, latestReadyEventSeq: 1, viewer: { ...viewer,
            readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 } } }).readySessions).toEqual([]);
        expect(inbox(session, false).readySessions).toEqual([]);
        expect(inbox(session, true, 2).readySessions).toEqual([]);
        const caughtUp = projectViewerReadStateV1({ tracked: true,
            row: { lastViewedSessionSeq: 2, unreadSince: null }, visibleSessionSeq: 2 });
        expect(inbox({ ...session, viewer: { ...viewer, readState: caughtUp,
            ruleReadStates: [{ ruleId: 'all-accessible', ruleVersion: 1, readState: caughtUp }] } }).readySessions).toEqual([]);
    });

    it('shows known receiver-rule pending state only in its owning Account and Home, then clears it after evaluation', () => {
        const session = createSessionFixture({ id: 'pending-source', serverId: 'server-a', updatedAt: 950 });
        const source: ActivityAttentionSource = { ...createSource({ sessions: [session] }),
            audienceScopes: new Map([['server-a', { serverId: 'server-a', accountId: 'alice' }]]),
            receiverRuleEvaluationByServerId: { 'server-a': { accountId: 'alice',
                pendingBySourceSessionId: { [session.id]: 'waiting_for_authorized_device' } } },
        };
        const project = (value: ActivityAttentionSource) => buildActivityOverviewFromSource({ source: value, nowMs: 1_000 }).candidates[0]!;
        const waiting = project(source);
        expect(waiting.followRuleEvaluationState).toBe('waiting_for_authorized_device');
        expect(buildInboxSessionContextLine(waiting)).toContain(sessionFollowSourceRuntimeStateLabel('waiting_for_authorized_device'));
        const authorized = project({ ...source, receiverRuleEvaluationByServerId: { 'server-a': { accountId: 'alice',
            pendingBySourceSessionId: { [session.id]: 'catch_up_pending' } } } });
        expect(authorized.followRuleEvaluationState).toBe('catch_up_pending');
        expect(buildInboxSessionContextLine(authorized)).toContain(sessionFollowSourceRuntimeStateLabel('catch_up_pending'));
        const excludedSources: readonly ActivityAttentionSource[] = [
            { ...source, audienceScopes: new Map([['server-a', { serverId: 'server-a', accountId: 'bob' }]]) },
            { ...source, audienceScopes: new Map([['server-a', { serverId: 'server-b', accountId: 'alice' }]]) },
            { ...source, audienceScopes: undefined },
            { ...source, receiverRuleEvaluationByServerId: { 'server-b': source.receiverRuleEvaluationByServerId!['server-a']! } },
            { ...source, receiverRuleEvaluationByServerId: { 'server-a': { accountId: 'alice', pendingBySourceSessionId: {} } } },
        ];
        for (const value of excludedSources) expect(project(value).followRuleEvaluationState).toBeUndefined();
        expect(project(source).hasAttention).toBe(project({ ...source, receiverRuleEvaluationByServerId: undefined }).hasAttention);
    });

    it('evaluates personal relationship defaults without enrolling a Follow or guessing unknown relationships', () => {
        const base = createSessionFixture({ id: 'default-only', serverId: 'server-a', active: true, activeAt: 950, updatedAt: 950,
            access: createSessionAccessFixture('edit'), agentState: pendingAgentState('user_action') });
        const preferences = { assigned: false, direct: false, team: true, group: false };
        const session = { ...base, viewer: createSessionViewerFixture({ follow: { follows: false, notificationLevel: null,
            defaultRelationships: { assigned: false, direct: false, team: true, group: false } } }) };
        const source = { ...createSource({ sessions: [session] }), personalFollowRulesByServerId: {
            'server-a': { status: 'ready' as const, accountId: 'alice', rules: [], defaultPreferences: preferences },
        } };
        expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, session, 1_000))
            .toEqual([{ preset: 'important' }]);
        const personal = withPersonalMembership(source, { 'server-a': [] }, { 'server-a': personalQueryState('server-a') });
        expect(buildActivityOverviewSummaryFromSource({ source: personal, nowMs: 1_000 }).needsYouCount).toBe(1);
        for (const follow of [{ follows: false, notificationLevel: null },
            { follows: false, notificationLevel: 'none', defaultRelationships: session.viewer.follow.defaultRelationships }] as const) {
            const unavailable = { ...session, viewer: createSessionViewerFixture({ follow }) };
            expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, unavailable, 1_000)).toEqual([]);
        }
        const quiet = { ...session, viewer: createSessionViewerFixture({ follow: {
            ...projectSessionFollowFactsV1({ following: true, notificationLevel: 'none', hasPersistentFollow: true,
                followPolicy: JSON.stringify({ preset: 'quiet' }) }), defaultRelationships: session.viewer.follow.defaultRelationships,
        } }) };
        expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, quiet, 1_000)).toEqual([]);
    });
    it('matches only explicit loaded tag assignments and refreshes after a tag-only edit', () => {
        const session = createSessionFixture({ id: 'tagged', serverId: 'server-a', active: true, activeAt: 950, updatedAt: 950,
            access: createSessionAccessFixture('edit'), viewer: createSessionViewerFixture(), agentState: pendingAgentState('user_action') });
        const source = { ...createSource({ sessions: [session] }), personalFollowRulesByServerId: {
            'server-a': { status: 'ready' as const, accountId: 'alice', rules: [{
                ruleId: 'tagged', receiver: { kind: 'account' as const }, version: 0,
                definition: { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server-a'],
                        startedBy: ['you', 'triggers', 'agents'], tagIds: [{ serverId: 'server-a', tagId: 'urgent' }] }) },
            }] },
        } };
        const key = buildSessionOrganizationSessionKey('server-a', session.id);
        const tagged = { ...source, followRuleTagAssignmentsBySessionKey: { [key]: { sessionId: session.id, tagIds: ['urgent'] } } };
        expect(buildActivityOverviewSummaryFromSource({ source: tagged, nowMs: 1_000 }).needsYouCount).toBe(1);
        for (const assignments of [{}, { [key]: { sessionId: session.id, tagIds: [] } }]) {
            expect(buildActivityOverviewSummaryFromSource({ source: { ...tagged, followRuleTagAssignmentsBySessionKey: assignments }, nowMs: 1_000 }).needsYouCount).toBe(0);
        }
    });
    it('refuses stored list-only attention in an Activity rule even when UI attention is known', () => {
        const session = createSessionFixture({ id: 'unsupported', serverId: 'server-a', ownerAccountId: 'alice', origin: { kind: 'none' },
            viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['user_action_required'],
                primary: 'user_action_required', presentation: 'full' } }) });
        const source = { ...createSource({ sessions: [session] }), personalFollowRulesByServerId: {
            'server-a': { status: 'ready' as const, accountId: 'alice', rules: [{
                ruleId: 'attention', receiver: { kind: 'account' as const }, version: 0,
                definition: { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server-a'],
                        startedBy: ['you', 'triggers', 'agents'], attention: 'needs_my_attention' }) },
            }] },
        } };
        expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, session, 1_000)).toEqual([]);
    });
    it('evaluates an exclusion-only status rule with the canonical current Session status', () => {
        const session = createSessionFixture({ id: 'status-exclusion', serverId: 'server-a', ownerAccountId: 'alice',
            origin: { kind: 'none' }, viewer: createSessionViewerFixture() });
        const source = { ...createSource({ sessions: [session] }), personalFollowRulesByServerId: {
            'server-a': { status: 'ready' as const, accountId: 'alice', rules: [{
                ruleId: 'status', receiver: { kind: 'account' as const }, version: 0,
                definition: { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server-a'],
                        startedBy: ['you', 'triggers', 'agents'], excludedStatuses: ['thinking'] }) },
            }] },
        } };
        expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, session, 1_000))
            .toEqual([{ preset: 'important' }]);
    });
    it('uses protected participation reasons for an involving-me rule without treating a mention or Follow as participation', () => {
        const session = createSessionFixture({ id: 'participant', serverId: 'server-a', active: true, activeAt: 950, updatedAt: 950,
            access: createSessionAccessFixture('edit'), agentState: pendingAgentState('user_action') });
        const rule = { ruleId: 'involving', receiver: { kind: 'account' as const }, version: 0,
            definition: { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
                filter: normalizeSessionListFilterV1({ scope: 'involving_me', homeServerIds: ['server-a'],
                    startedBy: ['you', 'triggers', 'agents'] }) } };
        for (const reason of ['owned_by_me', 'responsible_for_me', 'shared_directly_with_me', 'authored_by_me',
            'mentioned_in_discussion', 'followed_by_me', 'pinned_by_me'] as const) {
            const row = { ...session, viewer: createSessionViewerFixture({ relevance: { relevant: true, reasons: [reason] } }) };
            const source = { ...createSource({ sessions: [row] }), personalFollowRulesByServerId: {
                'server-a': { status: 'ready' as const, accountId: 'alice', rules: [rule] },
            } };
            const participates = ['owned_by_me', 'responsible_for_me', 'shared_directly_with_me', 'authored_by_me'].includes(reason);
            expect(buildActivityOverviewSummaryFromSource({ source, nowMs: 1_000 }).needsYouCount).toBe(participates ? 1 : 0);
        }
    });
    it('shares a live rule-only request between Inbox and badge despite complete personal membership', () => {
        const session = createSessionFixture({ id: 'rule-only', serverId: 'server-a', active: true, activeAt: 950, updatedAt: 950,
            projectKey: 'payments',
            access: createSessionAccessFixture('edit'), viewer: createSessionViewerFixture(),
            metadata: { ...createSessionFixture().metadata, path: '/Users/tester/project', host: 'tester.local', projectId: 'payments' },
            agentState: pendingAgentState('user_action'),
        });
        const source = { ...withPersonalMembership(createSource({ sessions: [session] }),
            { 'server-a': [] }, { 'server-a': personalQueryState('server-a') }),
            personalFollowRulesByServerId: { 'server-a': { status: 'ready' as const, rules: [{
                ruleId: 'payments', receiver: { kind: 'account' as const }, version: 1,
                definition: { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
                    filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: ['server-a'],
                        startedBy: ['you', 'triggers', 'agents'], projects: { include: [{ serverId: 'server-a', projectKey: 'payments' }], exclude: [] } }), },
            }] } },
        };
        expect(readActivitySessionRulePolicies(source, { serverId: 'server-a', sessionId: session.id }, session, 1_000))
            .toEqual([{ preset: 'important' }]);
        const overview = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        expect(overview.candidates.map(candidate => candidate.sessionId)).toEqual(['rule-only']);
        expect(overview.candidates[0]?.reasons.hasPendingUserActionRequests).toBe(true);
        expect(buildActivityOverviewSummaryFromSource({ source, nowMs: 1_000 }))
            .toMatchObject({ inboxContentCount: 1, totalAttentionCount: 1, needsYouCount: 1 });
        for (const unavailable of [
            { ...session, encryptedContentAvailability: 'encrypted_content_unavailable' as const },
            { ...session, projectKey: 'design', metadata: { ...session.metadata, path: '/Users/tester/project', host: 'tester.local', projectId: 'design' } },
            { ...session, viewer: createSessionViewerFixture({ follow: { follows: false, notificationLevel: 'none' } }) },
        ]) {
            const excluded = { ...source, sessionsById: { [session.id]: unavailable }, sessionListRowsByServerId: {} };
            expect(buildActivityOverviewFromSource({ source: excluded, nowMs: 1_000 }).candidates).toEqual([]);
            expect(buildActivityOverviewSummaryFromSource({ source: excluded, nowMs: 1_000 }).inboxContentCount).toBe(0);
        }
        const explicit = { ...session, viewer: createSessionViewerFixture({
            follow: { follows: true, notificationLevel: 'important' },
            attention: { needsAttention: true, reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' },
        }) };
        const explicitAndRule = { ...source, sessionsById: { [session.id]: explicit } };
        expect(buildActivityOverviewFromSource({ source: explicitAndRule, nowMs: 1_000 }).candidates).toHaveLength(1);
        expect(buildActivityOverviewSummaryFromSource({ source: explicitAndRule, nowMs: 1_000 }).inboxContentCount).toBe(1);
        const cleared = { ...source, sessionsById: { [session.id]: { ...session, agentState: null, agentStateVersion: 2 } }, sessionListRowsByServerId: {} };
        expect(buildActivityOverviewSummaryFromSource({ source: cleared, nowMs: 1_000 }).inboxContentCount).toBe(0);
    });
    it('names a Home through its display-name owner instead of the saved relay host', () => {
        const source = createSource({ sessions: [createSessionFixture({ id: 'permission', serverId: 'server-a',
            agentState: pendingAgentState('permission') })] });
        const profile = source.serverProfilesById?.['server-a'];
        if (!profile) throw new Error('missing fixture Home');
        const rawHost = 'happier-agent-qa-orc.localhost:3017';
        const overview = buildActivityOverviewFromSource({ source: { ...source,
            serverProfilesById: { 'server-a': { ...profile, name: rawHost, serverUrl: `http://${rawHost}` } },
        }, nowMs: 1_000 });
        const home = overview.candidates[0]?.context?.segments.find(segment => segment.kind === 'home');
        expect(home?.label).toBe('This Home');
        expect(overview.candidates[0]?.context?.contextLine).not.toContain(rawHost);
    });
    it.each([
        { privacyMode: 'status_only', candidatePrivacyMode: undefined, showsWorkspace: false },
        { privacyMode: 'title_only', candidatePrivacyMode: undefined, showsWorkspace: false },
        { privacyMode: 'include_preview', candidatePrivacyMode: undefined, showsWorkspace: true },
        { privacyMode: 'include_preview', candidatePrivacyMode: 'title_only', showsWorkspace: false },
    ] as const)('applies $privacyMode / $candidatePrivacyMode workspace privacy to native payloads from real source context', ({
        privacyMode, candidatePrivacyMode, showsWorkspace,
    }) => {
        const session = createSessionFixture({
            id: 'workspace-privacy',
            serverId: 'server-a',
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            agentState: pendingAgentState('permission'),
            metadata: {
                path: '/Users/tester/PRIVATE-WORKSPACE-SENTINEL',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Permission work', updatedAt: 3 },
            },
        });
        const overview = buildActivityOverviewFromSource({
            source: createSource({ sessions: [session] }),
            nowMs: 1_000,
        });
        const candidate = overview.candidates[0]!;
        expect(candidate.context?.workspace?.label).toContain('PRIVATE-WORKSPACE-SENTINEL');
        const homeLabel = candidate.context?.segments.find((segment) => segment.kind === 'home')?.label;
        expect(homeLabel).toBeTruthy();

        const snapshots = buildLiveActivitySnapshots({
            sessions: [session],
            overview,
            policy: resolveActivitySurfacePolicy({ activitySurfacePrivacyMode: privacyMode }),
            resolveCandidatePrivacyMode: () => candidatePrivacyMode,
            nowMs: 1_000,
        });

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.subtitle).toContain(homeLabel);
        expect(JSON.stringify(snapshots).includes('PRIVATE-WORKSPACE-SENTINEL')).toBe(showsWorkspace);
    });

    it('builds the mounted summary from an equal-version list projection without reading hydrated messages', () => {
        const session = createSessionFixture({
            id: 'summary-list-projection',
            serverId: 'server-a',
            seq: 4,
            agentStateVersion: 7,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            presence: 0,
            activeAt: 0,
        });
        const renderable = buildSessionListRenderableFromSession(session);
        const source = createSource({ sessions: [session] });
        const guardedMessages = new Proxy({}, {
            get() {
                throw new Error('summary read hydrated message detail for a projected list member');
            },
        });

        expect(buildActivityOverviewSummaryFromSource({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-a': { [session.id]: renderable },
                },
                sessionMessagesById: guardedMessages,
            },
            nowMs: 1_000,
        })).toEqual({
            isDataReady: true,
            totalAttentionCount: 1,
            inboxContentCount: 1,
            nextAttentionBoundaryMs: null,
            workingCount: 0,
            needsYouCount: 0,
        });
    });

    it.each([false, true])('keeps exact-Home exclusion and unread policy in summary counts (unread %s)', (showUnread) => {
        const sessions = ['server-a', 'server-b'].map(serverId => createSessionFixture({
            id: `unread-${serverId}`, serverId, seq: 4, latestReadyEventSeq: 4, lastViewedSessionSeq: 1,
        }));
        const input = {
            source: createSource({ sessions }), nowMs: 1_000,
            resolveSessionOptionsForServerId: (serverId: string) => serverId === 'server-a' ? null : { showUnread },
        };
        const detail = buildActivityOverviewFromSource(input);
        const summary = buildActivityOverviewSummaryFromSource(input);

        expect(detail.candidates.map(candidate => candidate.serverId)).toEqual(['server-b']);
        expect(summary.totalAttentionCount).toBe(showUnread ? 1 : 0);
        expect(summary.totalAttentionCount).toBe(detail.counts.totalAttention);
    });

    it('keeps equal-version unread-only summary state out of Inbox when no ready evidence exists', () => {
        const session = createSessionFixture({
            id: 'summary-unread-without-ready',
            serverId: 'server-a',
            seq: 4,
            agentStateVersion: 7,
            latestReadyEventSeq: null,
            latestTurnStatus: null,
            lastViewedSessionSeq: 1,
            active: false,
            thinking: false,
            presence: 0,
            activeAt: 0,
        });
        const source = createSource({ sessions: [session] });
        const unreadRenderable = {
            ...source.sessionListRowsByServerId?.['server-a']?.[session.id]!,
            hasUnreadMessages: true,
        };

        expect(buildActivityOverviewSummaryFromSource({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-a': { [session.id]: unreadRenderable },
                },
            },
            nowMs: 1_000,
        })).toEqual({
            isDataReady: true,
            totalAttentionCount: 0,
            inboxContentCount: 0,
            nextAttentionBoundaryMs: null,
            workingCount: 0,
            needsYouCount: 0,
        });
    });

    it('enumerates only canonical ordinary membership and excludes query-only rows', () => {
        const ordinary = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'ordinary',
            seq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
        }));
        const queryOnlySession = createSessionFixture({
            id: 'query-only',
            seq: 5,
            lastViewedSessionSeq: 1,
            updatedAt: 50,
        });
        const queryOnly = buildSessionListRenderableFromSession(queryOnlySession);
        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: { 'query-only': queryOnlySession },
                sessionListIndexByServerId: {
                    'server-a': [{
                        type: 'session',
                        sessionId: 'query-only',
                        serverId: 'server-a',
                        serverName: 'Server A',
                    }],
                },
                sessionListRowsByServerId: {
                    'server-a': { ordinary, 'query-only': queryOnly },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-a': ['ordinary'],
                },
            },
            nowMs: 1_000,
        });

        expect(overview.candidates.map((candidate) => candidate.address)).toEqual([
            { serverId: 'server-a', sessionId: 'ordinary' },
        ]);
    });

    it('admits followed and assigned Team-only rows from the canonical personal query without ordinary membership', () => {
        const followed = Object.assign(createSessionFixture({
            id: 'team-followed',
            serverId: 'server-a',
            active: true,
            seq: 4,
            lastViewedSessionSeq: 4,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: null },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important' },
            notification: { level: 'important', source: 'preference' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        } } as const);
        const assigned = Object.assign(createSessionFixture({
            id: 'team-assigned',
            serverId: 'server-a',
            active: true,
            seq: 7,
            lastViewedSessionSeq: 0,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' },
            relevance: { relevant: true, reasons: ['responsible_for_me'] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'assignment' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        } } as const);
        const source = createSource({ sessions: [] });
        const overview = buildActivityOverviewFromSource({
            source: withPersonalMembership({
                ...source,
                sessionsById: {},
                sessionListRowsByServerId: {
                    'server-a': {
                        [followed.id]: buildSessionListRenderableFromSession(followed),
                        [assigned.id]: buildSessionListRenderableFromSession(assigned),
                    },
                },
                ordinarySessionListMembershipByServerId: { 'server-a': [] },
                sessionListIndexByServerId: { 'server-a': [] },
            }, { 'server-a': [followed.id, assigned.id] }),
            nowMs: 1_000,
        });

        expect(overview.candidates.map((candidate) => candidate.address)).toEqual([
            { serverId: 'server-a', sessionId: 'team-assigned' },
            { serverId: 'server-a', sessionId: 'team-followed' },
        ]);
        expect(overview.candidates.find((candidate) => candidate.sessionId === assigned.id)).toMatchObject({
            hasAttention: false,
        });
    });

    it('removes unfollowed or revoked collective rows when personal query membership disappears', () => {
        const followed = Object.assign(createSessionFixture({
            id: 'collective-followed',
            serverId: 'server-a',
            active: true,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important' },
            notification: { level: 'important', source: 'preference' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        } } as const);
        const retainedRow = buildSessionListRenderableFromSession(followed);
        const retainedSource: ActivityAttentionSource = {
            ...createSource({ sessions: [] }),
            sessionsById: {},
            sessionListRowsByServerId: { 'server-a': { [followed.id]: retainedRow } },
            ordinarySessionListMembershipByServerId: { 'server-a': [] },
            sessionListIndexByServerId: { 'server-a': [] },
        };

        expect(buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedSource, { 'server-a': [followed.id] }),
            nowMs: 1_000,
        }).candidates).toHaveLength(1);
        expect(buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedSource, { 'server-a': [] }),
            nowMs: 1_000,
        }).candidates).toHaveLength(0);
    });

    it('clears only an exact Home after a complete empty snapshot while incomplete Homes retain stale truth', () => {
        const tracked = (id: string, serverId: string) => Object.assign(createSessionFixture({
            id,
            serverId,
            active: true,
            seq: 4,
            lastViewedSessionSeq: 1,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 2 },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important' },
            notification: { level: 'important', source: 'preference' },
            attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
        } } as const);
        const sessionA = tracked('tracked-a', 'server-a');
        const sessionB = tracked('tracked-b', 'server-b');
        const retainedRows = createSource({ sessions: [sessionA, sessionB] });

        const bothCurrent = buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedRows, {
                'server-a': [sessionA.id],
                'server-b': [sessionB.id],
            }, {
                'server-a': personalQueryState('server-a', {
                    addresses: [{ serverId: 'server-a', sessionId: sessionA.id }],
                }),
                'server-b': personalQueryState('server-b', {
                    addresses: [{ serverId: 'server-b', sessionId: sessionB.id }],
                }),
            }),
            nowMs: 1_000,
        });
        expect(bothCurrent.candidates.map((candidate) => candidate.sessionId).sort())
            .toEqual([sessionA.id, sessionB.id]);

        const offlineB = buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedRows, {
                'server-a': [sessionA.id],
                'server-b': [sessionB.id],
            }, {
                'server-a': personalQueryState('server-a', {
                    addresses: [{ serverId: 'server-a', sessionId: sessionA.id }],
                }),
                'server-b': personalQueryState('server-b', {
                    phase: 'offline',
                    addresses: [{ serverId: 'server-b', sessionId: sessionB.id }],
                }),
            }),
            nowMs: 1_000,
        });
        expect(offlineB.candidates.map((candidate) => candidate.sessionId).sort())
            .toEqual([sessionA.id, sessionB.id]);

        const partialB = buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedRows, {
                'server-a': [sessionA.id],
                'server-b': [sessionB.id],
            }, {
                'server-a': personalQueryState('server-a', {
                    addresses: [{ serverId: 'server-a', sessionId: sessionA.id }],
                }),
                'server-b': personalQueryState('server-b', {
                    addresses: [{ serverId: 'server-b', sessionId: sessionB.id }],
                    hasNext: true,
                    nextCursor: 'more-b',
                }),
            }),
            nowMs: 1_000,
        });
        expect(partialB.candidates.map((candidate) => candidate.sessionId).sort())
            .toEqual([sessionA.id, sessionB.id]);

        const failedB = buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedRows, {
                'server-a': [sessionA.id],
                'server-b': [sessionB.id],
            }, {
                'server-a': personalQueryState('server-a', {
                    addresses: [{ serverId: 'server-a', sessionId: sessionA.id }],
                }),
                'server-b': personalQueryState('server-b', {
                    phase: 'error',
                    addresses: [{ serverId: 'server-b', sessionId: sessionB.id }],
                    failureReason: 'network',
                    failureCode: 'network_error',
                }),
            }),
            nowMs: 1_000,
        });
        expect(failedB.candidates.map((candidate) => candidate.sessionId).sort())
            .toEqual([sessionA.id, sessionB.id]);

        const unsupportedB = buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedRows, {
                'server-a': [sessionA.id],
                'server-b': [],
            }, {
                'server-a': personalQueryState('server-a', {
                    addresses: [{ serverId: 'server-a', sessionId: sessionA.id }],
                }),
                'server-b': personalQueryState('server-b', {
                    phase: 'error',
                    failureReason: 'unsupported',
                    failureCode: 'filtered_session_listing_unavailable',
                }),
            }),
            nowMs: 1_000,
        });
        expect(unsupportedB.candidates.map((candidate) => candidate.sessionId).sort())
            .toEqual([sessionA.id, sessionB.id]);

        const reconnectedEmptyB = buildActivityOverviewFromSource({
            source: withPersonalMembership(retainedRows, {
                'server-a': [sessionA.id],
                'server-b': [],
            }, {
                'server-a': personalQueryState('server-a', {
                    addresses: [{ serverId: 'server-a', sessionId: sessionA.id }],
                }),
                'server-b': personalQueryState('server-b'),
            }),
            nowMs: 1_000,
        });
        expect(reconnectedEmptyB.candidates.map((candidate) => candidate.sessionId))
            .toEqual([sessionA.id]);
    });

    it('does not admit an archived collective row retained by stale personal-query membership', () => {
        const archived = Object.assign(createSessionFixture({
            id: 'collective-archived',
            serverId: 'server-a',
            active: false,
            archivedAt: 900,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important' },
            notification: { level: 'important', source: 'preference' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        } } as const);
        const source: ActivityAttentionSource = {
            ...createSource({ sessions: [] }),
            sessionsById: {},
            sessionListRowsByServerId: {
                'server-a': { [archived.id]: buildSessionListRenderableFromSession(archived) },
            },
            ordinarySessionListMembershipByServerId: { 'server-a': [] },
            sessionListIndexByServerId: { 'server-a': [] },
        };

        expect(buildActivityOverviewFromSource({
            source: withPersonalMembership(source, { 'server-a': [archived.id] }),
            nowMs: 1_000,
        }).candidates).toEqual([]);
    });

    it('keeps personal-query membership qualified by exact Home for colliding Session IDs', () => {
        const sharedId = 'collective-collision';
        const rowA = buildSessionListRenderableFromSession(createSessionFixture({
            id: sharedId,
            serverId: 'server-a',
            seq: 3,
            lastViewedSessionSeq: 1,
        }));
        const rowB = buildSessionListRenderableFromSession(createSessionFixture({
            id: sharedId,
            serverId: 'server-b',
            seq: 9,
            lastViewedSessionSeq: 2,
        }));
        const source: ActivityAttentionSource = {
            ...createSource({ sessions: [] }),
            sessionsById: {},
            sessionListRowsByServerId: {
                'server-a': { [sharedId]: rowA },
                'server-b': { [sharedId]: rowB },
            },
            ordinarySessionListMembershipByServerId: { 'server-a': [], 'server-b': [] },
            sessionListIndexByServerId: { 'server-a': [], 'server-b': [] },
        };

        const overview = buildActivityOverviewFromSource({
            source: withPersonalMembership(source, {
                'server-a': [sharedId],
                'server-b': [sharedId],
            }),
            nowMs: 1_000,
        });

        expect(overview.candidates.flatMap((candidate) => candidate.address ? [candidate.address] : [])
            .sort((left, right) => left.serverId.localeCompare(right.serverId))).toEqual([
            { serverId: 'server-a', sessionId: sharedId },
            { serverId: 'server-b', sessionId: sharedId },
        ]);
    });

    it('keeps locked viewer attention status-only without exposing retained metadata', () => {
        const session = createSessionFixture({
            id: 'locked',
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            metadata: { path: '/private/location', host: 'private-host', name: 'Secret title' },
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 1 },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'status_only' },
            },
        });
        const overview = buildActivityOverviewFromSource({ source: createSource({ sessions: [session] }), nowMs: 1_000 });
        expect(overview.candidates).toHaveLength(1);
        expect(overview.counts.unread).toBe(1);
        expect(overview.candidates[0]?.title).not.toContain('Secret');
        expect(overview.candidates[0]?.subtitle).toBe('');
        expect(overview.candidates[0]?.context?.mayShowDecryptedContent).toBe(false);
        expect(overview.candidates[0]?.context?.contextLine).not.toContain('private/location');
        expect(overview.candidates[0]?.context?.workspace).toBeNull();
    });

    it('does not admit accessible Team history into Activity candidates', () => {
        const sessions = Array.from({ length: 300 }, (_, index) => Object.assign(createSessionFixture({
            id: `team-${index}`, seq: 50, lastViewedSessionSeq: 0,
            active: true, presence: 'online', thinking: true, thinkingAt: 990,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' },
            relevance: { relevant: false, reasons: [] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'none', source: 'none' },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        } } as const));
        const overview = buildActivityOverviewFromSource({ source: createSource({ sessions }), nowMs: 1_000 });
        expect(overview.candidates).toHaveLength(0);
        expect(overview.counts.totalAttention).toBe(0);
        expect(overview.counts.thinking).toBe(0);
    });

    it('admits an explicit due reminder without turning the unfollowed session into tracked unread', () => {
        const session = Object.assign(createSessionFixture({
            id: 'reminder-due',
            seq: 50,
            lastViewedSessionSeq: 0,
        }), { viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' },
            relevance: { relevant: true, reasons: ['explicit_attention'] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'none', source: 'none' },
            attention: { needsAttention: true, reasons: ['reminder_due'], primary: 'reminder_due', presentation: 'full' },
        } } as const);

        const overview = buildActivityOverviewFromSource({ source: createSource({ sessions: [session] }), nowMs: 1_000 });

        expect(overview.candidates).toHaveLength(1);
        expect(overview.candidates[0]).toMatchObject({ sessionId: 'reminder-due', hasAttention: true });
        expect(overview.counts.unread).toBe(0);
    });

    it('keeps same-id sessions on different Homes as distinct qualified candidates', () => {
        const sharedId = 'same-session-id';
        const renderableA = buildSessionListRenderableFromSession(createSessionFixture({
            id: sharedId,
            seq: 5,
            latestReadyEventSeq: 5,
            lastViewedSessionSeq: 1,
            updatedAt: 50,
            meaningfulActivityAt: 50,
        }));
        const renderableB = buildSessionListRenderableFromSession(createSessionFixture({
            id: sharedId,
            seq: 8,
            latestReadyEventSeq: 8,
            lastViewedSessionSeq: 2,
            updatedAt: 80,
            meaningfulActivityAt: 80,
        }));

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListIndexByServerId: {
                    'server-a': [{
                        type: 'session',
                        sessionId: sharedId,
                        serverId: 'server-a',
                        serverName: 'Home A',
                    }],
                    'server-b': [{
                        type: 'session',
                        sessionId: sharedId,
                        serverId: 'server-b',
                        serverName: 'Home B',
                    }],
                },
                sessionListRowsByServerId: {
                    'server-a': { [sharedId]: renderableA },
                    'server-b': { [sharedId]: renderableB },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-a': [sharedId],
                    'server-b': [sharedId],
                },
                concurrentSessionListCacheByServerId: {
                    'server-a': { serverName: 'Home A' },
                    'server-b': { serverName: 'Home B' },
                },
                serverProfilesById: {
                    'server-a': {
                        id: 'server-a',
                        name: 'Home A',
                        serverUrl: 'https://a.example.test',
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                        source: 'manual',
                    },
                    'server-b': {
                        id: 'server-b',
                        name: 'Home B',
                        serverUrl: 'https://b.example.test',
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                        source: 'manual',
                    },
                },
            },
            nowMs: 1_000,
            activityName: 'desktop\u0000overlay',
        });

        expect(overview.candidates.map((candidate) => candidate.address)).toEqual([
            { serverId: 'server-b', sessionId: sharedId },
            { serverId: 'server-a', sessionId: sharedId },
        ]);
        expect(overview.counts.unread).toBe(2);
        expect(overview.counts.totalAttention).toBe(2);
        expect(overview.candidates.map((candidate) => candidate.activityInstanceKey)).toEqual([
            activityInstanceKey(
                { serverId: 'server-b', sessionId: sharedId },
                'desktop\u0000overlay',
            ),
            activityInstanceKey(
                { serverId: 'server-a', sessionId: sharedId },
                'desktop\u0000overlay',
            ),
        ]);
    });

    it('builds a deterministic multi-server attention overview from normalized session indexes', () => {
        const permission = createSessionFixture({
            id: 'permission',
            active: true,
            presence: 'online',
            seq: 1,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 950,
            agentState: pendingAgentState('permission'),
            updatedAt: 20,
        });
        const thinking = createSessionFixture({
            id: 'thinking',
            seq: 2,
            lastViewedSessionSeq: 2,
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 950,
            updatedAt: 30,
        });
        const unread = createSessionFixture({
            id: 'unread',
            seq: 12,
            latestReadyEventSeq: 12,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
        });

        const overview = buildActivityOverviewFromSource({
            source: createSource({ sessions: [unread, thinking, permission] }),
            nowMs: 1_000,
        });

        expect(overview.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            thinking: 1,
            totalAttention: 2,
        });
        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'permission',
            'thinking',
            'unread',
        ]);
    });

    it('distinguishes unknown sessions from an observed empty Home in the summary', () => {
        expect(buildActivityOverviewSummaryFromSource({ source: createSource({ sessions: [], isDataReady: false }), nowMs: 1_000 }))
            .toMatchObject({ isDataReady: false, workingCount: 0, needsYouCount: 0 });
        expect(buildActivityOverviewSummaryFromSource({ source: createSource({ sessions: [], isDataReady: true }), nowMs: 1_000 }))
            .toMatchObject({ isDataReady: true, workingCount: 0, needsYouCount: 0 });
    });


    it('counts the working sessions and the ones that need the person in the mounted summary (Home status line)', () => {
        const permission = createSessionFixture({
            id: 'permission', active: true, presence: 'online', seq: 1, lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 950,
            agentState: pendingAgentState('permission'), updatedAt: 20,
        });
        const thinking = createSessionFixture({
            id: 'thinking', seq: 2, lastViewedSessionSeq: 2, active: true, presence: 'online',
            thinking: true, thinkingAt: 950, updatedAt: 30,
        });
        const unread = createSessionFixture({
            id: 'unread', seq: 12, latestReadyEventSeq: 12, lastViewedSessionSeq: 1, updatedAt: 40,
        });
        const source = createSource({ sessions: [unread, thinking, permission] });
        // The same classification as the full overview: an unread reply neither works nor needs the person.
        const overview = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        expect(buildActivityOverviewSummaryFromSource({ source, nowMs: 1_000 })).toMatchObject({
            workingCount: overview.counts.thinking,
            needsYouCount: overview.counts.permissionRequired + overview.counts.actionRequired,
        });
        expect(buildActivityOverviewSummaryFromSource({ source, nowMs: 1_000 })).toMatchObject({ workingCount: 1, needsYouCount: 1 });
    });

    it('counts working sessions per machine with the same classifier as the summary (Machines popover, All machines)', () => {
        const onA = (id: string, overrides: Parameters<typeof createSessionFixture>[0] = {}) => createSessionFixture({
            id, seq: 2, lastViewedSessionSeq: 2, active: true, presence: 'online', thinking: true, thinkingAt: 950, updatedAt: 30,
            metadata: { ...createSessionFixture().metadata!, machineId: 'machine-a' }, ...overrides,
        });
        const workingA1 = onA('working-a1');
        const workingA2 = onA('working-a2');
        const workingB = onA('working-b', { metadata: { ...createSessionFixture().metadata!, machineId: 'machine-b' } });
        // An unread reply and a pending permission are not "working": the summary does not count them either.
        const idleA = onA('idle-a', { thinking: false, thinkingAt: 0, seq: 12, latestReadyEventSeq: 12, lastViewedSessionSeq: 1 });
        const otherHome = onA('working-other-home', { serverId: 'server-b' });
        const source = createSource({ sessions: [workingA1, workingA2, workingB, idleA, otherHome] });
        const counts = buildMachineWorkingCounts({ source, nowMs: 1_000, state: {} as never });
        expect(Object.fromEntries(counts.byMachine)).toEqual({
            [machineWorkingKey({ serverId: 'server-a', machineId: 'machine-a' })]: 2,
            [machineWorkingKey({ serverId: 'server-a', machineId: 'machine-b' })]: 1,
            // The same machine id on another Home is another machine.
            [machineWorkingKey({ serverId: 'server-b', machineId: 'machine-a' })]: 1,
        });
        expect(counts.total).toBe(buildActivityOverviewSummaryFromSource({ source, nowMs: 1_000 }).workingCount);
    });

    it('carries target, server profile, direct-action, stale, dwell, and stable fingerprint facts on source candidates', () => {
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [
                    createSessionFixture({
                        id: 'permission',
                        pendingPermissionRequestCount: 1,
                        agentState: pendingAgentState('permission'),
                        serverId: 'server-b',
                        updatedAt: 20,
                    }),
                ],
            }),
            nowMs: 1_000,
            activityName: 'HappierFocusLiveActivity',
            directActionsEnabled: true,
        });

        expect(overview.fingerprint).toBe(buildStableActivityOverviewFingerprint(overview));
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'permission',
            serverId: 'server-b',
            serverUrl: null,
            serverName: 'This Home',
            route: '/session/permission?serverId=server-b',
            target: 'open-session:permission?serverId=server-b',
            activityName: 'HappierFocusLiveActivity',
            activityInstanceKey: activityInstanceKey(
                { serverId: 'server-b', sessionId: 'permission' },
                'HappierFocusLiveActivity',
            ),
            serverFacts: {
                isKnown: true,
                isSaved: false,
                isActiveLocal: false,
            },
            directActionCapability: {
                canExecute: false,
                reason: 'server_not_saved',
            },
            surfaceTiming: {
                desktopOverlay: {
                    staleAfterMs: 120_000,
                    dwellMs: 90_000,
                },
                liveActivity: {
                    staleAfterMs: 1_800_000,
                    dwellMs: 90_000,
                },
                homeWidget: {
                    staleAfterMs: 1_800_000,
                    dwellMs: 90_000,
                },
            },
        });
    });

    it('preserves stale-while-revalidate behavior by keeping no candidates until source data is ready', () => {
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                isDataReady: false,
                sessions: [
                    createSessionFixture({
                        id: 'unread',
                        seq: 12,
                        lastViewedSessionSeq: 1,
                    }),
                ],
            }),
            nowMs: 1_000,
        });

        expect(overview.counts.totalAttention).toBe(0);
        expect(overview.candidates).toEqual([]);
    });

    it('includes unread sessions from canonical secondary-Home row state', () => {
        const unread = {
            id: 'concurrent-unread',
            seq: 5,
            lastViewedSessionSeq: 1,
            createdAt: 1,
            updatedAt: 50,
            active: false,
            activeAt: 1,
            archivedAt: null,
            metadataVersion: 1,
            agentStateVersion: 0,
            metadata: { path: '/repo', host: 'remote' },
            thinking: false,
            thinkingAt: 0,
            presence: 1 as const,
            hasUnreadMessages: true,
        };
        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListIndexByServerId: {},
                sessionListRowsByServerId: {
                    'server-b': { 'concurrent-unread': unread },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-b': ['concurrent-unread'],
                },
                concurrentSessionListCacheByServerId: {
                    'server-b': {
                        serverName: 'Server B',
                    },
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(overview.counts.unread).toBe(1);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'concurrent-unread',
            serverId: 'server-b',
            serverName: 'This Home',
            route: '/session/concurrent-unread?serverId=server-b',
            target: 'open-session:concurrent-unread?serverId=server-b',
        });
    });

    it('does not treat stale cached-row thinking as activity after a completed primary turn projection', () => {
        const staleCompleted = buildSessionListRenderableFromSession(Object.assign(createSessionFixture({
            id: 'stale-completed',
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 1_000,
            seq: 2,
            lastViewedSessionSeq: 2,
        }), {
            latestTurnStatus: 'completed' as const,
            latestTurnStatusObservedAt: 2_000,
        }));

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListIndexByServerId: {},
                sessionListRowsByServerId: {
                    'server-b': { [staleCompleted.id]: staleCompleted },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-b': [staleCompleted.id],
                },
                concurrentSessionListCacheByServerId: {
                    'server-b': {
                        serverName: 'Server B',
                    },
                },
            },
            nowMs: 2_100,
        });

        expect(overview.counts.thinking).toBe(0);
        expect(overview.counts.totalAttention).toBe(0);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'stale-completed',
            attentionState: 'ready',
            hasAttention: false,
        });
    });

    it('preserves canonical background activity without inventing viewer attention or foreground thinking', () => {
        const nowMs = 1_000_000;
        const renderable = buildSessionListRenderableFromSession(createSessionFixture({
            id: 'provider-runtime',
            active: true,
            activeAt: nowMs - 20_000,
            presence: 'online',
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: nowMs - 1_000,
            runtimeActivityRevision: nowMs + 60_000,
        }));

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [] }),
                sessionsById: {},
                sessionListIndexByServerId: {},
                sessionListRowsByServerId: {
                    'server-b': { [renderable.id]: renderable },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-b': [renderable.id],
                },
                concurrentSessionListCacheByServerId: {
                    'server-b': {
                        serverName: 'Server B',
                    },
                },
            },
            nowMs,
        });

        expect(overview.counts.thinking).toBe(0);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'provider-runtime',
            attentionState: 'background_active',
            hasAttention: false,
        });
    });

    it('surfaces and clears same-seq newer permission summaries without inventing request identity', () => {
        const canonicalSession = createSessionFixture({
            id: 'hidden-summary-permission',
            serverId: 'server-a',
            seq: 4,
            lastViewedSessionSeq: 4,
            active: true,
            presence: 'online',
            agentStateVersion: 6,
            agentState: null,
            metadata: {
                path: '/tmp/hidden-summary-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const source = createSource({ sessions: [canonicalSession] });
        const pendingRenderable = {
            ...source.sessionListRowsByServerId?.['server-a']?.[canonicalSession.id]!,
            agentStateVersion: 7,
            hasPendingPermissionRequests: true,
            hasPendingUserActionRequests: false,
            pendingRequestObservedAt: 975,
        };

        const pendingOverview = buildActivityOverviewFromSource({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-a': { [canonicalSession.id]: pendingRenderable },
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(pendingOverview.counts.permissionRequired).toBe(1);
        expect(pendingOverview.candidates).toHaveLength(1);
        expect(pendingOverview.candidates[0]).toMatchObject({
            sessionId: canonicalSession.id,
            attentionState: 'permission_required',
            route: `/session/${canonicalSession.id}?serverId=server-a`,
        });
        expect(buildInboxSessionPresentation({ overview: pendingOverview }).sessionsNeedingAttention[0]?.pendingPermissions)
            .toEqual([]);

        const clearedOverview = buildActivityOverviewFromSource({
            source: {
                ...source,
                sessionListRowsByServerId: {
                    'server-a': { [canonicalSession.id]: {
                        ...pendingRenderable,
                        agentStateVersion: 8,
                        hasPendingPermissionRequests: false,
                        pendingRequestObservedAt: null,
                    } },
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(clearedOverview.counts.permissionRequired).toBe(0);
        expect(clearedOverview.candidates).toEqual([]);
    });

    it('counts blocked pending delivery as action-required source activity', () => {
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [
                    createSessionFixture({
                        id: 'blocked-pending',
                        pendingCount: 1,
                        pendingBlockedCount: 1,
                        updatedAt: 20,
                    }),
                ],
            }),
            nowMs: 1_000,
        });

        expect(overview.counts.actionRequired).toBe(1);
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'blocked-pending',
            reasons: {
                hasBlockedPendingDelivery: true,
            },
        });
    });

    it('discovers Voice custody from canonical sessions even though hidden sessions are absent from the user-facing index', () => {
        const hiddenPermission = createSessionFixture({
            id: 'hidden-unindexed-permission',
            active: true,
            presence: 'online',
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: pendingAgentState('permission', 975),
            updatedAt: 45,
            serverId: 'server-a',
            metadata: {
                path: '/tmp/hidden-unindexed-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
        });
        const hiddenLateResult = createSessionFixture({
            id: 'hidden-unindexed-late-result',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
            serverId: 'server-a',
            metadata: {
                path: '/tmp/hidden-unindexed-late-result',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const source = createSource({
            sessions: [hiddenPermission, hiddenLateResult],
        });

        const overview = buildActivityOverviewFromSource({
            source: {
                ...source,
                // The canonical session list intentionally excludes hidden system
                // sessions. Activity custody must therefore discover these records
                // from the hydrated canonical session map rather than the list index.
                sessionListIndexByServerId: {
                    'server-a': [],
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'hidden-unindexed-permission',
            'hidden-unindexed-late-result',
        ]);
        expect(overview.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            totalAttention: 2,
        });
        expect(overview.candidates[0]).toMatchObject({
            route: '/session/hidden-unindexed-permission?serverId=server-a',
            directActionCapability: { canExecute: true, reason: 'allowed' },
        });
    });

    it('keeps quiet hidden system sessions out while surfacing hidden pending permissions and late results', () => {
        const visible = createSessionFixture({
            id: 'visible-unread',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 30,
        });
        const hidden = createSessionFixture({
            id: 'hidden-late-result',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
            metadata: {
                path: '/tmp/hidden-system',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
            },
        });
        const hiddenPermission = createSessionFixture({
            id: 'hidden-permission',
            active: true,
            presence: 'online',
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: pendingAgentState('permission', 975),
            updatedAt: 45,
            metadata: {
                path: '/tmp/hidden-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
        });
        const hiddenQuiet = createSessionFixture({
            id: 'hidden-quiet',
            seq: 4,
            lastViewedSessionSeq: 4,
            updatedAt: 35,
            metadata: {
                path: '/tmp/hidden-quiet',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
            },
        });
        const unrelatedHiddenPermission = createSessionFixture({
            id: 'voice-transcript-history',
            active: true,
            presence: 'online',
            seq: 5,
            latestReadyEventSeq: 5,
            lastViewedSessionSeq: 1,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 980,
            agentState: pendingAgentState('permission', 980),
            updatedAt: 55,
            metadata: {
                path: '/tmp/voice-transcript-history',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_transcript_history', hidden: true },
            },
        });
        const unavailable = {
            ...buildSessionListRenderableFromSession(createSessionFixture({
                id: 'metadata-unavailable',
                seq: 4,
                lastViewedSessionSeq: 1,
                updatedAt: 50,
            })),
            metadata: null,
            metadataUnavailable: true,
            hasUnreadMessages: true,
        };

        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [visible, hidden, hiddenPermission, hiddenQuiet, unrelatedHiddenPermission] }),
                sessionListRowsByServerId: {
                    'server-a': {
                        [visible.id]: buildSessionListRenderableFromSession(visible),
                        [hidden.id]: buildSessionListRenderableFromSession(hidden),
                        [hiddenPermission.id]: buildSessionListRenderableFromSession(hiddenPermission),
                        [hiddenQuiet.id]: buildSessionListRenderableFromSession(hiddenQuiet),
                        [unrelatedHiddenPermission.id]: buildSessionListRenderableFromSession(unrelatedHiddenPermission),
                        [unavailable.id]: unavailable,
                    },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-a': [visible.id, hidden.id, hiddenPermission.id, hiddenQuiet.id, unrelatedHiddenPermission.id, unavailable.id],
                },
                sessionListIndexByServerId: {
                    'server-a': [
                        { type: 'session', sessionId: visible.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: hidden.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: hiddenPermission.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: hiddenQuiet.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: unrelatedHiddenPermission.id, serverId: 'server-a', serverName: 'Server A' },
                        { type: 'session', sessionId: unavailable.id, serverId: 'server-a', serverName: 'Server A' },
                    ],
                },
            },
            nowMs: 1_000,
            directActionsEnabled: true,
        });

        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'hidden-permission',
            'hidden-late-result',
            'visible-unread',
        ]);
        expect(overview.counts).toMatchObject({
            unread: 2,
            permissionRequired: 1,
            totalAttention: 3,
        });
        expect(overview.candidates[0]).toMatchObject({
            sessionId: 'hidden-permission',
            route: '/session/hidden-permission?serverId=server-a',
            target: 'open-session:hidden-permission?serverId=server-a',
            directActionCapability: {
                canExecute: true,
                reason: 'allowed',
            },
        });
    });

    it('keeps permission and late-result custody reachable after a Voice session is retired and attention freshness expires', () => {
        const retiredPermission = createSessionFixture({
            id: 'retired-permission',
            active: true,
            presence: 'online',
            seq: 2,
            lastViewedSessionSeq: 2,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 975,
            agentState: pendingAgentState('permission', 975),
            updatedAt: 45,
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 2, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
                attention: {
                    needsAttention: true,
                    reasons: ['permission_required'],
                    primary: 'permission_required',
                    presentation: 'full',
                },
            },
            metadata: {
                path: '/tmp/retired-permission',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const retiredLateResult = createSessionFixture({
            id: 'retired-late-result',
            seq: 4,
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            updatedAt: 40,
            metadata: {
                path: '/tmp/retired-late-result',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });
        const retiredQuiet = createSessionFixture({
            id: 'retired-quiet',
            seq: 4,
            lastViewedSessionSeq: 4,
            updatedAt: 35,
            metadata: {
                path: '/tmp/retired-quiet',
                host: 'test-host',
                systemSessionV1: { v: 1, key: 'voice_conversation_retired', hidden: true },
            },
        });

        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [retiredPermission, retiredLateResult, retiredQuiet],
            }),
            nowMs: 200_000,
            directActionsEnabled: true,
        });

        expect(overview.candidates.map((candidate) => candidate.sessionId)).toEqual([
            'retired-permission',
            'retired-late-result',
        ]);
        expect(overview.counts).toMatchObject({
            unread: 1,
            permissionRequired: 1,
            totalAttention: 2,
        });
        expect(overview.candidates[0]).toMatchObject({
            route: '/session/retired-permission?serverId=server-a',
            directActionCapability: { canExecute: true, reason: 'allowed' },
        });
    });

    it('builds a stable fingerprint that ignores generated time fields outside visible meaning', () => {
        const source = createSource({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    pendingPermissionRequestCount: 1,
                    agentState: pendingAgentState('permission'),
                    updatedAt: 20,
                }),
            ],
        });

        const first = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        const second = buildActivityOverviewFromSource({ source, nowMs: 2_000 });

        expect(buildStableActivityOverviewFingerprint(first)).toBe(buildStableActivityOverviewFingerprint(second));
    });

    it.each(['cold', 'mixed'] as const)('reuses admitted list facts across idle Activity passes and replaces only the changed row (%s)', (kind) => {
        const sessions = Array.from({ length: 1_001 }, (_, index) => createSessionFixture({
            id: `cold-${index}`, serverId: 'server-a',
            pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0,
            agentState: pendingAgentState('permission'),
        }));
        const baseline = createSource({ sessions });
        const source = kind === 'cold' ? { ...baseline, sessionsById: {} } : { ...baseline,
            sessionListRowsByServerId: { ...baseline.sessionListRowsByServerId,
                'server-a': Object.fromEntries(Object.values(baseline.sessionListRowsByServerId['server-a'])
                    .map(row => [row.id, { ...row, seq: row.seq + 1 }])),
            },
        };
        const first = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        const second = buildActivityOverviewFromSource({ source, nowMs: 2_000 });
        expect(first.candidates).toHaveLength(sessions.length);
        const firstById = new Map(first.candidates.map(candidate => [candidate.sessionId, candidate.session]));
        const rebuilt = second.candidates.filter(candidate => candidate.session !== firstById.get(candidate.sessionId));
        expect(rebuilt).toHaveLength(0);

        const rows = source.sessionListRowsByServerId['server-a'];
        const changed = { ...rows['cold-500']!, manager: { sessionId: 'new-lead' } };
        const next = buildActivityOverviewFromSource({ source: { ...source,
            sessionListRowsByServerId: { ...source.sessionListRowsByServerId,
                'server-a': { ...rows, [changed.id]: changed } },
        }, nowMs: 2_000 });
        expect(next.candidates.filter(candidate => candidate.session !== firstById.get(candidate.sessionId))
            .map(candidate => candidate.sessionId)).toEqual(['cold-500']);
        expect(next.candidates.find(candidate => candidate.sessionId === changed.id)?.session.manager)
            .toEqual({ sessionId: 'new-lead' });
    });

    it('keeps mixed lifecycle, held requests and private owner facts in summary and detail', () => {
        const base = createSessionFixture({ id: 'mixed-summary', serverId: 'server-a', active: true, activeAt: 1_000,
            updatedAt: 950, metadataVersion: 3, agentStateVersion: 3,
            metadata: { path: '/current', host: 'machine', work: { statusReason: 'Held owner explanation' } },
            agentState: pendingAgentState('permission') });
        const initial = createSource({ sessions: [base] });
        const row = buildSessionListRenderableFromSession({ ...base, seq: base.seq + 1,
            agentStateVersion: 2, metadataVersion: 2, active: false, activeAt: 100, updatedAt: 100,
            metadata: { path: '/older', host: 'older' } });
        const source = { ...initial, sessionListRowsByServerId: { 'server-a': { [row.id]: row } } };
        const detail = buildActivityOverviewFromSource({ source, nowMs: 1_000 });
        expect(detail.candidates[0]?.reasons.hasPendingPermissionRequests).toBe(true);
        expect(buildActivityOverviewSummaryFromSource({ source, nowMs: 1_000 }).needsYouCount).toBe(1);
        let visited = 0;
        forEachActivitySummaryCandidate({ source, nowMs: 1_000 }, ({ candidate }) => {
            visited++;
            expect(candidate.awareness.statusReason).toBe('Held owner explanation');
            expect(buildInboxSessionPresentation({ overview: { ...detail, candidates: [candidate] } })
                .sessionsNeedingAttention[0]?.pendingPermissions[0]?.id).toBe('request_1');
        });
        expect(visited).toBe(1);
    });

    it('projects the same canonical failed-query freshness as the Session row', () => {
        const session = createSessionFixture({
            id: 'permission',
            pendingPermissionRequestCount: 1,
            agentState: pendingAgentState('permission'),
            serverId: 'server-b',
            updatedAt: 20,
            metadata: { path: '/home/alice/project', homeDir: '/home/alice', host: 'workstation' },
        });
        const overview = buildActivityOverviewFromSource({
            source: createSource({
                sessions: [session],
                sessionListHomeObservationByServerId: {
                    'server-b': { phase: 'error', lastSuccessAt: 1_000 },
                },
            }),
            nowMs: 1_000 + 18 * 60_000,
        });

        const context = overview.candidates[0]?.context;
        expect(context?.contextLine).toContain("Couldn't refresh");
        expect(context?.contextLine).toContain('Last updated 18m ago');
        // Activity consumes the same workspace-display owner as Session rows. Its default mode is
        // the concise basename, while still proving the absolute Home path does not leak.
        expect(context?.workspace).toEqual({ label: 'project' });
        expect(context?.contextLine).not.toContain('/home/alice');
    });

    it('uses the canonical custom workspace label for a list-renderable-only Activity candidate', () => {
        const session = createSessionFixture({
            id: 'custom-workspace-label',
            pendingPermissionRequestCount: 1,
            agentState: pendingAgentState('permission'),
            serverId: 'server-a',
            metadata: {
                path: '/home/alice/project',
                homeDir: '/home/alice',
                host: 'workstation',
                machineId: 'machine-a',
            },
        });
        const source = createSource({
                sessions: [session],
                workspaceRefsV1: [{
                    id: 'workspace-a',
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/home/alice/project',
                    label: 'Happier Core',
                    createdAtMs: 1,
                    lastOpenedAtMs: 1,
                }],
            });
        const overview = buildActivityOverviewFromSource({
            source: {
                ...source,
                sessionsById: {},
            },
            nowMs: 1_000,
        });

        expect(overview.candidates[0]?.context?.workspace).toEqual({ label: 'Happier Core' });
    });

    it('gives two Homes sharing one Session id distinct Activity instance identities', () => {
        const colliding = {
            pendingPermissionRequestCount: 1,
            agentState: pendingAgentState('permission'),
            updatedAt: 10,
        } as const;
        const collidingA = createSessionFixture({ ...colliding, id: 'b:c', serverId: 'server-a' });
        const collidingB = createSessionFixture({ ...colliding, id: 'b:c', serverId: 'server-b' });
        const overview = buildActivityOverviewFromSource({
            source: {
                ...createSource({ sessions: [collidingA] }),
                sessionsById: { 'b:c': collidingA },
                sessionListRowsByServerId: {
                    'server-a': { 'b:c': buildSessionListRenderableFromSession(collidingA) },
                    'server-b': { 'b:c': buildSessionListRenderableFromSession(collidingB) },
                },
                ordinarySessionListMembershipByServerId: {
                    'server-a': ['b:c'],
                    'server-b': ['b:c'],
                },
            },
            nowMs: 1_000,
            activityName: 'HappierFocusLiveActivity',
        });

        const keys = overview.candidates.map((candidate) => candidate.activityInstanceKey);
        expect(new Set(keys)).toEqual(new Set([
            activityInstanceKey({ serverId: 'server-a', sessionId: 'b:c' }, 'HappierFocusLiveActivity'),
            activityInstanceKey({ serverId: 'server-b', sessionId: 'b:c' }, 'HappierFocusLiveActivity'),
        ]));
        expect(keys).toHaveLength(2);
    });
});

describe('readActivitySourceAttentionMessages', () => {
    const storedMessages = { messages: [{ id: 'm1', localId: null, seq: 1 }] };
    // Compatibility fixture: the reader intentionally accepts the released
    // array-shaped transcript before store normalization.
    const legacySessionMessages = {
        'legacy-session': storedMessages,
    } as unknown as NonNullable<ActivityAttentionSource['sessionMessagesById']>;

    it('returns the exact stored transcript this overview decided a hydrated candidate with', () => {
        const session = createSessionFixture({
            id: 'legacy-session',
            serverId: 'server-a',
            active: true,
            presence: 'online',
            agentState: pendingAgentState('user_action'),
        });
        const source: ActivityAttentionSource = {
            ...createSource({ sessions: [session] }),
            sessionMessagesById: legacySessionMessages,
        };

        expect(readActivitySourceAttentionMessages(source, { serverId: 'server-a', sessionId: 'legacy-session' }))
            .toEqual(storedMessages.messages);
    });

    it('returns nothing for another Home holding the same Session id, whose messages are not this row', () => {
        const session = createSessionFixture({
            id: 'legacy-session',
            serverId: 'server-a',
            active: true,
            presence: 'online',
            agentState: pendingAgentState('user_action'),
        });
        const source: ActivityAttentionSource = {
            ...createSource({ sessions: [session] }),
            sessionMessagesById: legacySessionMessages,
        };

        expect(readActivitySourceAttentionMessages(source, { serverId: 'server-b', sessionId: 'legacy-session' }))
            .toBeUndefined();
        expect(readActivitySourceAttentionMessages(source, null)).toBeUndefined();
    });
});
