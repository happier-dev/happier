import { afterEach, describe, expect, it } from 'vitest';

import {
    buildSessionFileWindowHref,
    isSessionFileWindowContext,
    parseSessionFileWindowParams,
} from './sessionFileWindowRoute';

function setWindowLocation(url: string) {
    Object.defineProperty(globalThis, 'window', {
        value: { location: { href: url } },
        configurable: true,
        writable: true,
    });
}

describe('session file window route', () => {
    afterEach(() => {
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it('round-trips a session, server and path with spaces and unicode', () => {
        const href = buildSessionFileWindowHref({ sessionId: 's 1', serverId: 'srv', path: 'docs/Ünïcode notes.md' });
        const url = new URL(href, 'http://tauri.localhost');
        expect(url.pathname).toBe('/file-window');
        expect(parseSessionFileWindowParams(Object.fromEntries(url.searchParams))).toEqual({
            sessionId: 's 1',
            serverId: 'srv',
            path: 'docs/Ünïcode notes.md',
        });
    });

    it('omits the server when the session uses the active server', () => {
        const href = buildSessionFileWindowHref({ sessionId: 's1', serverId: null, path: 'a.md' });
        const url = new URL(href, 'http://localhost');
        expect(url.searchParams.has('serverId')).toBe(false);
        expect(parseSessionFileWindowParams(Object.fromEntries(url.searchParams))).toEqual({
            sessionId: 's1',
            serverId: null,
            path: 'a.md',
        });
    });

    it('rejects a path that escapes the workspace', () => {
        expect(parseSessionFileWindowParams({ sessionId: 's1', path: '../secrets.txt' })).toBeNull();
        expect(parseSessionFileWindowParams({ sessionId: 's1', path: '/etc/passwd' })).toBeNull();
        expect(parseSessionFileWindowParams({ sessionId: '', path: 'a.md' })).toBeNull();
    });

    it('recognises the file window from its pathname in any web host', () => {
        setWindowLocation('http://tauri.localhost/file-window?sessionId=s1&path=a.md');
        expect(isSessionFileWindowContext()).toBe(true);
        setWindowLocation('https://app.example.com/session/s1/file?path=a.md');
        expect(isSessionFileWindowContext()).toBe(false);
    });
});
