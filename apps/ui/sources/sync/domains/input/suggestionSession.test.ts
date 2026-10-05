import { describe, expect, it } from 'vitest';

import {
    buildComposerSessionTokenSlug,
    projectComposerSessionSuggestionItems,
    type ComposerSessionSuggestionState,
} from './suggestionSession';

type SessionOverrides = Record<string, unknown>;

function renderable(id: string, overrides: SessionOverrides = {}) {
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
    byServer: Record<string, readonly ReturnType<typeof renderable>[]>;
}>): ComposerSessionSuggestionState {
    // The listing store is an external UI-state boundary; this fixture intentionally supplies
    // only the fields the narrow composer projection reads.
    return {
        sessions: { current: { serverId: 'server-a' } },
        sessionListRowsByServerId: Object.fromEntries(
            Object.entries(args.byServer).map(([serverId, sessions]) => [
                serverId,
                Object.fromEntries(sessions.map((session) => [session.id, session])),
            ]),
        ) as ComposerSessionSuggestionState['sessionListRowsByServerId'],
    };
}

describe('composer session suggestion source (D-7, D-8)', () => {
    it('projects only the carried identity through the same current Session eligibility', () => {
        const current = state({ byServer: { 'server-a': [renderable('selected'), renderable('neighbor'),
            renderable('archived', { archivedAt: 42 }), renderable('current')] } });
        const scope = { serverId: 'server-a', currentSessionId: 'current', candidateSessionId: 'selected' };
        expect(projectComposerSessionSuggestionItems(current, scope).map(item => item.id)).toEqual(['selected']);
        expect(projectComposerSessionSuggestionItems(current, { ...scope, candidateSessionId: 'archived' })).toEqual([]);
        expect(projectComposerSessionSuggestionItems(current, { ...scope, candidateSessionId: 'current' })).toEqual([]);
        expect(projectComposerSessionSuggestionItems(current, { ...scope, candidateSessionId: 'missing' })).toEqual([]);
    });
    /**
     * The new-session composer has no session to derive a server from, so it declares the
     * server its session will spawn on. That is the only arm that makes `@session` reachable
     * before a session exists; without it the picker is silently empty there.
     */
    it('projects the declared server when there is no current session, excluding nothing', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [renderable('current'), renderable('same-server')],
                    'server-b': [renderable('other-server')],
                },
            }),
            { serverId: 'server-a', currentSessionId: null },
        );

        // Both server-a rows, including the one another host would have excluded as "current".
        expect(items.map((item) => item.id).sort()).toEqual(['current', 'same-server']);
    });

    it('suggests nothing when no server can be resolved at all (D-8: never "any server")', () => {
        const items = projectComposerSessionSuggestionItems(
            state({ byServer: { 'server-a': [renderable('same-server')] } }),
            { serverId: null, currentSessionId: null },
        );

        expect(items).toEqual([]);
    });

    /**
     * A declared server is the host's own decision and must win outright: deriving a second
     * answer from the current session would make two owners of one question, and would send
     * the picker at the wrong server whenever the two disagree.
     */
    it('prefers the declared server over the one derived from the current session', () => {
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

    it('projects only same-server sibling identity and excludes the current session', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [renderable('current'), renderable('same-server')],
                    'server-b': [renderable('other-server')],
                },
            }),
            { serverId: null, currentSessionId: 'current' },
        );

        expect(items).toEqual([
            expect.objectContaining({
                id: 'same-server',
                title: 'Session same-server',
            }),
        ]);
        // The opaque session id stays the only durable reference, but each row carries
        // the exact server (and machine) scope it was projected for so its Agent mark
        // can resolve machine-qualified catalog identity instead of guessing.
        expect(items[0]).toMatchObject({ serverId: 'server-a' });
    });

    describe('the Agent identity a row carries', () => {
        function itemFor(metadata: Record<string, unknown>) {
            const [item] = projectComposerSessionSuggestionItems(
                state({
                    byServer: {
                        'server-a': [renderable('peer', {
                            metadata: { name: 'Session peer', path: '/repo', ...metadata },
                        })],
                    },
                }),
                { serverId: 'server-a', currentSessionId: null },
            );
            return item;
        }

        function agentIdFor(flavor: unknown) {
            return itemFor({ flavor })?.agentId;
        }

        it('resolves the session flavor to a registry provider', () => {
            expect(agentIdFor('codex')).toBe('codex');
            expect(agentIdFor('claude')).toBe('claude');
        });

        it('keeps a session that declares no Agent unresolved', () => {
            expect(agentIdFor(undefined)).toBeNull();
            expect(agentIdFor('')).toBeNull();
        });

        it('preserves an external Agent identity declared by the runtime descriptor', () => {
            expect(itemFor({
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme.native/agent',
                    agent: {},
                },
            })?.agentId).toBe('acme.native/agent');
        });

        it('reads layout-v1 identity from the canonical shared presentation envelope', () => {
            const [item] = projectComposerSessionSuggestionItems(
                state({
                    byServer: {
                        'server-a': [renderable('peer', {
                            metadataLayoutVersion: 1,
                            accessLevel: 'view',
                            metadata: {
                                v: 1,
                                agentPresentation: { agentId: 'acme.native/agent' },
                            },
                        })],
                    },
                }),
                { serverId: 'server-a', currentSessionId: null },
            );

            expect(item?.agentId).toBe('acme.native/agent');
        });

        /**
         * Machine-qualified identity presentation needs the scope the Agent mark resolves
         * against: the machine the session runs on and the exact server scope the row
         * was projected for.
         */
        it('threads the machine and server scope the Agent mark resolves against', () => {
            expect(itemFor({
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme.native/agent',
                    agent: {},
                },
                machineId: 'machine-1',
            })).toMatchObject({
                agentId: 'acme.native/agent',
                machineId: 'machine-1',
                serverId: 'server-a',
            });
            expect(itemFor({ flavor: 'codex' })).toMatchObject({
                agentId: 'codex',
                machineId: null,
                serverId: 'server-a',
            });
        });
    });

    it('makes a readable token whose identity remains the full session id', () => {
        const item = {
            id: 'cmslj08960ku1tmhrd0v4a0a7',
            title: 'Fix Detached Dev Stack Startup',
            workspaceLabel: null,
            agentLabel: null,
            updatedAt: 1,
            active: true,
        };

        expect(buildComposerSessionTokenSlug(item)).toBe('fix-detached-dev-stack-startup-v4a0a7');
        expect(item.id).toBe('cmslj08960ku1tmhrd0v4a0a7');
    });

    it('retains inactive sibling rows but excludes archived and hidden system sessions', () => {
        const items = projectComposerSessionSuggestionItems(
            state({
                byServer: {
                    'server-a': [
                        renderable('current'),
                        renderable('inactive', { active: false, updatedAt: 10 }),
                        renderable('fresh', { updatedAt: 20 }),
                        renderable('archived', { archivedAt: 1 }),
                        renderable('hidden', {
                            metadata: {
                                name: 'Hidden system row',
                                path: '/Users/dev/projects/app',
                                hiddenSystemSession: true,
                            },
                        }),
                    ],
                },
            }),
            { serverId: null, currentSessionId: 'current' },
        );

        expect(items.map((item) => [item.id, item.active])).toEqual([
            ['fresh', true],
            ['inactive', false],
        ]);
    });
});
