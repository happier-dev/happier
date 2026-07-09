import { describe, expect, it } from 'vitest';

import { resolveSessionMessagePinRowIdentityKey } from '@/sync/domains/messages/pins/sessionMessagePinIdentity';

import {
    deriveTranscriptNavigationEntries,
} from './deriveTranscriptNavigationEntries';
import type {
    TranscriptNavigationDerivationMode,
    TranscriptNavigationLoadedMessage,
    TranscriptNavigationPin,
    TranscriptNavigationRemoteUserTurn,
} from './transcriptNavigationTypes';

function loadedMessage(
    overrides: Partial<TranscriptNavigationLoadedMessage> & Pick<TranscriptNavigationLoadedMessage, 'messageId' | 'role' | 'seq' | 'text'>,
): TranscriptNavigationLoadedMessage {
    return {
        sessionId: 's1',
        messageId: overrides.messageId,
        routeMessageId: overrides.routeMessageId ?? `server:${overrides.messageId}`,
        seq: overrides.seq,
        transcriptBlockIndex: overrides.transcriptBlockIndex !== undefined ? overrides.transcriptBlockIndex : 0,
        role: overrides.role,
        text: overrides.text,
        createdAtMs: overrides.createdAtMs ?? Number(overrides.seq) * 100,
        loaded: overrides.loaded ?? true,
    };
}

function remoteTurn(overrides: Partial<TranscriptNavigationRemoteUserTurn> & Pick<TranscriptNavigationRemoteUserTurn, 'seq' | 'text'>): TranscriptNavigationRemoteUserTurn {
    return {
        sessionId: 's1',
        seq: overrides.seq,
        text: overrides.text,
        createdAtMs: overrides.createdAtMs ?? overrides.seq * 100,
    };
}

function pin(
    overrides: Partial<TranscriptNavigationPin> & Pick<TranscriptNavigationPin, 'seq' | 'role'>,
): TranscriptNavigationPin {
    return {
        version: 1,
        sessionId: 's1',
        seq: overrides.seq,
        transcriptBlockIndex: overrides.transcriptBlockIndex !== undefined ? overrides.transcriptBlockIndex : 0,
        routeMessageId: overrides.routeMessageId ?? null,
        role: overrides.role,
        pinnedAtMs: overrides.pinnedAtMs ?? overrides.seq * 1000,
        label: overrides.label ?? null,
    };
}

function derive(params: Readonly<{
    mode?: TranscriptNavigationDerivationMode;
    loadedMessages?: readonly TranscriptNavigationLoadedMessage[];
    remoteUserTurns?: readonly TranscriptNavigationRemoteUserTurn[];
    pins?: readonly TranscriptNavigationPin[];
}>) {
    return deriveTranscriptNavigationEntries({
        sessionId: 's1',
        mode: params.mode ?? 'all',
        loadedMessages: params.loadedMessages ?? [],
        remoteUserTurns: params.remoteUserTurns ?? [],
        pins: params.pins ?? [],
    });
}

