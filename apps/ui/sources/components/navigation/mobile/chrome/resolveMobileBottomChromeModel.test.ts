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
    it('returns main app tabs for the authenticated home route', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({}))).toEqual({ kind: 'mainAppTabs' });
    });

    it('returns main app tabs for route-owned settings routes', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/settings/session',
        }))).toEqual({ kind: 'mainAppTabs' });
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
});
