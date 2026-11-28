import { describe, expect, it } from 'vitest';

import { resolveMainTabPressRoute, resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

type ChromeInput = Parameters<typeof resolveMobileBottomChromeModel>[0];

function createChromeInput(overrides: Partial<ChromeInput> = {}): ChromeInput {
    return { isAuthenticated: true, pathname: '/', mobileWorkspaceExperience: 'classic', ...overrides };
}

const sessionDetail = (activeId: string) => ({ pageKind: 'session', identity: 'mounted-session', activeId });

describe('resolveMobileBottomChromeModel', () => {
    it('reserves the entry bar on a cold PR route claimed by a main tab', () => {
        const root = '/plugins/happier.triage/triage';
        const pathname = `${root}/e%2Chappier.scm.forge.github%2Cgithub-forge%2Cpull-request%2Cgithub%253A1424792902%2C54`;
        const base = createChromeInput({ pathname, sectionPage: true, mobileWorkspaceExperience: 'cockpit' });
        expect(resolveMobileBottomChromeModel(base)).toEqual({ kind: 'detailPending' });
        expect(resolveMobileBottomChromeModel({ ...base, mobileWorkspaceExperience: 'classic' })).toEqual({ kind: 'hidden' });
        const detail = { pageKind: 'happier.triage/triage', identity: 'pr-54', activeId: 'overview' };
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail: detail, rootHostedDetail: true }))
            .toEqual({ kind: 'detail', ...detail });
        for (const pathname of [root, `${root}/sv%2Cassigned?view=pull-requests`]) {
            expect(resolveMobileBottomChromeModel({ ...base, pathname })).toEqual({ kind: 'mainAppTabs' });
        }
    });

    it('uses the presented root-hosted plugin detail and withdraws without a pathname fallback', () => {
        const mountedDetail = { pageKind: 'acme.review/entry', identity: 'entry-1', activeId: 'files' };
        for (const pathname of ['/', '/plugins/acme.review/inbox', '/workflows']) {
            const base = createChromeInput({ pathname, mobileWorkspaceExperience: 'cockpit', rootHostedDetail: true });
            expect(resolveMobileBottomChromeModel({ ...base, mountedDetail })).toEqual({ kind: 'detail', ...mountedDetail });
            expect(resolveMobileBottomChromeModel({ ...base, mountedDetail, mobileWorkspaceExperience: 'classic' }))
                .toEqual(pathname === '/' || pathname === '/workflows' ? { kind: 'mainAppTabs' } : { kind: 'hidden' });
        }
        expect(resolveMobileBottomChromeModel(createChromeInput({ pathname: '/plugins/acme.review/inbox',
            mobileWorkspaceExperience: 'cockpit', rootHostedDetail: true }))).toEqual({ kind: 'hidden' });
    });

    it('uses the foreground Environment and restores its presented parent Project on withdrawal', () => {
        const base = createChromeInput({ pathname: '/projects/open', mobileWorkspaceExperience: 'cockpit' });
        const parent = { pageKind: 'project', identity: 'parent', activeId: 'overview' };
        const environment = { pageKind: 'environment', identity: 'home:staging', activeId: 'variables' };
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail: environment })).toEqual({ kind: 'detail', ...environment });
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail: parent })).toEqual({ kind: 'detail', ...parent });
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail: environment, mobileWorkspaceExperience: 'classic' }))
            .toEqual({ kind: 'hidden' });
    });

    it.each(['workflowEditor', 'workflowRun'])('uses only the foreground mounted %s, retaining Classic presentation', (pageKind) => {
        const base = createChromeInput({ pathname: '/workflows/runs/route-run', mobileWorkspaceExperience: 'cockpit' });
        const mountedDetail = { pageKind, identity: 'mounted', activeId: 'flow' };
        expect(resolveMobileBottomChromeModel(base)).toEqual({ kind: 'detailPending' });
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail })).toEqual({ kind: 'detail', ...mountedDetail });
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail, mobileWorkspaceExperience: 'classic' })).toEqual({ kind: 'hidden' });
    });

    it('uses mounted Machine identity and selection, with no pathname fallback or Classic bar', () => {
        const base = createChromeInput({ pathname: '/machines/route-machine', mobileWorkspaceExperience: 'cockpit' });
        const mountedDetail = { pageKind: 'machine', identity: 'home-a:mounted', activeId: 'storage' };
        expect(resolveMobileBottomChromeModel(base)).toEqual({ kind: 'detailPending' });
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail })).toEqual({ kind: 'detail', ...mountedDetail });
        expect(resolveMobileBottomChromeModel({ ...base, mountedDetail, mobileWorkspaceExperience: 'classic' })).toEqual({ kind: 'hidden' });
    });

    it('takes Session identity and restored first-frame selection only from mounted presentation', () => {
        for (const pathname of ['/session/route-session', '/session/route-session/files', '/session/route-session/files/browse']) {
            const base = createChromeInput({ pathname, mobileWorkspaceExperience: 'cockpit' });
            // Before the Session mounts, its bar is known to stand here (its room is reserved), but not its tabs.
            expect(resolveMobileBottomChromeModel(base)).toEqual({ kind: 'detailPending' });
            expect(resolveMobileBottomChromeModel({ ...base, mobileWorkspaceExperience: 'classic' })).toEqual({ kind: 'hidden' });
            expect(resolveMobileBottomChromeModel({ ...base, sessionDetailsKind: 'scmReview' })).toEqual({ kind: 'hidden' });
            for (const activeId of ['tabs', 'git', 'browse']) {
                const mountedDetail = sessionDetail(activeId);
                expect(resolveMobileBottomChromeModel({ ...base, mountedDetail })).toEqual({ kind: 'detail', ...mountedDetail });
            }
        }
    });

    it('retains exact external Project page selection on nested routes independently of companions', () => {
        const mountedDetail = { pageKind: 'project', identity: 'wr_1', activeId: 'plugin:external.tools:builds' };
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/projects/wr_1/plugins/external.tools/builds/runs/42/page',
            mountedDetail, mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({ kind: 'detail', ...mountedDetail });
    });

    it('does not infer Project chrome from malformed or selection route paths', () => {
        for (const pathname of ['/projects/open', '/projects/open/?sourceId=source', '/projects/sources', '/projects/sources/']) {
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience: 'cockpit' })))
                .toEqual({ kind: 'hidden' });
        }
        // A Project's own route waits for its host's bar; the route alone never names the Project's page.
        expect(resolveMobileBottomChromeModel(createChromeInput({ pathname: '/projects/%E0%A4/plugins/external.tools/builds',
            mobileWorkspaceExperience: 'cockpit' }))).toEqual({ kind: 'detailPending' });
    });

    it('uses only the mounted Discussion presentation and leaves Classic unchanged', () => {
        const base = createChromeInput({ pathname: '/discussions/disc-1', mobileWorkspaceExperience: 'cockpit' });
        expect(resolveMobileBottomChromeModel(base)).toEqual({ kind: 'detailPending' });
        for (const activeId of ['participants', 'details', 'chat']) {
            const mountedDetail = { pageKind: 'discussion', identity: 'mounted', activeId };
            expect(resolveMobileBottomChromeModel({ ...base, mountedDetail })).toEqual({ kind: 'detail', ...mountedDetail });
            expect(resolveMobileBottomChromeModel({ ...base, mountedDetail, mobileWorkspaceExperience: 'classic' }))
                .toEqual({ kind: 'hidden' });
        }
        for (const pathname of ['/discussions/new', '/discussions']) {
            expect(resolveMobileBottomChromeModel({ ...base, pathname })).toEqual({ kind: 'hidden' });
        }
    });

    it('returns main app tabs for authenticated home and Workflow tab routes', () => {
        for (const pathname of ['/', '/workflows', '/workflows/', '/workflows?view=all', '/workflows/#runs']) {
            for (const mobileWorkspaceExperience of ['classic', 'cockpit'] as const) {
                expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience })))
                    .toEqual({ kind: 'mainAppTabs' });
            }
        }
    });

    it('keeps non-root-hosted retained details from replacing main app tabs', () => {
        for (const pathname of ['/', '/workflows']) {
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience: 'cockpit',
                mountedDetail: sessionDetail('chat') }))).toEqual({ kind: 'mainAppTabs' });
        }
    });

    it('hides retained Session chrome on history routes', () => {
        for (const pathname of ['/session/recent', '/session/recent/', '/session/archived', '/session/archived/']) {
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience: 'cockpit',
                mountedDetail: sessionDetail('chat') }))).toEqual({ kind: 'hidden' });
        }
    });

    it('hides the pushed SCM reading and keeps chrome on every other details target', () => {
        const base = createChromeInput({ pathname: '/session/session-1/details', mobileWorkspaceExperience: 'cockpit',
            mountedDetail: sessionDetail('browse') });
        expect(resolveMobileBottomChromeModel({ ...base, sessionDetailsKind: 'scmReview' })).toEqual({ kind: 'hidden' });
        for (const sessionDetailsKind of ['file', 'commit', 'scmStash', 'scmPullRequest', null]) {
            expect(resolveMobileBottomChromeModel({ ...base, sessionDetailsKind }))
                .toEqual({ kind: 'detail', ...sessionDetail('browse') });
        }
        // Narrowing to a phone keeps the Session root route and presents the reading on Tabs.
        expect(resolveMobileBottomChromeModel({ ...base, pathname: '/session/session-1', sessionDetailsKind: 'scmReview',
            mountedDetail: sessionDetail('tabs') })).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel({ ...base, pathname: '/session/session-1', sessionDetailsKind: 'scmReview',
            mountedDetail: sessionDetail('chat') })).toEqual({ kind: 'detail', ...sessionDetail('chat') });
        // A reading in the companion pane on a files route keeps the cockpit.
        expect(resolveMobileBottomChromeModel({ ...base, pathname: '/session/session-1/files', sessionDetailsKind: 'scmReview' }))
            .toEqual({ kind: 'detail', ...sessionDetail('browse') });
    });

    it('does not apply Session immersive-reading policy to another presented detail', () => {
        const mountedDetail = { pageKind: 'project', identity: 'wr_1', activeId: 'tabs' };
        expect(resolveMobileBottomChromeModel(createChromeInput({ pathname: '/session/session-1/details',
            mobileWorkspaceExperience: 'cockpit', sessionDetailsKind: 'scmReview', mountedDetail })))
            .toEqual({ kind: 'detail', ...mountedDetail });
    });

    it('uses mounted Project restored selection on root and terminal routes', () => {
        for (const [pathname, activeId] of [['/projects/wr_1', 'browse'], ['/projects/wr_1/terminal', 'terminal']]) {
            const mountedDetail = { pageKind: 'project', identity: 'wr_1', activeId };
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mountedDetail, mobileWorkspaceExperience: 'cockpit' })))
                .toEqual({ kind: 'detail', ...mountedDetail });
        }
    });

    it('hides unauthenticated chrome, including a root-hosted detail', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({ isAuthenticated: false }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({ isAuthenticated: false, mobileWorkspaceExperience: 'cockpit',
            mountedDetail: sessionDetail('chat'), rootHostedDetail: true }))).toEqual({ kind: 'hidden' });
    });

    // Owner 11-06: the bar is coherent on every page. A page a section or More destination claims keeps the
    // main bar, pushed details included; a page whose detail host draws its own bar waits for that host.
    it('keeps the main bar on every section page and pushed detail without a detail bar of its own', () => {
        for (const mobileWorkspaceExperience of ['cockpit', 'classic'] as const) {
            for (const pathname of ['/inbox/approvals/approval-1', '/boards', '/boards/board-1', '/discussions',
                '/artifacts', '/home', '/projects/open', '/machines', '/session/recent',
                // The Machines destination's own fleet pages are pages, not a Machine's detail (lab rdMach-fUpdp/fActp; LABPARITY-ACCEPT-A G1).
                '/machines/updates', '/machines/activity']) {
                expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience, sectionPage: true })), pathname)
                    .toEqual({ kind: 'mainAppTabs' });
            }
        }
        for (const pathname of ['/discussions/disc-1', '/session/s_123', '/projects/wr_1', '/machines/m-1', '/workflows/wf-1']) {
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience: 'cockpit', sectionPage: true })), pathname)
                .toEqual({ kind: 'detailPending' });
        }
        expect(resolveMobileBottomChromeModel(createChromeInput({ pathname: '/zen', sectionPage: false }))).toEqual({ kind: 'hidden' });
    });

    it('takes a tab press from a pushed page back to that tab, and stays put on the tab itself', () => {
        expect(resolveMainTabPressRoute({ pathname: '/boards/board-1', targetRoute: '/' })).toBe('/');
        expect(resolveMainTabPressRoute({ pathname: '/inbox/approvals/a-1', targetRoute: '/' })).toBe('/');
        expect(resolveMainTabPressRoute({ pathname: '/workflows', targetRoute: '/' })).toBe('/');
        expect(resolveMainTabPressRoute({ pathname: '/boards', targetRoute: '/workflows' })).toBe('/workflows');
        for (const [pathname, targetRoute] of [['/', '/'], ['/workflows/', '/workflows'], ['/?server=a', '/']]) {
            expect(resolveMainTabPressRoute({ pathname, targetRoute }), pathname).toBeNull();
        }
    });

    it('leaves Classic Session, pushed settings, and unrelated routes to their own chrome', () => {
        for (const pathname of ['/session/s_123', '/settings/session', '/projects']) {
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname }))).toEqual({ kind: 'hidden' });
        }
    });
});