describe('deriveTranscriptNavigationEntries', () => {
    it('derives loaded user turns with prompt primary text and final loaded assistant response preview', () => {
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, text: '  Explain the plan  ' }),
                loadedMessage({ messageId: 'a1-draft', role: 'assistant', seq: 1, transcriptBlockIndex: 1, text: 'Draft response' }),
                loadedMessage({ messageId: 'a1-final', role: 'assistant', seq: 1, transcriptBlockIndex: 2, text: 'Final response' }),
                loadedMessage({ messageId: 'u2', role: 'user', seq: 2, text: 'Next task' }),
                loadedMessage({ messageId: 'a2', role: 'assistant', seq: 2, transcriptBlockIndex: 1, text: 'Second response' }),
            ],
        });

        expect(entries).toEqual([
            expect.objectContaining({
                id: 's1:user-turn:1',
                sessionId: 's1',
                seq: 1,
                routeMessageId: 'server:u1',
                kind: 'user-turn',
                role: 'user',
                label: 'Explain the plan',
                promptPreview: 'Explain the plan',
                responsePreview: 'Final response',
                createdAtMs: 100,
                pinned: false,
                pinnedAtMs: null,
                loaded: true,
            }),
            expect.objectContaining({
                id: 's1:user-turn:2',
                kind: 'user-turn',
                promptPreview: 'Next task',
                responsePreview: 'Second response',
                loaded: true,
            }),
        ]);
    });

    it('preserves the real nullable transcriptBlockIndex as entry identity instead of the ordering surrogate', () => {
        // Runtime user messages commonly carry transcriptBlockIndex null; the entry
        // identity must mirror that so runtime anchor/jump row-proof matching
        // (entry.transcriptBlockIndex vs message.transcriptBlockIndex) can succeed.
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, transcriptBlockIndex: null, text: 'Question' }),
                loadedMessage({ messageId: 'a1', role: 'assistant', seq: 1, transcriptBlockIndex: 1, text: 'Answer' }),
            ],
            remoteUserTurns: [
                remoteTurn({ seq: 0, text: 'Remote prompt' }),
            ],
        });

        expect(entries.map((entry) => ({ id: entry.id, transcriptBlockIndex: entry.transcriptBlockIndex }))).toEqual([
            { id: 's1:user-turn:0', transcriptBlockIndex: null },
            { id: 's1:user-turn:1', transcriptBlockIndex: null },
        ]);
    });

    it('preserves nullable transcriptBlockIndex identity for pinned entries without a pin or loaded block index', () => {
        const entries = derive({
            mode: 'pinned',
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, transcriptBlockIndex: null, text: 'Question' }),
                loadedMessage({ messageId: 'a1', role: 'assistant', seq: 1, transcriptBlockIndex: null, text: 'Answer' }),
            ],
            pins: [
                pin({ seq: 1, transcriptBlockIndex: null, role: 'assistant', routeMessageId: 'server:a1', pinnedAtMs: 10 }),
            ],
        });

        expect(entries.map((entry) => ({ id: entry.id, transcriptBlockIndex: entry.transcriptBlockIndex }))).toEqual([
            { id: expect.stringContaining('s1:pinned:'), transcriptBlockIndex: null },
        ]);
    });

    it('attaches the assistant reply that follows a user turn even when seqs are per-message', () => {
        // Real transcripts assign each message its own monotonic seq, so the
        // assistant reply never shares the user turn's seq. Turn membership is
        // positional: everything after this user message and before the next
        // one belongs to this turn.
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'a0', role: 'assistant', seq: 0, text: 'Greeting before any turn' }),
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, text: 'Question one' }),
                loadedMessage({ messageId: 'a2', role: 'assistant', seq: 2, transcriptBlockIndex: 1, text: 'Answer one' }),
                loadedMessage({ messageId: 'u3', role: 'user', seq: 3, text: 'Question two' }),
                loadedMessage({ messageId: 'a4', role: 'assistant', seq: 4, transcriptBlockIndex: 1, text: 'Answer two' }),
            ],
        });

        expect(entries).toEqual([
            expect.objectContaining({
                id: 's1:user-turn:1',
                seq: 1,
                promptPreview: 'Question one',
                responsePreview: 'Answer one',
            }),
            expect.objectContaining({
                id: 's1:user-turn:3',
                seq: 3,
                promptPreview: 'Question two',
                responsePreview: 'Answer two',
            }),
        ]);
    });

    it('ignores out-of-order assistant rows whose seq precedes the active user turn', () => {
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u5', role: 'user', seq: 5, text: 'Question' }),
                loadedMessage({ messageId: 'a4', role: 'assistant', seq: 4, transcriptBlockIndex: 1, text: 'Stale earlier answer' }),
            ],
        });

        expect(entries).toEqual([
            expect.objectContaining({
                id: 's1:user-turn:5',
                seq: 5,
                promptPreview: 'Question',
                responsePreview: null,
            }),
        ]);
    });

    it('merges remote user-history turns as unloaded prompt-only anchors without assistant previews', () => {
        const entries = derive({
            remoteUserTurns: [
                remoteTurn({ seq: 1, text: 'Earlier prompt' }),
                remoteTurn({ seq: 2, text: 'Middle prompt' }),
            ],
            loadedMessages: [
                loadedMessage({ messageId: 'u3', role: 'user', seq: 3, text: 'Loaded prompt' }),
                loadedMessage({ messageId: 'a3', role: 'assistant', seq: 3, transcriptBlockIndex: 1, text: 'Loaded answer' }),
            ],
        });

        expect(entries.map((entry) => ({
            id: entry.id,
            seq: entry.seq,
            promptPreview: entry.promptPreview,
            responsePreview: entry.responsePreview,
            loaded: entry.loaded,
        }))).toEqual([
            { id: 's1:user-turn:1', seq: 1, promptPreview: 'Earlier prompt', responsePreview: null, loaded: false },
            { id: 's1:user-turn:2', seq: 2, promptPreview: 'Middle prompt', responsePreview: null, loaded: false },
            { id: 's1:user-turn:3', seq: 3, promptPreview: 'Loaded prompt', responsePreview: 'Loaded answer', loaded: true },
        ]);
    });

    it('drops remote-seeded turns whose seq falls inside the loaded window coverage', () => {
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u10', role: 'user', seq: 10, text: 'We have been working on some refactoring' }),
                loadedMessage({ messageId: 'a11', role: 'assistant', seq: 11, transcriptBlockIndex: 1, text: 'Refactor reply' }),
                loadedMessage({ messageId: 'u14', role: 'user', seq: 14, text: 'Next question' }),
            ],
            remoteUserTurns: [
                // Same seq as the loaded user row: merged by the loaded row.
                remoteTurn({ seq: 10, text: 'We have been working on some refactoring' }),
                // Same seq as a loaded assistant row: phantom, must not appear.
                remoteTurn({ seq: 11, text: 'We have been working on some refactoring' }),
                // Inside the loaded coverage but with no loaded row: phantom, must not appear.
                remoteTurn({ seq: 13, text: 'We have been working on some refactoring' }),
                // Genuinely older than the loaded window: kept as an unloaded anchor.
                remoteTurn({ seq: 4, text: 'Genuinely older prompt' }),
            ],
        });

        expect(entries.map((entry) => ({ id: entry.id, seq: entry.seq, loaded: entry.loaded }))).toEqual([
            { id: 's1:user-turn:4', seq: 4, loaded: false },
            { id: 's1:user-turn:10', seq: 10, loaded: true },
            { id: 's1:user-turn:14', seq: 14, loaded: true },
        ]);
    });

    it('merges remote-seeded turns with loaded rows by route id when available', () => {
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u20', role: 'user', seq: 20, text: 'Loaded prompt', routeMessageId: 'server:u20' }),
            ],
            remoteUserTurns: [
                // Seq drifted below the loaded coverage but identifies the same message by route id.
                { sessionId: 's1', seq: 3, text: 'Loaded prompt', createdAtMs: 300, routeMessageId: 'server:u20' },
                remoteTurn({ seq: 2, text: 'Different earlier prompt' }),
            ],
        });

        expect(entries.map((entry) => ({ id: entry.id, seq: entry.seq, loaded: entry.loaded }))).toEqual([
            { id: 's1:user-turn:2', seq: 2, loaded: false },
            { id: 's1:user-turn:20', seq: 20, loaded: true },
        ]);
    });

    it('includes pinned assistant and tool ticks in All mode without adding every transcript row', () => {
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, text: 'Question one' }),
                loadedMessage({ messageId: 'a1', role: 'assistant', seq: 1, transcriptBlockIndex: 1, text: 'Important answer' }),
                loadedMessage({ messageId: 'u2', role: 'user', seq: 2, text: 'Question two' }),
                loadedMessage({ messageId: 'a2', role: 'assistant', seq: 2, transcriptBlockIndex: 1, text: 'Unpinned answer' }),
                loadedMessage({ messageId: 'tool2', role: 'tool', seq: 2, transcriptBlockIndex: 2, text: 'Read src/index.ts' }),
            ],
            pins: [
                pin({ seq: 1, transcriptBlockIndex: 1, role: 'assistant', routeMessageId: 'server:a1', pinnedAtMs: 10 }),
                pin({ seq: 2, transcriptBlockIndex: 2, role: 'tool', routeMessageId: 'tool:read-src', pinnedAtMs: 20 }),
            ],
        });

        expect(entries.map((entry) => ({
            kind: entry.kind,
            seq: entry.seq,
            routeMessageId: entry.routeMessageId,
            promptPreview: entry.promptPreview,
            responsePreview: entry.responsePreview,
            pinned: entry.pinned,
            loaded: entry.loaded,
        }))).toEqual([
            {
                kind: 'user-turn',
                seq: 1,
                routeMessageId: 'server:u1',
                promptPreview: 'Question one',
                responsePreview: 'Important answer',
                pinned: false,
                loaded: true,
            },
            {
                kind: 'pinned-assistant',
                seq: 1,
                routeMessageId: 'server:a1',
                promptPreview: 'Question one',
                responsePreview: 'Important answer',
                pinned: true,
                loaded: true,
            },
            {
                kind: 'user-turn',
                seq: 2,
                routeMessageId: 'server:u2',
                promptPreview: 'Question two',
                responsePreview: 'Unpinned answer',
                pinned: false,
                loaded: true,
            },
            {
                kind: 'pinned-tool',
                seq: 2,
                routeMessageId: 'tool:read-src',
                promptPreview: 'Question two',
                responsePreview: 'Read src/index.ts',
                pinned: true,
                loaded: true,
            },
        ]);
    });

    it('returns only pinned entries in Pinned mode, including pinned user turns as pinned-user entries', () => {
        const entries = derive({
            mode: 'pinned',
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, text: 'Pinned question' }),
                loadedMessage({ messageId: 'a1', role: 'assistant', seq: 1, transcriptBlockIndex: 1, text: 'Pinned answer' }),
                loadedMessage({ messageId: 'u2', role: 'user', seq: 2, text: 'Unpinned question' }),
            ],
            pins: [
                pin({ seq: 1, transcriptBlockIndex: 0, role: 'user', routeMessageId: 'server:u1', pinnedAtMs: 10 }),
                pin({ seq: 1, transcriptBlockIndex: 1, role: 'assistant', routeMessageId: 'server:a1', pinnedAtMs: 20 }),
            ],
        });

        expect(entries.map((entry) => ({
            kind: entry.kind,
            seq: entry.seq,
            routeMessageId: entry.routeMessageId,
            promptPreview: entry.promptPreview,
            responsePreview: entry.responsePreview,
            pinnedAtMs: entry.pinnedAtMs,
        }))).toEqual([
            {
                kind: 'pinned-user',
                seq: 1,
                routeMessageId: 'server:u1',
                promptPreview: 'Pinned question',
                responsePreview: 'Pinned answer',
                pinnedAtMs: 10,
            },
            {
                kind: 'pinned-assistant',
                seq: 1,
                routeMessageId: 'server:a1',
                promptPreview: 'Pinned question',
                responsePreview: 'Pinned answer',
                pinnedAtMs: 20,
            },
        ]);
    });

    it('does not synthesize assistant previews for unloaded pinned assistant entries', () => {
        const entries = derive({
            remoteUserTurns: [remoteTurn({ seq: 4, text: 'Remote prompt context' })],
            pins: [
                pin({
                    seq: 4,
                    transcriptBlockIndex: 1,
                    role: 'assistant',
                    routeMessageId: 'server:unloaded-answer',
                    label: 'Pinned response',
                    pinnedAtMs: 40,
                }),
            ],
        });

        expect(entries).toEqual([
            expect.objectContaining({
                kind: 'user-turn',
                seq: 4,
                promptPreview: 'Remote prompt context',
                responsePreview: null,
                loaded: false,
            }),
            expect.objectContaining({
                kind: 'pinned-assistant',
                seq: 4,
                routeMessageId: 'server:unloaded-answer',
                label: 'Pinned response',
                promptPreview: 'Remote prompt context',
                responsePreview: null,
                loaded: false,
            }),
        ]);
    });

    it('keeps unloaded pinned fallback labels language-neutral for the UI layer', () => {
        const entries = derive({
            pins: [
                pin({
                    seq: 5,
                    transcriptBlockIndex: 1,
                    role: 'assistant',
                    routeMessageId: 'server:unloaded-answer',
                    pinnedAtMs: 50,
                }),
            ],
        });

        expect(entries).toEqual([
            expect.objectContaining({
                kind: 'pinned-assistant',
                label: '',
                fallbackLabelKind: 'pinned-assistant',
                promptPreview: null,
                responsePreview: null,
                loaded: false,
            }),
        ]);
    });

    it('keeps same-route same-seq different-block pins independent with matching previews', () => {
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, text: 'Question one', routeMessageId: 'server:u1' }),
                loadedMessage({
                    messageId: 'a1-block-1',
                    role: 'assistant',
                    seq: 1,
                    transcriptBlockIndex: 1,
                    routeMessageId: 'server:assistant-message',
                    text: 'First assistant block',
                }),
                loadedMessage({
                    messageId: 'a1-block-2',
                    role: 'assistant',
                    seq: 1,
                    transcriptBlockIndex: 2,
                    routeMessageId: 'server:assistant-message',
                    text: 'Second assistant block',
                }),
            ],
            pins: [
                pin({
                    seq: 1,
                    transcriptBlockIndex: 1,
                    role: 'assistant',
                    routeMessageId: 'server:assistant-message',
                    pinnedAtMs: 10,
                }),
                pin({
                    seq: 1,
                    transcriptBlockIndex: 2,
                    role: 'assistant',
                    routeMessageId: 'server:assistant-message',
                    pinnedAtMs: 20,
                }),
            ],
        });

        const pinnedEntries = entries.filter((entry) => entry.kind === 'pinned-assistant');

        expect(pinnedEntries).toHaveLength(2);
        expect(new Set(pinnedEntries.map((entry) => entry.id)).size).toBe(2);
        expect(pinnedEntries.map((entry) => ({
            seq: entry.seq,
            routeMessageId: entry.routeMessageId,
            responsePreview: entry.responsePreview,
            pinnedAtMs: entry.pinnedAtMs,
        }))).toEqual([
            {
                seq: 1,
                routeMessageId: 'server:assistant-message',
                responsePreview: 'First assistant block',
                pinnedAtMs: 10,
            },
            {
                seq: 1,
                routeMessageId: 'server:assistant-message',
                responsePreview: 'Second assistant block',
                pinnedAtMs: 20,
            },
        ]);
    });

    it('orders entries chronologically and suppresses duplicate remote turns and duplicate pins', () => {
        const entries = derive({
            remoteUserTurns: [
                remoteTurn({ seq: 2, text: 'Remote duplicate should lose' }),
                remoteTurn({ seq: 1, text: 'Older remote prompt' }),
            ],
            loadedMessages: [
                loadedMessage({ messageId: 'u2', role: 'user', seq: 2, text: 'Loaded prompt wins' }),
                loadedMessage({ messageId: 'a2', role: 'assistant', seq: 2, transcriptBlockIndex: 1, text: 'Pinned answer once' }),
            ],
            pins: [
                pin({ seq: 2, transcriptBlockIndex: 1, role: 'assistant', routeMessageId: 'server:a2', pinnedAtMs: 200 }),
                pin({ seq: 2, transcriptBlockIndex: 1, role: 'assistant', routeMessageId: 'server:a2', pinnedAtMs: 300 }),
            ],
        });

        expect(entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            seq: entry.seq,
            promptPreview: entry.promptPreview,
            responsePreview: entry.responsePreview,
            pinnedAtMs: entry.pinnedAtMs,
        }))).toEqual([
            {
                id: 's1:user-turn:1',
                kind: 'user-turn',
                seq: 1,
                promptPreview: 'Older remote prompt',
                responsePreview: null,
                pinnedAtMs: null,
            },
            {
                id: 's1:user-turn:2',
                kind: 'user-turn',
                seq: 2,
                promptPreview: 'Loaded prompt wins',
                responsePreview: 'Pinned answer once',
                pinnedAtMs: null,
            },
            {
                // Pinned entry ids follow the canonical pin row identity key.
                id: `s1:pinned:${resolveSessionMessagePinRowIdentityKey({
                    sessionId: 's1',
                    seq: 2,
                    transcriptBlockIndex: 1,
                    routeMessageId: 'server:a2',
                    role: 'assistant',
                })}`,
                kind: 'pinned-assistant',
                seq: 2,
                promptPreview: 'Loaded prompt wins',
                responsePreview: 'Pinned answer once',
                pinnedAtMs: 200,
            },
        ]);
    });

    it('strips markdown syntax (tables, emphasis, headers, code) from entry previews', () => {
        const tableMarkdown = 'Board status:\n\n| Lane | State |\n|---|---|\n| **CORRIDOR-2a** | done |';
        const entries = derive({
            loadedMessages: [
                loadedMessage({ messageId: 'u1', role: 'user', seq: 1, text: '## Heading\n`inline` **bold** _em_' }),
                loadedMessage({ messageId: 'a1', role: 'assistant', seq: 1, transcriptBlockIndex: 1, text: tableMarkdown }),
            ],
            pins: [pin({ seq: 1, role: 'assistant', transcriptBlockIndex: 1, routeMessageId: 'server:a1' })],
        });

        const userTurn = entries.find((entry) => entry.kind === 'user-turn');
        expect(userTurn?.promptPreview).toBe('Heading inline bold em');
        const pinned = entries.find((entry) => entry.kind === 'pinned-assistant');
        expect(pinned?.label).not.toMatch(/[|#*`]/);
        expect(pinned?.label).toContain('Board status:');
        expect(pinned?.label).toContain('CORRIDOR-2a');
    });
});
