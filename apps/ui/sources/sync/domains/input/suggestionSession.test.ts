import { describe, expect, it } from 'vitest';

import {
    buildComposerSessionTokenSlug,
    projectComposerSessionSuggestionItems,
    type ComposerSessionSuggestionScope,
    type ComposerSessionSuggestionState,
} from './suggestionSession';

/** The scope a host WITH a session declares: its own id, server derived from it. */
function inSession(sessionId: string): ComposerSessionSuggestionScope {
    return { serverId: null, currentSessionId: sessionId };
}

type SessionOverrides = Record<string, unknown>;

function renderable(id: string, overrides: SessionOverrides = {}): any {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1_000,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: { name: `Session ${id}`, path: '/Users/dev/projects/app' },
        ...overrides,
    };
}

function state(args: Readonly<{
    currentServerId?: string;
    byServer: Record<string, readonly any[]>;
}>): ComposerSessionSuggestionState {
    return {
        sessions: { current: { serverId: args.currentServerId ?? 'server-a' } },
        sessionListViewDataByServerId: Object.fromEntries(
            Object.entries(args.byServer).map(([serverId, sessions]) => [
                serverId,
                sessions.map((session) => ({ type: 'session', session, serverId })),
            ]),
        ) as any,
    };
}

describe('composer session suggestion source (D-7, D-8)', () => {
    it('excludes the current session and every other server\'s sessions', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [renderable('current'), renderable('same-server')],
                    'server-b': [renderable('other-server')],
                },
            }),
            inSession('current'),
        );

        expect(items.map((item) => item.id)).toEqual(['same-server']);
    });

    it('returns nothing when the current session\'s server cannot be resolved', () => {
        const items = projectComposerSessionSuggestionItems(
            { sessions: {}, sessionListViewDataByServerId: { 'server-a': [] } },
            inSession('current'),
        );

        expect(items).toEqual([]);
    });

    it('excludes archived and hidden system sessions, and keeps inactive ones', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [
                        renderable('current'),
                        renderable('archived', { archivedAt: 123 }),
                        renderable('hidden', { metadata: { path: '/w', hiddenSystemSession: true } }),
                        renderable('inactive', { active: false }),
                    ],
                },
            }),
            inSession('current'),
        );

        expect(items.map((item) => item.id)).toEqual(['inactive']);
        expect(items[0]?.active).toBe(false);
    });

    it('orders by recency with a stable tiebreak', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [
                        renderable('current'),
                        renderable('older', { updatedAt: 10 }),
                        renderable('bbb', { updatedAt: 20 }),
                        renderable('aaa', { updatedAt: 20 }),
                    ],
                },
            }),
            inSession('current'),
        );

        expect(items.map((item) => item.id)).toEqual(['aaa', 'bbb', 'older']);
    });

    it('projects only the declared fields, so churn on turn state produces an identical row', () => {
        // §7.3: a change that does not alter a declared projection field must not reach the
        // composer at all. `thinking`, `latestTurnStatus`, `seq` and `presence` are exactly the
        // high-churn fields the session list carries and this projection refuses to read.
        const before = projectComposerSessionSuggestionItems(
            state({ byServer: { 'server-a': [renderable('current'), renderable('peer')] } }),
            inSession('current'),
        );
        const after = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [
                        renderable('current'),
                        renderable('peer', {
                            thinking: true,
                            thinkingAt: 99,
                            seq: 42,
                            presence: 12345,
                            latestTurnStatus: 'running',
                            runtimeActivityState: 'active',
                        }),
                    ],
                },
            }),
            inSession('current'),
        );

        expect(after).toEqual(before);
    });

    it('reads the title through the canonical session-name owner', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [
                        renderable('current'),
                        renderable('peer', {
                            metadata: {
                                name: 'Ignored',
                                summaryText: 'Fix Detached Dev Stack Startup',
                                path: '/Users/dev/projects/app',
                                homeDir: '/Users/dev',
                            },
                        }),
                    ],
                },
            }),
            inSession('current'),
        );

        expect(items[0]?.title).toBe('Fix Detached Dev Stack Startup');
        expect(items[0]?.workspaceLabel).toBe('~/projects/app');
    });
});

