import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata, Session } from '@/sync/domains/state/storageTypes';

import { readSessionRollbackRangesV1, resolveTranscriptRollbackActions } from './rollbackUiSupport';

const projectedExternalRollbackCapabilities = {
    agentId: 'acme-lifecycle',
    identity: {
        pluginId: 'acme.lifecycle',
        localId: 'acme-lifecycle',
    },
    generation: 42,
    capabilities: {
        sessions: {
            open: ['resume'],
            delivery: ['newTurn'],
            cancel: true,
            conversationRollback: true,
        },
    },
} as const;

function createActiveSession(metadata: Metadata): Session {
    return {
        id: 'session-1',
        seq: 4,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function userTextMessage(id: string, seq: number, text: string): Message {
    return {
        kind: 'user-text',
        id,
        seq,
        localId: id,
        createdAt: seq,
        text,
    };
}

function agentTextMessage(id: string, seq: number, text: string): Message {
    return {
        kind: 'agent-text',
        id,
        seq,
        localId: id,
        createdAt: seq,
        text,
    };
}

describe('readSessionRollbackRangesV1', () => {
    it('reuses the empty rollback range list when no valid ranges are present', () => {
        const first = readSessionRollbackRangesV1(null);
        const second = readSessionRollbackRangesV1({});
        const third = readSessionRollbackRangesV1({
            sessionRollbackRangesV1: {
                v: 1,
                updatedAt: 1,
                ranges: [{ target: { type: 'latest_turn' }, startSeqInclusive: 4, endSeqInclusive: 3, rolledBackAt: 1 }],
            },
        });

        expect(first).toEqual([]);
        expect(second).toBe(first);
        expect(third).toBe(first);
    });
});

describe('resolveTranscriptRollbackActions', () => {
    it('reuses the empty rollback action map when rollback is unavailable', () => {
        const session = createActiveSession({
            path: '/workspace',
            host: 'localhost',
            flavor: 'claude',
        });
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'initial prompt'),
        };
        const first = resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1'],
            messagesById,
            rollbackRanges: [],
        });
        const second = resolveTranscriptRollbackActions({
            session: { ...session, activeAt: 2 },
            messageIdsOldestFirst: ['u1'],
            messagesById,
            rollbackRanges: [],
        });

        expect(first).toEqual({});
        expect(second).toBe(first);
    });

    it('exposes rollback-to-point for Codex app-server when a trusted rollback turn start exists', () => {
        const session = createActiveSession({
            path: '/workspace',
            host: 'localhost',
            flavor: 'codex',
            codexBackendMode: 'appServer',
        });
        const sessionWithTurns: Session = {
            ...session,
            rollbackEligibleTurnStarts: [1],
        };
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'initial prompt'),
            a1: agentTextMessage('a1', 2, 'partial reply'),
            u2: userTextMessage('u2', 3, 'steer prompt'),
            a2: agentTextMessage('a2', 4, 'final reply'),
        };

        expect(resolveTranscriptRollbackActions({
            session: sessionWithTurns,
            messageIdsOldestFirst: ['u1', 'a1', 'u2', 'a2'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'initial prompt',
            },
        });
    });

    it('restores what the transcript showed, not the expanded transport text', () => {
        const session = createActiveSession({
            path: '/workspace',
            host: 'localhost',
            flavor: 'codex',
            codexBackendMode: 'appServer',
        });
        const sessionWithTurns: Session = {
            ...session,
            rollbackEligibleTurnStarts: [1],
        };
        const messagesById: Record<string, Message> = {
            u1: {
                kind: 'user-text',
                id: 'u1',
                seq: 1,
                localId: 'u1',
                createdAt: 1,
                text: 'Fix this\n\n[attachments]\n{"v":1,"files":[]}\n[/attachments]',
                displayText: 'Fix this',
            },
        };

        expect(resolveTranscriptRollbackActions({
            session: sessionWithTurns,
            messageIdsOldestFirst: ['u1'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'Fix this',
            },
        });
    });

    it('uses the exact external declaration while retaining trusted turn evidence', () => {
        const session: Session = {
            ...createActiveSession({
                path: '/workspace',
                host: 'localhost',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme-lifecycle',
                    agent: { providerSessionId: 'acme-session-1' },
                },
            }),
            rollbackEligibleTurnStarts: [1],
        };
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'external prompt'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1'],
            messagesById,
            rollbackRanges: [],
            currentAgentCapabilities: projectedExternalRollbackCapabilities,
        } as any)).toMatchObject({
            u1: {
                target: { type: 'before_user_message', userMessageSeq: 1 },
                restoredDraftText: 'external prompt',
            },
        });
    });

    it('ignores non-completed turn entries and malformed metadata when projecting point rollback actions', () => {
        const messagesById: Record<string, Message> = {
            active: userTextMessage('active', 1, 'active prompt'),
            interrupted: userTextMessage('interrupted', 3, 'interrupted prompt'),
            rolledBack: userTextMessage('rolledBack', 5, 'rolled back prompt'),
            malformedEnd: userTextMessage('malformedEnd', 7, 'malformed prompt'),
        };
        const session = createActiveSession({
            path: '/workspace',
            host: 'localhost',
            flavor: 'codex',
            codexBackendMode: 'appServer',
        });

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['active', 'interrupted', 'rolledBack', 'malformedEnd'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({});
    });

    it('keeps historical message filtering independent when projecting app-server point rollback actions', () => {
        const session = createActiveSession({
            path: '/workspace',
            host: 'localhost',
            flavor: 'codex',
            codexBackendMode: 'appServer',
        });
        const sessionWithTurns: Session = {
            ...session,
            rollbackEligibleTurnStarts: [1, 3],
        };
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'first prompt'),
            a1: agentTextMessage('a1', 2, 'reply'),
            u2: userTextMessage('u2', 3, 'second prompt'),
        };

        expect(resolveTranscriptRollbackActions({
            session: sessionWithTurns,
            messageIdsOldestFirst: ['u1', 'a1', 'u2'],
            messagesById,
            rollbackRanges: [{ startSeqInclusive: 1, endSeqInclusive: 2 }],
        })).toEqual({
            u2: {
                target: { type: 'before_user_message', userMessageSeq: 3 },
                restoredDraftText: 'second prompt',
            },
        });
    });

    it('keeps completed app-server turn rollback actions after the session is no longer active', () => {
        const session: Session = {
            ...createActiveSession({
                path: '/workspace',
                host: 'localhost',
                flavor: 'codex',
                codexBackendMode: 'appServer',
            }),
            active: false,
            rollbackEligibleTurnStarts: [3],
        };
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'initial prompt'),
            u2: userTextMessage('u2', 3, 'second prompt'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'u2'],
            messagesById,
            rollbackRanges: [],
        })).toEqual({
            u2: {
                target: { type: 'before_user_message', userMessageSeq: 3 },
                restoredDraftText: 'second prompt',
            },
        });
    });

    it('projects checkpoint code rollback without conversation action when conversation rollback is unsupported', () => {
        const session = createActiveSession({
            path: '/workspace',
            host: 'localhost',
            flavor: 'codex',
            codexBackendMode: 'mcp',
        });
        const messagesById: Record<string, Message> = {
            u1: userTextMessage('u1', 1, 'first prompt'),
            a1: agentTextMessage('a1', 2, 'reply'),
        };

        expect(resolveTranscriptRollbackActions({
            session,
            messageIdsOldestFirst: ['u1', 'a1'],
            messagesById,
            rollbackRanges: [],
            turnChangeSets: [{
                sessionId: 'session-1',
                turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 2 },
                status: 'completed',
                files: [],
                provider: 'scm:git',
                derivedAt: 1,
                repositoryCheckpoint: {
                    version: 1,
                    scopeId: 'session-1:/repo',
                    startRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-start/turn-1',
                    finalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-final/turn-1',
                    baseRefSource: 'turn_start',
                    contentConfidence: 'exact',
                    attributionScope: 'unknown',
                    receipts: [{ id: 'checkpoint.diff_computed' }],
                },
            }],
        })).toEqual({
            a1: {
                target: { type: 'latest_turn' },
                restoredDraftText: null,
                checkpointCodeRollback: {
                    conversationRollbackSupported: false,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0xOi9yZXBv/turn-final/turn-1',
                },
            },
        });
    });
});
