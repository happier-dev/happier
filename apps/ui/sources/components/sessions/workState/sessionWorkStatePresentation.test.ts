import { describe, expect, it } from 'vitest';

import {
    formatSessionWorkStateBadgeLabel,
    readSessionWorkStateFromMetadata,
    resolveActiveSessionGoalItem,
    resolvePrimarySessionWorkStateItem,
    resolveSessionWorkStateStatusBadgePresentation,
} from './sessionWorkStatePresentation';

const translate = (key: string, params?: Record<string, unknown>) => `${key}:${params?.title ?? ''}`;

function snapshotWithGoal(status: string) {
    return readSessionWorkStateFromMetadata({
        sessionWorkStateV1: {
            v: 1,
            backendId: 'claude',
            updatedAt: 10,
            items: [
                { id: 'goal:claude', kind: 'goal', origin: 'vendor', status, title: 'Ship goals', updatedAt: 10 },
            ],
        },
    });
}

describe('sessionWorkStatePresentation goalCapabilities + active selector', () => {
    it('parses provider goalCapabilities onto the goal item', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'claude',
                updatedAt: 10,
                items: [
                    {
                        id: 'goal:claude',
                        kind: 'goal',
                        origin: 'vendor',
                        status: 'active',
                        title: 'Ship goals',
                        updatedAt: 10,
                        goalCapabilities: { canEdit: true, canClear: true },
                    },
                ],
            },
        });
        const goal = snapshot?.items.find((item) => item.kind === 'goal');
        expect(goal?.goalCapabilities).toEqual({ canEdit: true, canClear: true });
    });

    it('omits goalCapabilities when none are provided (Codex legacy stays full-control)', () => {
        const snapshot = snapshotWithGoal('active');
        expect(snapshot?.items[0]?.goalCapabilities).toBeUndefined();
    });

    it('returns only the active goal as the current goal', () => {
        expect(resolveActiveSessionGoalItem(snapshotWithGoal('active'))?.title).toBe('Ship goals');
    });

    it('does not treat completed, cancelled, or paused goals as the current goal', () => {
        expect(resolveActiveSessionGoalItem(snapshotWithGoal('complete'))).toBeNull();
        expect(resolveActiveSessionGoalItem(snapshotWithGoal('cancelled'))).toBeNull();
        expect(resolveActiveSessionGoalItem(snapshotWithGoal('paused'))).toBeNull();
    });
});

