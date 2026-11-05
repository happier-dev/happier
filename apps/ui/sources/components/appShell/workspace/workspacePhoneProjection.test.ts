import { describe, expect, it } from 'vitest';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceTab } from './workspaceState';
import { projectWorkspacePhoneTabs, resolvePhoneWorkspaceTabHref } from './workspacePhoneProjection';
import { resolveCompactAppDestinations, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import { buildWorkspaceFileLink } from '@/utils/url/sessionFileDeepLink';
import { parseWorkspaceLayout, serializeWorkspaceLayout } from './workspacePersistence';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';

const tab = (id: string, kind: string): WorkspaceTab => ({ id, target: { kind, params: { id, serverId: 'home-a' } },
    pinned: false, preview: false });

describe('workspace phone projection', () => {
    it.each(['chat', 'files', 'git'])('keeps the unaddressed Session on its existing instance (%s)', surface => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, friends: false, workflows: false } });
        expect(resolvePhoneWorkspaceTabHref(catalog, `/session/s1?serverId=home-a&mobileSurface=${surface}`))
            .toBe('/session/s1?serverId=home-a');
    });
    it('presents the canonical file intent as its own phone Details page, preserving the addressed file and Home', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, friends: false, workflows: false } });
        const href = buildWorkspaceFileLink({ target: { kind: 'session', sessionId: 's1', serverId: 'home-a' },
            path: 'src/alpha.ts', view: 'changes', anchor: { kind: 'fileLine', startLine: 7 } });
        const projected = resolvePhoneWorkspaceTabHref(catalog, `${href}&fileOpenAs=pinned`)!;
        expect(resolveDestinationRefFromHref(catalog, projected)).toMatchObject({ kind: 'sessionDetails', params: {
            id: 's1', serverId: 'home-a', details: 'file', path: 'src/alpha.ts', fileView: 'changes', fileOpenAs: 'pinned', startLine: '7',
        } });
    });
    it('presents an addressed Git Review intent as its own phone Details page instead of the Session transcript', () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, friends: false, workflows: false } });
        const review = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree', comparisonId: 'pending' }, view: 'walkthrough' });
        const query = new URLSearchParams({ serverId: 'home-a', right: 'git', ...buildActiveDetailsRouteParams([review], review.key) });
        const projected = resolvePhoneWorkspaceTabHref(catalog, `/session/s1?${query}`)!;
        expect(resolveDestinationRefFromHref(catalog, projected)).toMatchObject({ kind: 'sessionDetails', params: {
            id: 's1', serverId: 'home-a', details: 'scmReview',
        } });
    });
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