describe('composer session suggestion source with no current session (new-session composer)', () => {
    it('scopes to the server the new session will spawn on, and excludes nothing', () => {
        // There is no current session to exclude here, so "exclude the current session" must
        // degrade to excluding NOTHING rather than to returning nothing — and the server must
        // come from the host's declared spawn target, since there is no session to derive it from.
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [renderable('current'), renderable('same-server')],
                    'server-b': [renderable('other-server')],
                },
            }),
            { serverId: 'server-a', currentSessionId: null },
        );

        expect(items.map((item) => item.id)).toEqual(['current', 'same-server']);
    });

    it('still excludes every other server\'s sessions (D-8)', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [renderable('same-server')],
                    'server-b': [renderable('other-server')],
                },
            }),
            { serverId: 'server-b', currentSessionId: null },
        );

        expect(items.map((item) => item.id)).toEqual(['other-server']);
    });

    it('suggests nothing when the host has declared no server, rather than falling back to any server', () => {
        // Fail-closed: a reference the agent could never act on (D-8) must not be offered. An
        // empty `targetServerId` is a real state on this host — `useNewSessionServerTargetState`
        // returns `''` before any server profile has resolved.
        expect(projectComposerSessionSuggestionItems(
            state({ byServer: { 'server-a': [renderable('same-server')] } }),
            { serverId: '', currentSessionId: null },
        )).toEqual([]);
        expect(projectComposerSessionSuggestionItems(
            state({ byServer: { 'server-a': [renderable('same-server')] } }),
            { serverId: null, currentSessionId: null },
        )).toEqual([]);
    });

    it('never resolves a server from a session id that matches no session', () => {
        // A stale or unknown id must not fall through to some other server's list.
        expect(projectComposerSessionSuggestionItems(
            state({ byServer: { 'server-a': [renderable('same-server')] } }),
            inSession('__new_session__'),
        )).toEqual([]);
    });

    it('prefers the declared server over the one the current session resolves to', () => {
        // A host that declares a server has already decided which server it targets; deriving a
        // second answer from a session id would be two decision-makers for one question.
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [renderable('current'), renderable('same-server')],
                    'server-b': [renderable('other-server')],
                },
            }),
            { serverId: 'server-b', currentSessionId: 'current' },
        );

        expect(items.map((item) => item.id)).toEqual(['other-server']);
    });
});

describe('composer session token slug (INV-3)', () => {
    it('disambiguates identical titles with the session id tail', () => {
        const left = buildComposerSessionTokenSlug({
            id: 'cmslj08960ku1tmhrd0v4a0a7',
            title: 'Fix Detached Dev Stack Startup',
            workspaceLabel: null,
            agentLabel: null,
            updatedAt: 1,
            active: true,
        });
        const right = buildComposerSessionTokenSlug({
            id: 'cmsg29n8n06ovtm0ylmic48wj',
            title: 'Fix Detached Dev Stack Startup',
            workspaceLabel: null,
            agentLabel: null,
            updatedAt: 1,
            active: true,
        });

        expect(left).toBe('fix-detached-dev-stack-startup-v4a0a7');
        expect(right).toBe('fix-detached-dev-stack-startup-ic48wj');
        expect(left).not.toBe(right);
    });

    it('never emits a token boundary character, so the token stays one word', () => {
        const slug = buildComposerSessionTokenSlug({
            id: 'abcdef123456',
            title: 'Review PR #42 (urgent!), then ship',
            workspaceLabel: null,
            agentLabel: null,
            updatedAt: 1,
            active: true,
        });

        expect(slug).toBe('review-pr-42-urgent-then-ship-123456');
        expect(slug).not.toMatch(/[\s,;()[\]{}<>!?"]/);
    });

    it('falls back to a readable stem when the title has no usable characters', () => {
        expect(buildComposerSessionTokenSlug({
            id: 'abcdef123456',
            title: '???',
            workspaceLabel: null,
            agentLabel: null,
            updatedAt: 1,
            active: true,
        })).toBe('session-123456');
    });
});
