import { NO_TEAM_GROUP_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';
import { projectLegacySessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { applyTeamGroupProjection } from '@/sync/store/teams/teamsSnapshots';
import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { SESSION_OPTIMISTIC_PENDING_THINKING_MS } from '@/sync/domains/session/attention/runtimePresentation';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { t } from '@/text';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { nestSessionListReports } from '@/sync/domains/session/listing/nestSessionListReports';
import { sessionTagKey } from './sessionTagUtils';
import { buildSessionListRowViewModel, buildSessionListRowViewModels, resolveSessionListRowViewModelAdjacency, readSessionListRowRefreshAtMs } from './sessionListRowViewModels';

function createRenderableSession(id: string): SessionListRenderableSession {
    return {
        id,
        // These rows assert runtime and work state, which the awareness owner only reports for
        // content this viewer can read. Without a stated mode every fixture is an unopened
        // envelope and every assertion below degrades to `unknown`.
        encryptionMode: 'plain',
        seq: 1,
        createdAt: 100,
        updatedAt: 200,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name: 'Stable session',
            path: '/repo/stable',
            homeDir: '/repo',
            host: 'test.local',
            machineId: 'machine-a',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

type SessionListSessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function rowKey(item: Pick<SessionListSessionIndexItem, 'serverId' | 'sessionId'>): string {
    const key = buildSessionListServerScopedRowKey(item.serverId, item.sessionId);
    if (!key) {
        throw new Error(`Expected a session-list row key for ${item.serverId}:${item.sessionId}`);
    }
    return key;
}

describe('buildSessionListRowViewModels', () => {
    it('binds the P5 row context: a group implies its Project and baseline, a shelf names them (U5)', () => {
        const project = { serverId: 'home', projectKey: 'pk-happier' };
        const baseline = { id: 'ref-main', serverId: 'home', machineId: 'machine-a', rootPath: '/repo/happier', label: 'happier', createdAtMs: 1 };
        const grouped = { type: 'session', sessionId: 'ctx-row', serverId: 'home', groupKey: 'project:happier', groupKind: 'project', projectKey: project } satisfies SessionListIndexItem;
        const shelf = { ...grouped, groupKey: 'attention', groupKind: 'attention' as const, occurrenceRole: 'needsYou' as const };
        const onDevbox = { ...grouped, sessionId: 'ctx-devbox' };
        const report = { ...grouped, sessionId: 'ctx-report' };
        const base = createRenderableSession('ctx-row');
        const session = { ...base, metadata: { ...base.metadata!, path: '/repo/happier-fix', workspaceId: 'ref-fix', branch: 'fix-remount' } };
        const devboxBase = createRenderableSession('ctx-devbox');
        const devbox = { ...devboxBase, metadata: { ...devboxBase.metadata!, machineId: 'machine-b', path: '/repo/happier', workspaceId: 'ref-devbox', branch: null } };
        const reportSession = { ...session, id: report.sessionId, manager: { sessionId: grouped.sessionId } };
        const rowRenderableByKey = new Map<string, SessionListRenderableSession>([
            [rowKey(grouped), session], [rowKey(report), reportSession], [rowKey(onDevbox), devbox],
        ]);
        const rowContext = {
            enabled: true,
            identityDisplay: 'auto' as const,
            projectDisplayByKey: new Map([[projectGroupIdentityKey(project), { project, baseline, title: 'happier', hasCustomLabel: false }]]),
            groupProjectByGroupKey: new Map([['project:happier', project]]),
        };
        const input = {
            listItems: nestSessionListReports([shelf, grouped, report, onDevbox],
                (serverId, sessionId) => rowRenderableByKey.get(sessionTagKey(serverId ?? '', sessionId)) ?? null),
            reachableSessionDisplayById: new Map(),
            reachableSessionDisplayByKey: new Map([[sessionTagKey('home', 'ctx-devbox'), { machineId: 'machine-b', machineLabel: 'devbox', workspaceSubtitle: '', workspaceSubtitleEllipsizeMode: 'head' as const }]]),
            rowRenderableByKey,
            relativeNowMs: 1_000, runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set<string>(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false, rowContext,
        };
        const [inShelf, inGroup, underLead, elsewhere] = buildSessionListRowViewModels(input);
        // Inside its own Project group: the Agent leads, the Project is implied, the worktree's branch speaks.
        expect(inGroup?.rowContext).toMatchObject({ leadingMark: 'agent', project: null,
            checkout: { kind: 'branch', label: 'fix-remount' } });
        // The shelf copy names its Project (no favicon is held yet, so the folder mark and name stand in).
        expect(inShelf?.rowContext).toMatchObject({ leadingMark: 'projectWithAgent',
            project: { label: 'happier', yieldsToFavicon: true }, checkout: { kind: 'branch', label: 'fix-remount' } });
        const faviconSource = { serverId: 'home', machineId: 'machine-a', workspacePath: '/repo/happier' };
        expect(inShelf?.rowContext).toHaveProperty('projectFaviconSource', faviconSource);
        expect(inGroup?.rowContext).toHaveProperty('projectFaviconSource', faviconSource);
        // Neither a different row Machine/checkout nor its shelf placement elects a favicon source.
        expect(elsewhere?.rowContext).toHaveProperty('projectFaviconSource', faviconSource);
        // Rows never name a Machine, including in their optional path subtitle or accessibility label.
        expect(elsewhere?.rowContext).toMatchObject({ checkout: null });
        expect(elsewhere?.subtitleOverride ?? '').not.toContain('devbox');
        expect(elsewhere?.rowContext?.accessibleLabel).not.toContain('devbox');
        // A displayed lead supplies its actual Machine and checkout even away from the baseline.
        expect(underLead?.rowContext).toMatchObject({ checkout: null });
        // Turning optional context off hides it visually but keeps it for assistive technology.
        const [, quiet] = buildSessionListRowViewModels({ ...input, rowContext: { ...rowContext, enabled: false } });
        expect(quiet?.rowContext).toMatchObject({ project: null, checkout: null });
        expect(quiet?.rowContext?.accessibleLabel).toContain('fix-remount');
        expect(quiet?.rowContext).toHaveProperty('projectFaviconSource', faviconSource);
        const withoutBaseline = buildSessionListRowViewModels({ ...input, rowContext: { ...rowContext,
            projectDisplayByKey: new Map([[projectGroupIdentityKey(project), {
                project, baseline: null, title: 'happier', hasCustomLabel: true,
            }]]),
        } });
        expect(withoutBaseline[0]?.rowContext).toHaveProperty('projectFaviconSource', null);
        expect(withoutBaseline[1]?.rowContext).toHaveProperty('projectFaviconSource', null);
        expect(withoutBaseline[0]).not.toBe(inShelf);
        const otherProject = { serverId: 'other-home', projectKey: 'other-project' };
        const underOtherProject = buildSessionListRowViewModels({ ...input, rowContext: { ...rowContext,
            groupProjectByGroupKey: new Map([['project:happier', otherProject]]),
            projectDisplayByKey: new Map([...rowContext.projectDisplayByKey,
                [projectGroupIdentityKey(otherProject), { project: otherProject,
                    baseline: { ...baseline, serverId: 'other-home', machineId: 'foreign-machine', rootPath: '/foreign' },
                    title: 'other', hasCustomLabel: false }]]),
        } });
        expect(underOtherProject[1]?.rowContext).toHaveProperty('projectFaviconSource', faviconSource);
    });

    it('retains independent mirror models and paints unqualified selection on both copies', () => {
        const base = { type: 'session', sessionId: 'mirrored-model', serverId: 'home', groupKey: 'project' } satisfies SessionListIndexItem;
        const shelf = { ...base, groupKey: 'attention', occurrenceRole: 'needsYou' as const };
        const input = { listItems: [shelf, base], reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(base), createRenderableSession(base.sessionId)]]),
            relativeNowMs: 1_000, runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set<string>(), sessionTags: {}, selectedSessionId: base.sessionId,
            showServerBadge: false, showPinnedServerBadge: false };
        const first = buildSessionListRowViewModels(input);
        expect(first.map(model => model?.selected)).toEqual([true, true]);
        const second = buildSessionListRowViewModels(input);
        expect(second[0]).toBe(first[0]);
        expect(second[1]).toBe(first[1]);
    });

    it('selects row-local age, runtime, reminder and stale Home deadlines', () => {
        const now = 1_800_000_000_000;
        const old = { ...createRenderableSession('deadline'), presence: 0, createdAt: now - 2 * 86_400_000 };
        expect(readSessionListRowRefreshAtMs({ session: old, reminderAtMs: null }, now)).toBe(now + 86_400_000);
        expect(readSessionListRowRefreshAtMs({ session: old, reminderAtMs: now + 500 }, now)).toBe(now + 500);
        expect(readSessionListRowRefreshAtMs({ session: old, reminderAtMs: null,
            homeObservation: { phase: 'offline', lastSuccessAt: now - 59_000 } }, now)).toBe(now + 1_000);
        const fresh = { ...old, active: true, presence: 'online' as const, activeAt: now,
            optimisticThinkingAt: now, pendingCount: 1 };
        expect(readSessionListRowRefreshAtMs({ session: fresh, reminderAtMs: null }, now))
            .toBe(now + SESSION_OPTIMISTIC_PENDING_THINKING_MS);
        expect(readSessionListRowRefreshAtMs({ session: null, reminderAtMs: null }, now)).toBeNull();
    });
    it('does not reuse a row view model when control-character-bearing tag tuples differ', () => {
        const item = { type: 'session', sessionId: 'tag-collision', serverId: 'server-a',
            storageKind: 'persisted', groupKey: 'group', groupKind: 'date' } satisfies SessionListIndexItem;
        const sessionKey = rowKey(item);
        const session = createRenderableSession(item.sessionId);
        const base = {
            listItems: [item], reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[sessionKey, session]]),
            pinnedSessionKeys: new Set<string>(), selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false,
        };

        const [first] = buildSessionListRowViewModels({
            ...base,
            sessionTags: { [sessionKey]: ['alpha\u0001beta', 'gamma\u0002delta'] },
        });
        const [second] = buildSessionListRowViewModels({
            ...base,
            sessionTags: { [sessionKey]: ['alpha', 'beta\u0001gamma\u0002delta'] },
        });

        expect(first).not.toBe(second);
        expect(first?.tags).toEqual(['alpha\u0001beta', 'gamma\u0002delta']);
        expect(second?.tags).toEqual(['alpha', 'beta\u0001gamma\u0002delta']);
    });
    it('uses the qualified viewer audience instead of another Account or access-source list', () => {
        const item = { type: 'session', sessionId: 'audience-session', serverId: 'audience-home',
            storageKind: 'persisted', groupKey: 'group', groupKind: 'date' } satisfies SessionListIndexItem;
        const scope = { serverId: item.serverId, accountId: 'viewer' };
        const address = { serverId: item.serverId, teamId: 'team' };
        for (const [accountId, name] of [['viewer', 'Developers'], ['owner', 'Private owner group']]) {
            applyTeamGroupProjection({ scope: { ...scope, accountId }, address, observedAt: 1,
                group: { v: 1, id: 'group', teamId: 'team', name, description: null, archivedAt: null,
                    memberCount: 1, management: { kind: 'native' }, capabilities: NO_TEAM_GROUP_CAPABILITIES_V1 } });
        }
        const session = { ...createRenderableSession(item.sessionId), access: {
            role: 'recipient' as const, level: 'view' as const,
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }), sources: [],
            audienceContext: { kind: 'group' as const, teamId: 'team', groupId: 'group' },
        } };
        const input = { listItems: [item], reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), session]]),
            pinnedSessionKeys: new Set<string>(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false,
            audienceScopes: new Map([[scope.serverId, scope]]) };
        expect(buildSessionListRowViewModels(input)[0]?.subtitleOverride).toContain('Developers');
        expect(buildSessionListRowViewModels({ ...input, audienceScopes: new Map() })[0]?.subtitleOverride)
            .not.toContain('Developers');
    });

    it('retains detached runtime activity alongside a completed primary turn', () => {
        // The completed turn is not finished work while the runtime reports continuing background activity.
        const item = { type: 'session', sessionId: 'external-ready-background', serverId: 'server_a',
            storageKind: 'direct', groupKey: 'group-a', groupKind: 'date' } satisfies SessionListIndexItem;
        const session: SessionListRenderableSession = {
            ...createRenderableSession(item.sessionId), active: true, activeAt: 900,
            latestTurnStatus: 'completed', runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
            metadata: { path: '/repo', externalSessionV1: { v: 1, agentId: 'opencode', machineId: 'machine-a',
                remoteSessionId: 'native-session', source: { kind: 'opencodeServer', directory: '/repo' } } },
        };
        const [row] = buildSessionListRowViewModels({
            listItems: [item], reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), session]]), relativeNowMs: 1_000, runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false,
        });
        expect(row?.sessionStatus?.state).toBe('background_active');
        expect(row?.externalSessionRuntime?.detachedActivity).toBe('active');
    });

    it('projects contextual search provenance through the ordinary session-row subtitle', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_search_match',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'search:other-matches',
            groupKind: 'active',
            contextualSearchReasons: ['transcript', 'hidden-by-filters'] as const,
            contextualSearchSourceMachineId: 'machine-b',
        } satisfies SessionListIndexItem;
        const session = {
            ...createRenderableSession(item.sessionId),
            archivedAt: 123,
            metadata: {
                ...createRenderableSession(item.sessionId).metadata!,
                externalSessionV1: {
                    v: 1 as const,
                    agentId: 'opencode',
                    machineId: 'machine-a',
                    remoteSessionId: 'remote-session',
                    source: { kind: 'opencodeServer' as const, directory: '/repo/stable' },
                },
            },
        };

        const [row] = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), session]]),
            relativeNowMs: 1_000,
            runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(row?.subtitleOverride).toBe([
            t('sessionsList.searchMatchTranscript'),
            t('sessionsList.searchMatchHiddenByFilters'),
            t('sessionsList.searchMatchArchived'),
            t('sessionsList.searchMatchExternal'),
            t('sessionsList.searchMatchAnotherMachine'),
        ].join(' · '));
    });

    it('projects the repository-owned existing-session draft onto its exact row', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_with_draft',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const draft = { hasPreview: true };

        const row = buildSessionListRowViewModel({
            item,
            unscopedSelectionIsUnique: false,
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), createRenderableSession(item.sessionId)]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
            existingDraft: draft,
        });

        expect(row?.draft).toBe(draft);
    });

    it('keeps current-session selection derived only from selectedSessionId', () => {
        const firstItem = {
            type: 'session',
            sessionId: 'sess_selected_current',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const secondItem = {
            ...firstItem,
            sessionId: 'sess_not_current',
        } satisfies SessionListIndexItem;

        const rows = buildSessionListRowViewModels({
            listItems: [firstItem, secondItem],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([
                [rowKey(firstItem), createRenderableSession('sess_selected_current')],
                [rowKey(secondItem), createRenderableSession('sess_not_current')],
            ]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: 'sess_selected_current',
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows.map((row) => {
            expect(row).not.toBeNull();
            expect(row?.session).not.toBeNull();
            return [row?.session?.id, row?.selected];
        })).toEqual([
            ['sess_selected_current', true],
            ['sess_not_current', false],
        ]);
    });

    it('keeps consecutive rows under one heading in one sheet, even when their placement groups differ', () => {
        const session = (sessionId: string, groupKey: string) => ({
            type: 'session', sessionId, serverId: 'server_a', storageKind: 'persisted', groupKey, groupKind: 'date',
        }) satisfies SessionListIndexItem;
        const header = { type: 'header', title: 'Sessions', headerKind: 'date', groupKey: 'sessions' } as unknown as SessionListIndexItem;
        // A placement band (working) flows into the rest of the section with no heading between them.
        const items = [header, session('a', 'working'), session('b', 'working'), session('c', 'sessions'), header, session('d', 'other')];
        expect(items.map((_, index) => resolveSessionListRowViewModelAdjacency(items, index)).slice(1)).toEqual([
            { isFirst: true, isLast: false, isSingle: false },
            { isFirst: false, isLast: false, isSingle: false },
            { isFirst: false, isLast: true, isSingle: false },
            { isFirst: true, isLast: true, isSingle: true },
            { isFirst: true, isLast: true, isSingle: true },
        ]);
    });

    it('keeps rows in one sheet across a header that draws no heading, so no sheet is unlabeled', () => {
        const session = (sessionId: string) => ({
            type: 'session', sessionId, serverId: 'server_a', storageKind: 'persisted', groupKey: 'home', groupKind: 'project',
        }) satisfies SessionListIndexItem;
        const heading = { type: 'header', title: 'Home folder', headerKind: 'project', groupKey: 'home' } as unknown as SessionListIndexItem;
        const untitled = { type: 'header', title: '', headerKind: 'date', groupKey: 'home:older' } as unknown as SessionListIndexItem;
        const items = [heading, session('a'), untitled, session('b'), session('c')];
        expect([1, 3, 4].map((index) => resolveSessionListRowViewModelAdjacency(items, index))).toEqual([
            { isFirst: true, isLast: false, isSingle: false },
            { isFirst: false, isLast: false, isSingle: false },
            { isFirst: false, isLast: true, isSingle: false },
        ]);
    });

    it('keeps interleaved Sessions and workflow Runs in the same group sheet', () => {
        const session = (sessionId: string) => ({
            type: 'session', sessionId, serverId: 'server_a', storageKind: 'persisted', groupKey: 'home', groupKind: 'project',
        }) satisfies SessionListIndexItem;
        const heading = { type: 'header', title: 'Project', headerKind: 'project', groupKey: 'home' } satisfies SessionListIndexItem;
        const run = { type: 'workflow_run', runId: 'run-a', serverId: 'server_a', groupKey: 'home' } as const;
        const items: readonly SessionListIndexItem[] = [
            heading,
            session('before'),
            run,
            session('after'),
        ];
        expect([1, 2, 3].map((index) => resolveSessionListRowViewModelAdjacency(items, index))).toEqual([
            { isFirst: true, isLast: false, isSingle: false },
            { isFirst: false, isLast: false, isSingle: false },
            { isFirst: false, isLast: true, isSingle: false },
        ]);
    });

    it('selects only the exact Home-qualified row when session ids collide', () => {
        const firstItem = {
            type: 'session',
            sessionId: 'shared-session',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const secondItem = {
            ...firstItem,
            serverId: 'server_b',
            groupKey: 'group-b',
        } satisfies SessionListIndexItem;

        const rows = buildSessionListRowViewModels({
            listItems: [firstItem, secondItem],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([
                [rowKey(firstItem), createRenderableSession('shared-session')],
                [rowKey(secondItem), createRenderableSession('shared-session')],
            ]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: 'shared-session',
            selectedSessionServerId: 'server_b',
            showServerBadge: true,
            showPinnedServerBadge: false,
        });

        expect(rows.map((row) => row?.selected)).toEqual([false, true]);
    });

    it('reuses row view models when a session renderable is structurally unchanged', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_stability',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const first = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), session]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });
        const equivalentSession = {
            ...session,
            metadata: session.metadata ? { ...session.metadata } : null,
        };

        const second = buildSessionListRowViewModels({
            listItems: [{ ...item }],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), equivalentSession]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(second[0]).toBe(first[0]);
    });

    it('preserves the other 199 row identities when one work headline changes', () => {
        const listItems = Array.from({ length: 200 }, (_, index) => ({
            type: 'session', sessionId: `awareness-locality-${index}`, serverId: 'server_a',
            storageKind: 'persisted', groupKey: 'locality', groupKind: 'date',
        } satisfies SessionListSessionIndexItem));
        const sessions = listItems.map((item) => createRenderableSession(item.sessionId));
        const input = {
            listItems, reachableSessionDisplayById: new Map(),
            relativeNowMs: 1_000, runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set<string>(), sessionTags: {}, selectedSessionId: null,
            showServerBadge: false, showPinnedServerBadge: false,
        };
        const first = buildSessionListRowViewModels({ ...input,
            rowRenderableByKey: new Map(listItems.map((item, index) => [rowKey(item), sessions[index]!])),
        });
        const updatedSession: SessionListRenderableSession = { ...sessions[100]!, workDisplay: {
            v: 1, hasActiveGoal: false,
            primaryItem: { id: 'current', kind: 'task', status: 'paused', title: 'Review migration' },
        } };
        const second = buildSessionListRowViewModels({ ...input,
            rowRenderableByKey: new Map(listItems.map((item, index) => [rowKey(item), index === 100 ? updatedSession : sessions[index]!])),
        });
        expect(second[100]?.sessionStatus?.awareness?.currentWork?.title).toBe('Review migration');
        expect(second[100]).not.toBe(first[100]);
        expect(second.filter((row, index) => row === first[index])).toHaveLength(199);
    });

    it('preserves canonical working state and pulse without row-local animation policy', async () => {
        const { t } = await import('@/text');
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_working',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const input = {
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                active: true,
                thinking: true,
                thinkingAt: 900,
            }]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        } satisfies Parameters<typeof buildSessionListRowViewModels>[0];
        const rows = buildSessionListRowViewModels(input);
        expect(rows[0]?.sessionStatus).toMatchObject({
            state: 'thinking', isPulsing: true, statusText: t('status.working'),
        });
    });

    it('uses the optimistic pending first-turn expiration for list-row freshness refreshes', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_pending_first_turn',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const nowMs = 1_000_000;
        const optimisticThinkingAt = nowMs - 1_000;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                active: true,
                optimisticThinkingAt,
                pendingCount: 1,
            }]]),
            relativeNowMs: nowMs,
            runtimeNowMs: nowMs,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.sessionStatus?.state).toBe('thinking');
        expect(rows[0]?.nextRuntimeFreshnessAtMs).toBe(optimisticThinkingAt + SESSION_OPTIMISTIC_PENDING_THINKING_MS);
    });

    it('keeps pushed external-Agent status separate from hosted control and shares its expiry wake', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_external_observation',
            serverId: 'server_a',
            storageKind: 'direct',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const currentMachineDisplay = new Map([[item.sessionId, {
            machineId: 'machine-a',
            machineLabel: 'test.local',
            workspaceSubtitle: '~/stable',
            workspaceSubtitleEllipsizeMode: 'head' as const,
        }]]);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: currentMachineDisplay,
            rowRenderableByKey: new Map([[rowKey(item), {
                ...session,
                presence: 900,
                metadata: {
                    ...session.metadata!,
                    externalSessionV1: {
                        v: 1,
                        agentId: 'opencode',
                        machineId: 'machine-a',
                        remoteSessionId: 'native-session-1',
                        source: {
                            kind: 'opencodeServer',
                            directory: '/repo/stable',
                        },
                    },
                    externalAgentObservationV1: {
                        v: 1,
                        qualifiedLinkIdentity: {
                            v: 1,
                            agent: {
                                pluginId: 'happier.opencode',
                                localId: 'opencode',
                            },
                            source: {
                                kind: 'opencode.server',
                                contractVersion: 1,
                            },
                        },
                        linkGeneration: 'link-generation-1',
                        status: 'working',
                        observedAtMs: 900,
                        expiresAtMs: 1_100,
                    },
                },
            }]]),
            relativeNowMs: 1_000,
            runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect((rows[0] as any)?.externalSessionRuntime).toMatchObject({
            controlConnectivity: 'offline',
            detachedActivity: 'unknown',
            externalAgent: {
                state: 'working',
                labelKey: 'status.workingExternally',
            },
        });
        expect((rows[0] as any)?.externalSessionIdentity).toMatchObject({
            agentId: 'opencode',
            storageLabel: t('sessionsList.storageExternalFilter'),
            machineLabel: 'test.local',
            identityLabel: 'OpenCode',
            rowMetadataLabel: `${t('sessionsList.storageExternalFilter')} · OpenCode`,
        });
        expect(rows[0]?.nextRuntimeFreshnessAtMs).toBe(1_100);
        expect(rows[0]?.sessionStatus).toMatchObject({
            state: 'disconnected',
            isConnected: false,
        });

        const expiredRows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: currentMachineDisplay,
            rowRenderableByKey: new Map([[rowKey(item), rows[0]!.session!]]),
            relativeNowMs: 1_101,
            runtimeNowMs: 1_101,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect((expiredRows[0] as any)?.externalSessionRuntime).toMatchObject({
            controlConnectivity: 'offline',
            detachedActivity: 'unknown',
            externalAgent: {
                state: 'unknown',
                labelKey: 'status.externalStatusUnknown',
            },
        });
        expect(expiredRows[0]?.nextRuntimeFreshnessAtMs).toBeNull();
        expect(expiredRows[0]?.sessionStatus).toMatchObject({
            state: 'disconnected',
            isConnected: false,
        });
    });

    it('does not present malformed external-session-shaped metadata as a linked session', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_malformed_external',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const malformedSession = {
            ...session,
            metadata: {
                ...session.metadata!,
                externalSessionV1: { v: 1 },
            },
        } as unknown as SessionListRenderableSession;

        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([[rowKey(item), malformedSession]]),
            relativeNowMs: 1_000,
            runtimeNowMs: 1_000,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.externalSessionIdentity).toBeNull();
        expect(rows[0]?.externalSessionRuntime).toBeNull();
    });
});
