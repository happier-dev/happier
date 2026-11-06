import { describe, expect, it } from 'vitest';

import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

function createChromeInput(
    overrides: Partial<Parameters<typeof resolveMobileBottomChromeModel>[0]>,
): Parameters<typeof resolveMobileBottomChromeModel>[0] {
    return {
        isAuthenticated: true,
        pathname: '/',
        mobileWorkspaceExperience: 'classic',
        sessionLastMobileSurfaceBySessionId: null,
        projectLastMobileSurfaceByWorkspaceRefId: null,
        sessionTerminalTabAvailable: true,
        ...overrides,
    };
}

describe('resolveMobileBottomChromeModel', () => {
    it.each(['/projects/open', '/projects/open/?sourceId=source', '/projects/sources', '/projects/sources/'])('keeps Project selection flows free of floating cockpit chrome (%s)', (pathname) => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname,
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({ kind: 'hidden' });
    });

    it('returns main app tabs for authenticated home and Workflow tab routes', () => {
        for (const pathname of ['/', '/workflows', '/workflows/', '/workflows?view=all', '/workflows/#runs']) {
            for (const mobileWorkspaceExperience of ['classic', 'cockpit'] as const) {
                expect(resolveMobileBottomChromeModel(createChromeInput({ pathname, mobileWorkspaceExperience })))
                    .toEqual({ kind: 'mainAppTabs' });
            }
        }
    });

    it('returns a session cockpit model for session routes in cockpit mode', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1/files',
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({
            kind: 'sessionCockpit',
            sessionId: 'session-1',
            surface: 'browse',
            terminalTabAvailable: true,
        });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1/files/browse',
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({
            kind: 'sessionCockpit',
            sessionId: 'session-1',
            surface: 'browse',
            terminalTabAvailable: true,
        });
    });

    it('returns hidden for non-detail session history routes in cockpit mode', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/recent',
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/archived',
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({ kind: 'hidden' });
    });

    it('hides cockpit chrome on the pushed SCM reading and keeps it on every other details target', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1/details',
            mobileWorkspaceExperience: 'cockpit',
            sessionDetailsKind: 'scmReview',
        }))).toEqual({ kind: 'hidden' });
        for (const sessionDetailsKind of ['file', 'commit', 'scmStash', 'scmPullRequest', null]) {
            expect(resolveMobileBottomChromeModel(createChromeInput({
                pathname: '/session/session-1/details',
                mobileWorkspaceExperience: 'cockpit',
                sessionDetailsKind,
            }))).toMatchObject({ kind: 'sessionCockpit', sessionId: 'session-1' });
        }
        // The reading's own pane on a session root/files route keeps the cockpit.
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1/files',
            mobileWorkspaceExperience: 'cockpit',
            sessionDetailsKind: 'scmReview',
        }))).toMatchObject({ kind: 'sessionCockpit', surface: 'browse' });
    });

    it('uses persisted cockpit state for the session root route', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1',
            mobileWorkspaceExperience: 'cockpit',
            sessionLastMobileSurfaceBySessionId: { 'session-1': 'git' },
        }))).toEqual({
            kind: 'sessionCockpit',
            sessionId: 'session-1',
            surface: 'git',
            terminalTabAvailable: true,
        });
    });

    it('returns a project cockpit model for project routes in cockpit mode', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/projects/wr_1/terminal',
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({
            kind: 'projectCockpit',
            workspaceRefId: 'wr_1',
            surface: 'terminal',
        });
    });

    it('uses persisted cockpit state for the project root route', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/projects/wr_1',
            mobileWorkspaceExperience: 'cockpit',
            projectLastMobileSurfaceByWorkspaceRefId: { wr_1: 'browse' },
        }))).toEqual({
            kind: 'projectCockpit',
            workspaceRefId: 'wr_1',
            surface: 'browse',
        });
    });

    it('returns hidden for unauthenticated home route, classic session routes, and unrelated routes', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            isAuthenticated: false,
        }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/s_123',
        }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/projects',
            mobileWorkspaceExperience: 'cockpit',
        }))).toEqual({ kind: 'hidden' });
    });
    it('leaves Classic Session, pushed settings, and unrelated routes to their own chrome', () => {
        for (const pathname of ['/session/s_123', '/settings/session', '/projects']) {
            expect(resolveMobileBottomChromeModel(createChromeInput({ pathname }))).toEqual({ kind: 'hidden' });
        }
    });
});
