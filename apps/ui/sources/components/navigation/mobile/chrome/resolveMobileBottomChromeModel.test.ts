import { describe, expect, it } from 'vitest';

import { resolveMobileBottomChromeModel } from './resolveMobileBottomChromeModel';

function createChromeInput(
    overrides: Partial<Parameters<typeof resolveMobileBottomChromeModel>[0]>,
): Parameters<typeof resolveMobileBottomChromeModel>[0] {
    return {
        isAuthenticated: true,
        pathname: '/',
        mobileWorkspaceExperience: 'cockpit',
        sessionLastMobileSurfaceBySessionId: null,
        sessionTerminalTabAvailable: true,
        explicitMobileSurfaceHint: null,
        ...overrides,
    };
}

describe('resolveMobileBottomChromeModel', () => {
    it('returns main app tabs for the root sessions route', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({ pathname: '/' }))).toEqual({
            kind: 'mainAppTabs',
            activeTab: 'sessions',
        });
    });

    it('returns main app tabs for authenticated routed main surfaces', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({ pathname: '/settings/profile' }))).toEqual({
            kind: 'mainAppTabs',
            activeTab: 'settings',
        });
    });

    it('returns a session cockpit model for session routes by default', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1/files',
            mobileWorkspaceExperience: undefined,
        }))).toEqual({
            kind: 'sessionCockpit',
            sessionId: 'session-1',
            surface: 'browse',
            terminalTabAvailable: true,
        });
    });

    it('returns hidden for explicit classic session routes and session history routes', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1',
            mobileWorkspaceExperience: 'classic',
        }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/recent',
        }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/archived',
        }))).toEqual({ kind: 'hidden' });
    });

    it('uses persisted cockpit state for the session root route', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1',
            sessionLastMobileSurfaceBySessionId: { 'session-1': 'git' },
        }))).toEqual({
            kind: 'sessionCockpit',
            sessionId: 'session-1',
            surface: 'git',
            terminalTabAvailable: true,
        });
    });

    it('lets an explicit root-route mobile surface hint override stale persisted state', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/session/session-1',
            explicitMobileSurfaceHint: 'chat',
            sessionLastMobileSurfaceBySessionId: { 'session-1': 'git' },
        }))).toEqual({
            kind: 'sessionCockpit',
            sessionId: 'session-1',
            surface: 'chat',
            terminalTabAvailable: true,
        });
    });

    it('returns hidden for unauthenticated and unrelated routes', () => {
        expect(resolveMobileBottomChromeModel(createChromeInput({
            isAuthenticated: false,
        }))).toEqual({ kind: 'hidden' });
        expect(resolveMobileBottomChromeModel(createChromeInput({
            pathname: '/projects',
        }))).toEqual({ kind: 'hidden' });
    });
});
