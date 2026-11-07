import { describe, expect, it } from 'vitest';
import { admitWorkspaceSingletonState, normalizeWorkspaceSingletonTabs, workspaceDestinationAdmissionIdentity } from './workspaceDestinationPolicy';
import type { CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { reconcileWorkspaceSyncedTabs, type SharedWorkspaceTabs } from './workspaceSyncedTabs';

describe('workspace destination admission', () => {
    it('uses the catalog resource identity for navigation and portable rebase, excluding in-tab state and index qualifiers', () => {
        const catalog = [{ id: 'resources', kind: 'builtin', title: 'Resources', icon: 'desktop', order: 0,
            placement: { kind: 'rail', region: 'account' }, activation: 'navigate', availability: 'available', routePath: '/resources',
            workspaceNavigationIdentity: { resourceParam: 'id', scopeParams: ['serverId'] },
        }] satisfies readonly CompactAppDestination[];
        const identity = (params: Record<string, string>) => workspaceDestinationAdmissionIdentity({ kind: 'resources', params }, catalog);
        expect(identity({ id: 'a', serverId: 'home', page: 'agents', workspacePathname: '/resources/a/agents' }))
            .toBe(identity({ id: 'a', serverId: 'home', page: 'details' }));
        expect(identity({ id: 'a', serverId: 'home' })).not.toBe(identity({ id: 'b', serverId: 'home' }));
        expect(identity({ id: 'a', serverId: 'home' })).not.toBe(identity({ id: 'a', serverId: 'other-home' }));
        expect(identity({})).toBe(identity({ serverId: 'home' }));
        expect(identity({})).not.toBe(identity({ id: 'a', serverId: 'home' }));
    });

    it('preserves explicit workflow instances, distinct definitions, runs and Homes', () => {
        const record: SharedWorkspaceTabs = { v: 1, order: ['first', 'other', 'duplicate', 'run', 'other-home', 'session'], pairs: [['duplicate', 'other']], tabsById: {
            first: { id: 'first', target: { kind: 'workflow', params: { id: 'workflow-1', serverId: 'home-a' } }, pinned: false },
            other: { id: 'other', target: { kind: 'workflow', params: { id: 'workflow-2' } }, pinned: false },
            duplicate: { id: 'duplicate', target: { kind: 'workflow', params: { serverId: 'home-a', id: 'workflow-1' } }, pinned: true },
            run: { id: 'run', target: { kind: 'workflowRun', params: { runId: 'run-1' } }, pinned: false },
            'other-home': { id: 'other-home', target: { kind: 'workflow', params: { id: 'workflow-1', serverId: 'home-b' } }, pinned: false },
            session: { id: 'session', target: { kind: 'session', params: { id: 'session-1' } }, pinned: false },
        } };
        const normalized = normalizeWorkspaceSingletonTabs(record, []);
        expect(normalized).toBe(record);
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
        expect(Object.values(admitted.tabs).filter(tab => tab.target.kind === 'workflow')).toHaveLength(2);
        expect(admitted.tabs.duplicate).toMatchObject({ pinned: false, preview: source === 'restore' });
        expect(admitted.tabs.first).toMatchObject({ pinned: true, preview: false });
        expect(admitted.tabs.session).toEqual(session);
        expect(admitted.groups[admitted.focusedGroupId].activeTabId).toBe(source === 'restore' ? 'duplicate' : 'session');
        expect(admitted.recentlyClosed).toEqual([]);
        expect(admitWorkspaceSingletonState(admitted, [], () => 'blank')).toBe(admitted);
    });

    it('preserves an explicitly split instance of a Workflow in its own pane', () => {
        const first = { id: 'first', target: { kind: 'workflow', params: { id: 'workflow-1' } }, pinned: false, preview: false };
        const duplicate = { ...first, id: 'duplicate' };
        let state = reduceWorkspaceState(createWorkspaceState(first), { type: 'openTab', groupId: 'group:1', tab: duplicate });
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'duplicate', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const admitted = admitWorkspaceSingletonState(state, [], () => 'blank');
        expect(admitted.groups[admitted.focusedGroupId].activeTabId).toBe('duplicate');
        expect(admitted.tabs.first).toEqual(first);
        expect(admitted.tabs.duplicate).toEqual(duplicate);
        expect(Object.keys(admitted.groups)).toHaveLength(2);
        expect(admitted.recentlyClosed).toEqual([]);
    });
});
