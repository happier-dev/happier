import { describe, expect, it } from 'vitest';
import { isPublicRouteForUnauthenticated } from './authRouting';

describe('isPublicRouteForUnauthenticated', () => {
    const routeCases: Array<{ name: string; segments: string[]; expected: boolean }> = [
        { name: 'empty root', segments: [], expected: true },
        { name: 'group-only route', segments: ['(app)'], expected: true },
        { name: 'home index', segments: ['index'], expected: true },
        { name: 'grouped home index', segments: ['(app)', 'index'], expected: true },
        { name: 'nested home index', segments: ['(app)', '(group)', 'index'], expected: true },
        { name: 'server route', segments: ['server'], expected: true },
        { name: 'nested server route', segments: ['(app)', 'server', 'saved'], expected: true },
        { name: 'restore route', segments: ['restore'], expected: true },
        { name: 'nested restore route', segments: ['(app)', 'restore', 'lost-access'], expected: true },
        { name: 'share route', segments: ['share'], expected: true },
        { name: 'nested share route', segments: ['(app)', 'share', 'abc123'], expected: true },
        { name: 'terminal route', segments: ['terminal'], expected: true },
        { name: 'nested terminal route', segments: ['(app)', 'terminal', 'connect'], expected: true },
        { name: 'oauth return route', segments: ['oauth', 'github'], expected: true },
        { name: 'grouped oauth return route', segments: ['(app)', 'oauth', 'github'], expected: true },
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
});