describe('sessionWorkStatePresentation', () => {
    it('reads canonical sessionWorkStateV1 metadata and resolves primaryItemId first', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:codex',
                items: [
                    { id: 'todo:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Run tests', updatedAt: 9 },
                    { id: 'goal:codex', kind: 'goal', origin: 'vendor', status: 'active', title: 'Migrate plugin support', updatedAt: 10 },
                ],
            },
        });

        const primary = resolvePrimarySessionWorkStateItem(snapshot);
        expect(primary?.id).toBe('goal:codex');
        expect(formatSessionWorkStateBadgeLabel(primary, translate)).toBe('session.workState.badge.goal:Migrate plugin support');
    });

    it('renders no badge label for a cancelled (cleared) goal so a cleared goal is not shown as current', () => {
        // A cleared/cancelled goal means "no active goal" (mirrors happy's resolveVisibleAgentGoalStatus,
        // which only shows active goals). Without this it fell through to the active "Goal: <title>"
        // label, leaving a cleared goal looking active after the user cleared it (manual-QA-found).
        const cancelledGoal = {
            id: 'goal:claude', kind: 'goal', origin: 'vendor', status: 'cancelled', title: 'Refactor everything', updatedAt: 10,
        } as const;
        expect(formatSessionWorkStateBadgeLabel(cancelledGoal, translate)).toBeNull();
    });

    it('produces no status badge when the primary item is a cancelled goal', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:claude', kind: 'goal', origin: 'vendor', status: 'cancelled', title: 'Refactor everything', updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });
        expect(presentation).toBeNull();
    });

    it('does not trust a completed primaryItemId over a present active item (G4 read-side consistency)', () => {
        // Even if a stale/legacy snapshot still points primaryItemId at a now-completed task, the
        // reader must not pin the badge on it while an active goal exists — mirroring the protocol
        // write-side resolver's status-rank rule so read and write agree.
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'claude',
                updatedAt: 10,
                primaryItemId: 'task:1',
                items: [
                    { id: 'task:1', kind: 'task', origin: 'vendor', status: 'complete', title: 'Done work', updatedAt: 9 },
                    { id: 'goal:1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Active goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:1');
    });

    it('still surfaces a completed primary when every item is terminal (history badge)', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'claude',
                updatedAt: 10,
                primaryItemId: 'goal:1',
                items: [
                    { id: 'task:1', kind: 'task', origin: 'vendor', status: 'cancelled', title: 'Cancelled', updatedAt: 9 },
                    { id: 'goal:1', kind: 'goal', origin: 'vendor', status: 'complete', title: 'Completed goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:1');
    });

    it('falls back defensively when primaryItemId is stale', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'opencode',
                updatedAt: 10,
                primaryItemId: 'missing',
                items: [
                    { id: 'goal:1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Goal text', updatedAt: 8 },
                    { id: 'todo:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Update permissions', updatedAt: 9 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('todo:1');
    });

    it('ignores malformed canonical metadata safely', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                items: [
                    { id: '', kind: 'goal', origin: 'vendor', status: 'active', title: 'Missing id', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('normalizes legacy goal metadata only at the read edge', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            flavor: 'codex',
            sessionGoalV1: {
                objective: 'Ship goals',
                status: 'paused',
                updatedAt: 12,
            },
        });

        expect(snapshot?.backendId).toBe('codex');
        expect(snapshot?.items[0]).toEqual(expect.objectContaining({
            id: 'goal:legacy',
            kind: 'goal',
            status: 'paused',
            title: 'Ship goals',
        }));
    });

    it('keeps displayable canonical items when future items are preserved in metadata', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:thread-1',
                items: [
                    { id: 'future:1', kind: 'milestone', origin: 'future', status: 'waiting', title: 'Future item', updatedAt: 10 },
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:thread-1');
    });

    it('keeps displayable canonical items when future items use a different item shape', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 10,
                primaryItemId: 'goal:thread-1',
                items: [
                    { id: 'future:1', label: 'Future item', state: 'waiting' },
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        });

        expect(resolvePrimarySessionWorkStateItem(snapshot)?.id).toBe('goal:thread-1');
    });

    it('ignores canonical metadata with invalid root timestamps', () => {
        expect(readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: -1,
                items: [
                    { id: 'goal:thread-1', kind: 'goal', origin: 'vendor', status: 'active', title: 'Known goal', updatedAt: 10 },
                ],
            },
        })).toBeNull();
    });

    it('keeps a transient editable goal badge anchor when /goal opens without existing work state', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: null,
            activeStatusBadgeKey: 'work-state',
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.goal.title:',
            tone: 'neutral',
            emphasis: 'quiet',
        });
    });

    it('does not render a transient goal badge when goal editing is unavailable', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: null,
            activeStatusBadgeKey: 'work-state',
            editableGoal: false,
            translate,
        });

        expect(presentation).toBeNull();
    });

    it('uses quiet emphasis for ordinary active work state so it stays visible without badge chrome', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'active',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goal:Ship the release',
            tone: 'active',
            emphasis: 'quiet',
        });
    });

    it('uses prominent emphasis for blocked work state that needs attention', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'blocked',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goalBlocked:',
            tone: 'warning',
            emphasis: 'prominent',
        });
    });

    /**
     * Fill in the composer status row means exactly one thing: a person is needed. `blocked` and
     * `paused` qualify — both wait on a human decision. A completed goal does not: nothing is asked
     * of anybody, and filling it makes the composer announce a success, which is the one thing the
     * status row must never do (it would fire several times a day and train the fill to mean
     * nothing). It keeps its success tone; it loses the chrome that demands attention.
     */
    it('does not fill a completed goal — fill is reserved for work that needs a person', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'complete',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goalComplete:',
            tone: 'complete',
            emphasis: 'quiet',
        });
    });

    it('still fills a paused goal, which waits on a person to resume it', () => {
        const presentation = resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: {
                id: 'goal:thread-1',
                kind: 'goal',
                origin: 'vendor',
                status: 'paused',
                title: 'Ship the release',
                updatedAt: 10,
            },
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        });

        expect(presentation).toEqual({
            itemKind: 'goal',
            label: 'session.workState.badge.goalPaused:',
            tone: 'paused',
            emphasis: 'prominent',
        });
    });

    it('preserves parentId and progress on work-state items for workflow correlation (W2)', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'claude',
                updatedAt: 10,
                items: [
                    {
                        id: 'task:child', kind: 'task', origin: 'vendor', status: 'active', title: 'Subagent task', updatedAt: 10,
                        parentId: 'workflow:run-1', progress: 0.5,
                    },
                ],
            },
        });
        expect(snapshot?.items[0]).toEqual(expect.objectContaining({ parentId: 'workflow:run-1', progress: 0.5 }));
    });

    it('drops an out-of-range progress and an empty parentId (W2 fail-safe)', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'claude',
                updatedAt: 10,
                items: [
                    {
                        id: 'task:child', kind: 'task', origin: 'vendor', status: 'active', title: 'Subagent task', updatedAt: 10,
                        parentId: '   ', progress: 2,
                    },
                ],
            },
        });
        expect(snapshot?.items[0]?.parentId).toBeUndefined();
        expect(snapshot?.items[0]?.progress).toBeUndefined();
    });

    it('preserves the snapshot-level truncated marker (W2)', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'claude',
                updatedAt: 10,
                truncated: { reason: 'item_limit', omittedCount: 3 },
                items: [
                    { id: 'task:1', kind: 'task', origin: 'vendor', status: 'active', title: 'A task', updatedAt: 10 },
                ],
            },
        });
        expect(snapshot?.truncated).toEqual({ reason: 'item_limit', omittedCount: 3 });
    });

    it('preserves precise budget-limited status reason and time fields from canonical metadata', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 20,
                primaryItemId: 'goal:thread-1',
                items: [
                    {
                        id: 'goal:thread-1',
                        kind: 'goal',
                        origin: 'vendor',
                        status: 'blocked',
                        statusReason: 'budgetLimited',
                        title: 'Ship budget display',
                        createdAt: 11,
                        startedAt: 12,
                        completedAt: 19,
                        updatedAt: 20,
                    },
                ],
            },
        });

        expect(snapshot?.items[0]).toEqual(expect.objectContaining({
            status: 'blocked',
            statusReason: 'budgetLimited',
            createdAt: 11,
            startedAt: 12,
            completedAt: 19,
        }));
        expect(formatSessionWorkStateBadgeLabel(snapshot?.items[0] ?? null, translate)).toBe('session.workState.badge.goalBudgetLimited:');
    });

    it.each([
        ['blocked', 'session.workState.badge.goalBlocked:'],
        ['usageLimited', 'session.workState.badge.goalBlocked:'],
        ['budgetLimited', 'session.workState.badge.goalBudgetLimited:'],
    ] as const)('preserves the %s blocked-family reason without losing the warning presentation', (statusReason, expectedLabel) => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 20,
                primaryItemId: 'goal:thread-1',
                items: [{
                    id: 'goal:thread-1',
                    kind: 'goal',
                    origin: 'vendor',
                    status: 'blocked',
                    statusReason,
                    title: 'Ship blocked-family display',
                    updatedAt: 20,
                }],
            },
        });

        const goal = snapshot?.items[0] ?? null;
        expect(goal?.statusReason).toBe(statusReason);
        expect(formatSessionWorkStateBadgeLabel(goal, translate)).toBe(expectedLabel);
        expect(resolveSessionWorkStateStatusBadgePresentation({
            primaryItem: goal,
            activeStatusBadgeKey: null,
            editableGoal: true,
            translate,
        })).toEqual(expect.objectContaining({
            label: expectedLabel,
            tone: 'warning',
            emphasis: 'prominent',
        }));
    });

    it('drops an unknown future status reason while preserving the otherwise valid blocked item', () => {
        const snapshot = readSessionWorkStateFromMetadata({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 20,
                items: [{
                    id: 'goal:thread-1',
                    kind: 'goal',
                    origin: 'vendor',
                    status: 'blocked',
                    statusReason: 'futureReason',
                    title: 'Remain forward-compatible',
                    updatedAt: 20,
                }],
            },
        });

        expect(snapshot?.items[0]).toEqual(expect.objectContaining({ status: 'blocked' }));
        expect(snapshot?.items[0]?.statusReason).toBeUndefined();
    });
});
