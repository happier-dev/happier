import { describe, expect, it } from 'vitest';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceActionAdapter } from './workspaceActions';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { resolveWorkspaceEntityDrop } from './workspaceEntityDrop';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { isWorkspaceActionId } from '@happier-dev/protocol';
import { EntityDropAdmissionV1Schema } from '@happier-dev/protocol/plugins/ui';
import { presentPaneDropAdmission } from '../splitCanvas/presentation/paneDropPresentation';
import { createWorkspaceDropScene } from './workspaceDropScene';

installPanelCommonModuleMocks();
const scope = { serverId: 'home', accountId: 'account' };

function harness() {
    let state = createWorkspaceState({ id: 'anchor', target: { kind: 'session', params: { id: 'existing', ...scope } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } });
    let sequence = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `id:${++sequence}`,
        transport: { commit: () => {} }, onChange: () => {} });
    const workspace: WorkspaceNavigationContextValue = { active: true, get state() { return state; }, catalog,
        findOpenHref: navigation.findOpenHref, openHref: navigation.openHref, dispatch: navigation.dispatch,
        activateTab: navigation.activateTab, closeTab: navigation.closeTab, closeTabs: navigation.closeTabs,
        canGoBack: false, canGoForward: false, back: () => {}, forward: () => {},
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {},
    };
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation,
        readCanvas: () => null, createId: () => `id:${++sequence}` });
    return { workspace, catalog, execute };
}

describe('workspace entity Action admission', () => {
    it('opens a kept destination before its semantic anchor and focuses an already-open qualified Session', () => {
        const h = harness();
        const decision = resolveWorkspaceEntityDrop({ ...h, scope, workspaceRefs: [],
            item: { kind: 'destination', scope, href: '/inbox' }, target: { leafId: 'group:1', placement: 'center' }, beforeTabId: 'anchor' });
        const admission = presentPaneDropAdmission(decision, createWorkspaceDropScene(h.workspace.state, h.catalog,
            { paneId: 'group:1', beforeTabId: 'anchor' }));
        expect(EntityDropAdmissionV1Schema.safeParse(admission).success).toBe(true);
        expect(admission.status).toBe('allowed');
        if (admission.status !== 'allowed' || !isWorkspaceActionId(admission.effect.actionId)) throw new Error('Expected workspace effect');
        expect(h.execute(admission.effect.actionId, admission.effect.input)).toEqual({ ok: true });
        expect(h.workspace.state.groups['group:1'].tabIds.at(-1)).toBe('anchor');
        expect(Object.values(h.workspace.state.tabs).find(tab => tab.target.kind === 'inbox')).toMatchObject({ preview: false });
        const existing = resolveWorkspaceEntityDrop({ ...h, scope, workspaceRefs: [],
            item: { kind: 'session', scope, address: { serverId: 'home', sessionId: 'existing' } }, target: { leafId: 'group:1', placement: 'right' } });
        expect(existing).toMatchObject({ status: 'allowed', effect: { actionId: 'workspace.tabs.activate', input: { tabId: 'anchor' } } });
        expect(Object.values(h.workspace.state.tabs).filter(tab => tab.target.kind === 'session')).toHaveLength(1);
    });

    it('refuses another Account, own-pane moves and a split whose unequal minimum does not fit a half', () => {
        const h = harness();
        const base = { ...h, scope, workspaceRefs: [], target: { leafId: 'group:1', placement: 'center' } } as const;
        expect(resolveWorkspaceEntityDrop({ ...base, item: { kind: 'workspace-tab', scope: { ...scope, accountId: 'other' }, tabId: 'anchor' } }))
            .toMatchObject({ status: 'refused', reason: { code: 'workspace_scope_unavailable' } });
        expect(resolveWorkspaceEntityDrop({ ...base, item: { kind: 'workspace-tab', scope, tabId: 'anchor' } }))
            .toMatchObject({ status: 'refused', reason: { code: 'workspace_tab_already_here' } });
        expect(resolveWorkspaceEntityDrop({ ...base, item: { kind: 'destination', scope, href: '/inbox' },
            target: { leafId: 'group:1', placement: 'right' }, availableSizePx: 1200, minimumExistingSizePx: 700 }))
            .toMatchObject({ status: 'refused', reason: { code: 'workspace_split_unavailable' } });
    });

    it('refuses unchanged strip slots and distinguishes a sole tab over its own pane edge', () => {
        const h = harness();
        const base = { ...h, scope, workspaceRefs: [], item: { kind: 'workspace-tab', scope, tabId: 'anchor' },
            target: { leafId: 'group:1', placement: 'center' } } as const;
        expect(resolveWorkspaceEntityDrop({ ...base, target: { ...base.target, placement: 'right' },
            availableSizePx: 1200, minimumExistingSizePx: 400 }))
            .toMatchObject({ status: 'refused', reason: { code: 'workspace_tab_cannot_split_own_pane' } });
        h.workspace.dispatch({ type: 'openTab', groupId: 'group:1', tab: {
            id: 'neighbor', target: { kind: 'inbox', params: {} }, pinned: false, preview: false,
        } });
        const current = h.workspace.state;
        for (const beforeTabId of ['anchor', 'neighbor']) {
            expect(resolveWorkspaceEntityDrop({ ...base, beforeTabId }))
                .toMatchObject({ status: 'refused', reason: { code: 'workspace_tab_already_here' } });
        }
        expect(h.workspace.state).toBe(current);
        expect(resolveWorkspaceEntityDrop({ ...base, beforeTabId: null }))
            .toMatchObject({ status: 'allowed', effect: { actionId: 'workspace.tabs.reorder' } });
    });
});
