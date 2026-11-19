import { describe, expect, it } from 'vitest';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { hrefForDestinationRef, resolveCompactAppDestinations, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceActionAdapter } from './workspaceActions';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { resolveWorkspaceEntityDrop, resolveWorkspaceEntityHref, WORKSPACE_ENTITY_KINDS } from './workspaceEntityDrop';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { isWorkspaceActionId } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { EntityDropAdmissionV1Schema } from '@happier-dev/protocol/plugins/ui';
import { presentPaneDropAdmission } from '../splitCanvas/presentation/paneDropPresentation';
import { createWorkspaceDropScene } from './workspaceDropScene';
import { parseWorkspaceLayout, serializeWorkspaceLayout } from './workspacePersistence';
import { t } from '@/text';

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
        readCanvas: () => ({ readSplitMeasurement: () => ({ availableSizePx: 1400, minimumExistingSizePx: 400 }), resizeSplit: () => false }),
        createId: () => `id:${++sequence}` });
    return { workspace, catalog, execute };
}

describe('workspace entity Action admission', () => {
    it.each([
        [{ kind: 'artifact', scope, artifactId: 'report' }, '/artifacts/report'],
        [{ kind: 'session-board-item', scope, address: { serverId: 'home', sessionId: 'other' }, viewId: 'board', itemId: 'status' },
            '/session/other/details?serverId=home&details=board&boardItemId=status'],
    ] as const)('opens and restores the exact carried resource as a tab (%j)', (item, href) => {
        const h = harness();
        const drop = () => resolveWorkspaceEntityDrop({ ...h, scope, workspaceRefs: [], item,
            target: { leafId: 'group:1', placement: 'center' } });
        const decision = drop();
        expect(decision).toMatchObject({ status: 'allowed', effect: { actionId: 'workspace.tabs.open' } });
        if (decision.status !== 'allowed' || !isWorkspaceActionId(decision.effect.actionId)) throw new Error('Expected open Action');
        expect(WORKSPACE_ENTITY_KINDS).toContain(item.kind);
        expect(h.execute(decision.effect.actionId, decision.effect.input)).toEqual({ ok: true });
        expect(drop()).toMatchObject({ status: 'allowed', effect: { actionId: 'workspace.tabs.activate' } });
        const restored = parseWorkspaceLayout(JSON.parse(JSON.stringify(serializeWorkspaceLayout(h.workspace.state))));
        const tab = Object.values(restored?.tabs ?? {}).find(candidate => candidate.id !== 'anchor');
        expect(tab && hrefForDestinationRef(h.catalog, tab.target)).toBe(href);
    });

    it('refuses a carried Board item addressed to a different Home', () => {
        const h = harness();
        expect(resolveWorkspaceEntityHref({ kind: 'session-board-item', scope, address: { serverId: 'other', sessionId: 'same' },
            viewId: 'board', itemId: 'status' }, { ...h, scope, workspaceRefs: [] })).toBeNull();
    });

    it('honors an open-beside Action for an already-open destination', () => {
        const h = harness();
        expect(h.execute('workspace.tabs.open', { href: '/workflows/definition-1' })).toEqual({ ok: true });
        expect(h.execute('workspace.tabs.open', { href: '/workflows/definition-1', groupId: 'group:1', mode: 'splitRight' })).toEqual({ ok: true });
        expect(h.workspace.state.tabs.anchor.target.kind).toBe('session');
        expect(Object.keys(h.workspace.state.groups)).toHaveLength(2);
        expect(Object.values(h.workspace.state.tabs).filter(tab => tab.target.kind === 'workflow')).toHaveLength(1);
    });
    it('opens a Workflow beside the Session and splits an already-open destination instead of activating it', () => {
        const h = harness();
        expect(WORKSPACE_ENTITY_KINDS).toContain('workflow');
        const drop = () => resolveWorkspaceEntityDrop({ ...h, scope, workspaceRefs: [],
            item: { kind: 'workflow', scope, workflowId: 'definition-1' },
            target: { leafId: 'group:1', placement: 'right' }, availableSizePx: 1400, minimumExistingSizePx: 400 });
        const first = drop();
        if (first.status !== 'allowed' || !isWorkspaceActionId(first.effect.actionId)) throw new Error('Expected workspace effect');
        expect(h.execute(first.effect.actionId, first.effect.input)).toEqual({ ok: true });
        expect(h.workspace.state.tabs.anchor.target.kind).toBe('session');
        expect(Object.keys(h.workspace.state.groups)).toHaveLength(2);
        const second = drop();
        expect(second).toMatchObject({ status: 'allowed', effect: { actionId: 'workspace.split' } });
        if (second.status !== 'allowed' || !isWorkspaceActionId(second.effect.actionId)) throw new Error('Expected split effect');
        expect(h.execute(second.effect.actionId, second.effect.input)).toEqual({ ok: true });
        expect(h.workspace.state.tabs.anchor.target.kind).toBe('session');
        expect(Object.values(h.workspace.state.tabs).filter(tab => tab.target.kind === 'workflow')).toHaveLength(1);
    });
    it('uses the same live screen identity in drag scenes and gives unresolved nested Session screens the shared untitled fallback', () => {
        const h = harness();
        const ref = resolveDestinationRefFromHref(h.catalog, '/session/existing/info');
        if (!ref) throw new Error('Registered Session info destination required');
        h.workspace.dispatch({ type: 'setTarget', tabId: 'anchor', target: ref });
        h.workspace.dispatch({ type: 'setFallbackTitle', tabId: 'anchor', title: t('tabs.sessions') });
        const scene = (title: string | null) => createWorkspaceDropScene(h.workspace.state, h.catalog, {
            paneId: 'group:1', destinationTitles: { anchor: { ref, title } },
        });
        expect(scene('Atlas review').paneTitle).toBe('Atlas review');
        expect(scene('Atlas renamed').locateTab('anchor')).toEqual({ paneId: 'group:1', title: 'Atlas renamed' });
        // An unpublished Session screen is named by the destination catalog's one fallback, not by its stale tab label.
        expect(scene(null).paneTitle).toBe(t('session.untitled'));
        expect(scene(null).locateTab('anchor')).toEqual({ paneId: 'group:1', title: t('session.untitled') });
        expect(createWorkspaceDropScene(h.workspace.state, h.catalog, { paneId: 'group:1' }).paneTitle).toBe(t('session.untitled'));
    });
    it('applies an existing tab edge drop beside the hovered pane rather than its source pane', () => {
        const h = harness();
        h.workspace.dispatch({ type: 'openTab', groupId: 'group:1', tab: {
            id: 'neighbor', target: { kind: 'session', params: { id: 'neighbor-session', ...scope } }, pinned: false, preview: false,
        } });
        h.workspace.openHref('/inbox', { mode: 'splitRight', availableSizePx: 1400, minimumFirstSizePx: 400 });
        const target = Object.values(h.workspace.state.groups).find(group => group.id !== 'group:1')!;
        const decision = resolveWorkspaceEntityDrop({ ...h, scope, workspaceRefs: [],
            item: { kind: 'workspace-tab', scope, tabId: 'anchor' }, target: { leafId: target.id, placement: 'down' },
            availableSizePx: 900, minimumExistingSizePx: 100 });
        expect(decision.status).toBe('allowed');
        if (decision.status !== 'allowed' || !isWorkspaceActionId(decision.effect.actionId)) throw new Error('Expected workspace effect');
        expect(h.execute(decision.effect.actionId, decision.effect.input)).toEqual({ ok: true });
        expect(h.workspace.state.root).toMatchObject({ kind: 'split', second: { kind: 'split', axis: 'column', first: { id: target.id } } });
        expect(Object.values(h.workspace.state.tabs).filter(tab => tab.id === 'anchor')).toHaveLength(1);
    });
    it('refuses a repository file drop whose qualified checkout ID has multiple candidates', () => {
        const h = harness();
        const first = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        expect(resolveWorkspaceEntityHref({ kind: 'repository-file', scope, workspaceId: 'workspace',
            machineId: 'machine', path: 'README.md' }, { ...h, scope,
            workspaceRefs: [first, { ...first, rootPath: '/other' }] })).toBeNull();
    });
    it('splits destination and qualified repository-file drops through the same measured Action owner', () => {
        for (const item of [
            { kind: 'destination', scope, href: '/inbox' },
            { kind: 'repository-file', scope, workspaceId: 'workspace', machineId: 'machine', path: 'README.md' },
        ] as const) {
            const h = harness();
            const decision = resolveWorkspaceEntityDrop({ ...h, scope,
                workspaceRefs: [{ id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }],
                item, target: { leafId: 'group:1', placement: 'right' }, availableSizePx: 1400, minimumExistingSizePx: 400 });
            expect(decision).toMatchObject({ status: 'allowed', effect: { input: { mode: 'splitRight' } } });
            if (item.kind === 'repository-file') expect(decision).toMatchObject({ effect: { input: { file: {
                target: { kind: 'project', workspaceRefId: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/repo' }, path: 'README.md' } } } });
            if (decision.status !== 'allowed' || !isWorkspaceActionId(decision.effect.actionId)) throw new Error('Expected workspace effect');
            expect(h.execute(decision.effect.actionId, decision.effect.input)).toEqual({ ok: true });
            expect(h.workspace.state.root.kind).toBe('split');
            expect(Object.values(h.workspace.state.tabs).map(tab => tab.target.kind)).toEqual(['session', item.kind === 'destination' ? 'inbox' : 'project']);
        }
    });
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
            item: { kind: 'session', scope, address: { serverId: 'home', sessionId: 'existing' } }, target: { leafId: 'group:1', placement: 'center' } });
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
