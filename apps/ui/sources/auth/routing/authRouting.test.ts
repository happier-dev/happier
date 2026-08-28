import { describe, expect, it, vi } from 'vitest';
import { isPublicRouteForUnauthenticated } from './authRouting';

type DevGlobal = typeof globalThis & { __DEV__?: boolean };

function withDevBuild<T>(enabled: boolean, run: () => T): T {
    const devGlobal = globalThis as DevGlobal;
    const hadOwnDevFlag = Object.prototype.hasOwnProperty.call(devGlobal, '__DEV__');
    const previousDevFlag = devGlobal.__DEV__;
    vi.stubGlobal('__DEV__', enabled);
    try {
        return run();
    } finally {
        if (hadOwnDevFlag) {
            vi.stubGlobal('__DEV__', previousDevFlag);
        } else {
            Reflect.deleteProperty(devGlobal, '__DEV__');
        }
    }
}

function withDebugRouteEnv<T>(value: string | undefined, run: () => T): T {
    const previousDebugFlag = process.env.EXPO_PUBLIC_DEBUG;
    if (value === undefined) {
        delete process.env.EXPO_PUBLIC_DEBUG;
    } else {
        process.env.EXPO_PUBLIC_DEBUG = value;
    }
    try {
        return run();
    } finally {
        if (previousDebugFlag === undefined) {
            delete process.env.EXPO_PUBLIC_DEBUG;
        } else {
            process.env.EXPO_PUBLIC_DEBUG = previousDebugFlag;
        }
    }
}

describe('isPublicRouteForUnauthenticated', () => {
    const routeCases: Array<{ name: string; segments: string[]; expected: boolean }> = [
        { name: 'empty root', segments: [], expected: true },
        { name: 'group-only route', segments: ['(app)'], expected: true },
        { name: 'home index', segments: ['index'], expected: true },
        { name: 'grouped home index', segments: ['(app)', 'index'], expected: true },
        { name: 'nested home index', segments: ['(app)', '(group)', 'index'], expected: true },
        { name: 'setup route', segments: ['setup'], expected: true },
        { name: 'nested setup route', segments: ['(app)', 'setup'], expected: true },
        { name: 'server route', segments: ['server'], expected: true },
        { name: 'nested server route', segments: ['(app)', 'server', 'saved'], expected: true },
        { name: 'restore route', segments: ['restore'], expected: true },
        { name: 'nested restore route', segments: ['(app)', 'restore', 'lost-access'], expected: true },
        { name: 'share route', segments: ['share'], expected: true },
        { name: 'nested share route', segments: ['(app)', 'share', 'abc123'], expected: true },
        { name: 'terminal route', segments: ['terminal'], expected: true },
        { name: 'nested terminal route', segments: ['(app)', 'terminal', 'connect'], expected: true },
        { name: 'account connect route', segments: ['account'], expected: true },
        { name: 'grouped account connect route', segments: ['(app)', 'account'], expected: true },
        { name: 'oauth return route', segments: ['oauth', 'github'], expected: true },
        { name: 'grouped oauth return route', segments: ['(app)', 'oauth', 'github'], expected: true },
        { name: 'desktop activity overlay route', segments: ['desktop', 'activity-overlay'], expected: true },
        { name: 'grouped desktop activity overlay route', segments: ['(app)', 'desktop', 'activity-overlay'], expected: true },
        { name: 'other dev route stays private', segments: ['(app)', 'dev', 'other'], expected: false },
        { name: 'private settings route', segments: ['settings'], expected: false },
        { name: 'grouped private settings route', segments: ['(app)', 'settings'], expected: false },
        { name: 'unknown private route', segments: ['inbox'], expected: false },
        { name: 'nested unknown private route', segments: ['(app)', 'session', '[id]'], expected: false },
        { name: 'ambiguous grouped segment only', segments: ['(auth)', '(protected)'], expected: true },
        { name: 'case-sensitive route mismatch', segments: ['Server'], expected: false },
    ];

    it.each(routeCases)('$name', ({ segments, expected }) => {
        expect(isPublicRouteForUnauthenticated(segments)).toBe(expected);
    });

    it('allows credential-free QA routes before auth only in dev or debug-export builds', () => {
        withDevBuild(true, () => {
            withDebugRouteEnv(undefined, () => {
                expect(isPublicRouteForUnauthenticated(['(app)', 'dev', 'stage-dperf'])).toBe(true);
                expect(isPublicRouteForUnauthenticated(['(app)', 'dev', 'terminal-qa'])).toBe(true);
            });
        });

        withDevBuild(false, () => {
            withDebugRouteEnv(undefined, () => {
                expect(isPublicRouteForUnauthenticated(['(app)', 'dev', 'stage-dperf'])).toBe(false);
                expect(isPublicRouteForUnauthenticated(['(app)', 'dev', 'terminal-qa'])).toBe(false);
            });
        });

        withDevBuild(false, () => {
            withDebugRouteEnv('1', () => {
                expect(isPublicRouteForUnauthenticated(['(app)', 'dev', 'stage-dperf'])).toBe(true);
                expect(isPublicRouteForUnauthenticated(['(app)', 'dev', 'terminal-qa'])).toBe(true);
            });
        });
    });
});
