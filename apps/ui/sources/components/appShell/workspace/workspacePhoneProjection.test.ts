import { describe, expect, it } from 'vitest';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceTab } from './workspaceState';
import { projectWorkspacePhoneTabs, resolvePhoneWorkspaceTabHref } from './workspacePhoneProjection';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { parseWorkspaceLayout, serializeWorkspaceLayout } from './workspacePersistence';

const tab = (id: string, kind: string): WorkspaceTab => ({ id, target: { kind, params: { id, serverId: 'home-a' } },
    pinned: false, preview: false });

describe('workspace phone projection', () => {
    it.each(['info', 'follow', 'permissions', 'runs', 'triggers', 'automations', 'runs/run-a'])('retains the requested Session leaf %s and Home', leaf => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, friends: false, workflows: true } });
        const href = `/session/session-a/${leaf}?serverId=home-a`;
        expect(resolvePhoneWorkspaceTabHref(catalog, href)).toBe(href);
    });
    it('keeps main-tab collection links out of tabs without mistaking archived for a Session id', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, friends: false, workflows: true } });
        expect(resolvePhoneWorkspaceTabHref(catalog, '/session/archived')).toBeNull();
        expect(resolvePhoneWorkspaceTabHref(catalog, '/inbox')).toBeNull();
        expect(resolvePhoneWorkspaceTabHref(catalog, '/inbox/approvals/request-a?serverId=home-a')).toBe('/inbox/approvals/request-a?serverId=home-a');
    });
    it('retains the exact Project page, Home, checkout, dashboard and resource destination', () => {
        const href = '/projects/project-a/context?serverId=home-a&worktreeId=checkout-a&layoutId=dashboard-a&initialFile=src%2Fa.ts&comparisonId=comparison-a';
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, friends: false, workflows: false } });
        expect(resolvePhoneWorkspaceTabHref(catalog, href)).toBe(href);
    });
    it('restores a mixed pair from the local layout when account tab sync is off', () => {
        let state = createWorkspaceState(tab('a', 'session'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b', 'plugin:acme.page') });
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1',
            targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const restored = parseWorkspaceLayout(JSON.parse(JSON.stringify(serializeWorkspaceLayout(state))))!;
        expect(projectWorkspacePhoneTabs(restored).map((row) => row.panes.map((pane) => pane.target.kind)))
            .toEqual([['session', 'plugin:acme.page']]);
    });
    it('keeps mixed destination kinds and projects paired pane membership without copying their identities', () => {
        const a = tab('a', 'session');
        const b = tab('b', 'sessionDetails');
        const c = tab('c', 'plugin:acme.page');
        let state = createWorkspaceState(a);
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: b });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: c });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'b' });
        const projected = projectWorkspacePhoneTabs(state, [['a', 'b']]);
        expect(projected.map((row) => [row.id, row.panes.map((pane) => pane.id), row.activeTabId]))
            .toEqual([['a', ['a', 'b'], 'b'], ['c', ['c'], 'c']]);
        expect(projected[0].panes[0]).toBe(state.tabs.a);
        expect(projected[0].panes[1]).toBe(state.tabs.b);
        expect(projected[1].panes[0]).toBe(state.tabs.c);
    });

    it('drops removed members and preserves unknown destinations as individual unavailable tabs', () => {
        const state = reduceWorkspaceState(createWorkspaceState(tab('a', 'removed:unknown')),
            { type: 'openTab', groupId: 'group:1', tab: tab('b', 'settings') });
        const projected = projectWorkspacePhoneTabs(state, [['missing', 'a'], ['a', 'b']]);
        expect(projected.map((row) => row.panes.map((pane) => pane.id))).toEqual([['a'], ['b']]);
        expect(projected[0].panes[0].target.kind).toBe('removed:unknown');
    });
});
