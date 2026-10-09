import { describe, expect, it } from 'vitest';
import { admitWorkspaceSingletonState, normalizeWorkspaceSingletonTabs } from './workspaceDestinationPolicy';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { reconcileWorkspaceSyncedTabs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';

describe('workspace destination admission', () => {
    it('contracts identical workflow destinations while retaining other definitions, runs, Homes and non-workflow tabs', () => {
        const record: SharedWorkspaceTabs = { v: 1, order: ['first', 'other', 'duplicate', 'run', 'other-home', 'session'], pairs: [['duplicate', 'other']], tabsById: {
            first: { id: 'first', target: { kind: 'workflow', params: { id: 'workflow-1', serverId: 'home-a' } }, pinned: false },
            other: { id: 'other', target: { kind: 'workflow', params: { id: 'workflow-2' } }, pinned: false },
            duplicate: { id: 'duplicate', target: { kind: 'workflow', params: { serverId: 'home-a', id: 'workflow-1' } }, pinned: true },
            run: { id: 'run', target: { kind: 'workflowRun', params: { runId: 'run-1' } }, pinned: false },
            'other-home': { id: 'other-home', target: { kind: 'workflow', params: { id: 'workflow-1', serverId: 'home-b' } }, pinned: false },
            session: { id: 'session', target: { kind: 'session', params: { id: 'session-1' } }, pinned: false },
        } };
        const normalized = normalizeWorkspaceSingletonTabs(record, []);
        expect(normalized.order).toEqual(['first', 'other', 'run', 'other-home', 'session']);
        expect(normalized.tabsById.first).toMatchObject({ pinned: true, target: record.tabsById.duplicate.target });
        expect(normalized.pairs).toEqual([['first', 'other']]);
        expect(normalizeWorkspaceSingletonTabs(normalized, [])).toBe(normalized);
    });

    it.each(['restore', 'sync'] as const)('admits duplicate workflow details from %s while preserving intentional disposition and unrelated state', source => {
        const first = { id: 'first', target: { kind: 'workflow', params: { id: 'workflow-1' } }, pinned: true, preview: false };
        const duplicate = { ...first, id: 'duplicate', pinned: false, preview: true };
        const session = { id: 'session', target: { kind: 'session', params: { id: 'session-1' } }, pinned: false, preview: false };
        let state = reduceWorkspaceState(createWorkspaceState(first), { type: 'openTab', groupId: 'group:1', tab: session });
        if (source === 'restore') state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: duplicate });
        else state = reconcileWorkspaceSyncedTabs(state, { v: 1, order: ['first', 'session', 'duplicate'], pairs: [],
            tabsById: { first, session, duplicate } }, () => 'blank');
        const admitted = admitWorkspaceSingletonState(state, [], () => 'blank');
        expect(Object.values(admitted.tabs).filter(tab => tab.target.kind === 'workflow')).toHaveLength(1);
        expect(admitted.tabs.first).toMatchObject({ pinned: source === 'restore', preview: false });
        expect(admitted.tabs.session).toEqual(session);
        expect(admitted.groups[admitted.focusedGroupId].activeTabId).toBe(source === 'restore' ? 'first' : 'session');
        expect(admitted.recentlyClosed).toEqual([]);
        expect(admitWorkspaceSingletonState(admitted, [], () => 'blank')).toBe(admitted);
    });

    it('keeps the focused workflow visible when its duplicate is retired from another pane', () => {
        const first = { id: 'first', target: { kind: 'workflow', params: { id: 'workflow-1' } }, pinned: false, preview: false };
        const duplicate = { ...first, id: 'duplicate' };
        let state = reduceWorkspaceState(createWorkspaceState(first), { type: 'openTab', groupId: 'group:1', tab: duplicate });
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'duplicate', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const admitted = admitWorkspaceSingletonState(state, [], () => 'blank');
        expect(admitted.groups[admitted.focusedGroupId].activeTabId).toBe('first');
        expect(admitted.tabs.duplicate).toBeUndefined();
        expect(admitted.recentlyClosed).toEqual([]);
    });
});
