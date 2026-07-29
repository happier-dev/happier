import { describe, expect, it } from 'vitest';

import {
    buildSessionMessagePinIdentity,
    resolveSessionMessagePinRowIdentityKey,
    sessionMessagePinFallbackIdentityKey,
    sessionMessagePinIdentityKey,
    sessionMessagePinRowsMatch,
} from './sessionMessagePinIdentity';

describe('session message pin identity', () => {
    it('keeps whitespace-distinct opaque local route ids separate', () => {
        const leading = buildSessionMessagePinIdentity({
            sessionId: 'session-1', seq: 1, transcriptBlockIndex: null, routeMessageId: 'local: request-1', role: 'user',
        });
        const trailing = buildSessionMessagePinIdentity({
            sessionId: 'session-1', seq: 1, transcriptBlockIndex: null, routeMessageId: 'local:request-1 ', role: 'user',
        });
        expect(leading?.kind === 'route-message-id' ? leading.routeMessageId : null).toBe('local: request-1');
        expect(trailing?.kind === 'route-message-id' ? trailing.routeMessageId : null).toBe('local:request-1 ');
        expect(leading).not.toEqual(trailing);
    });

    it('prefers a stable route message id when the durable seq locator exists', () => {
        expect(buildSessionMessagePinIdentity({
            sessionId: ' session-1 ',
            seq: 42,
            transcriptBlockIndex: 1,
            routeMessageId: ' server:message-42 ',
            role: 'assistant',
        })).toEqual({
            kind: 'route-message-id',
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-42',
            role: 'assistant',
        });
    });

    it('keeps stable route identities distinct for flattened rows sharing one server message', () => {
        const assistantBlock = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-42',
            role: 'assistant',
        });
        const toolBlock = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-42',
            role: 'tool',
        });
        const unknownBlockAssistant = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: null,
            routeMessageId: 'server:message-42',
            role: 'assistant',
        });
        const unknownBlockTool = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: null,
            routeMessageId: 'server:message-42',
            role: 'tool',
        });

        expect(new Set([
            assistantBlock ? sessionMessagePinIdentityKey(assistantBlock) : null,
            toolBlock ? sessionMessagePinIdentityKey(toolBlock) : null,
            unknownBlockAssistant ? sessionMessagePinIdentityKey(unknownBlockAssistant) : null,
            unknownBlockTool ? sessionMessagePinIdentityKey(unknownBlockTool) : null,
        ]).size).toBe(4);
    });

    it('exposes a row identity key for consumers that dedupe pins outside this module', () => {
        const firstBlockKey = resolveSessionMessagePinRowIdentityKey({
            sessionId: 'session-1',
            seq: 43,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-43',
            role: 'assistant',
        });
        const secondBlockKey = resolveSessionMessagePinRowIdentityKey({
            sessionId: 'session-1',
            seq: 43,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-43',
            role: 'assistant',
        });

        expect(firstBlockKey).toBeTruthy();
        expect(secondBlockKey).toBeTruthy();
        expect(firstBlockKey).not.toBe(secondBlockKey);
    });

    it('exposes row matching that treats seq as a route-id locator, not route identity', () => {
        const persistedPin = {
            sessionId: 'session-1',
            seq: 44,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-44',
            role: 'assistant',
        } as const;

        expect(sessionMessagePinRowsMatch(persistedPin, {
            sessionId: 'session-1',
            seq: 45,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-44',
            role: 'assistant',
        })).toBe(true);
        expect(sessionMessagePinRowsMatch(persistedPin, {
            sessionId: 'session-1',
            seq: 44,
            transcriptBlockIndex: 1,
            routeMessageId: 'server:message-44',
            role: 'assistant',
        })).toBe(false);
        expect(sessionMessagePinRowsMatch(persistedPin, {
            sessionId: 'session-1',
            seq: 44,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-44',
            role: 'tool',
        })).toBe(false);
    });

    it('exposes row matching that still reconciles local and server route ids by fallback proof', () => {
        expect(sessionMessagePinRowsMatch({
            sessionId: 'session-1',
            seq: 45,
            transcriptBlockIndex: 2,
            routeMessageId: 'local:temporary-row',
            role: 'tool',
        }, {
            sessionId: 'session-1',
            seq: 45,
            transcriptBlockIndex: 2,
            routeMessageId: 'server:message-45',
            role: 'tool',
        })).toBe(true);
    });

    it('falls back to session, seq, transcript block, and role while a stable route id is unavailable', () => {
        expect(buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: 1,
            routeMessageId: 'transient-render-row-id',
            role: 'assistant',
        })).toEqual({
            kind: 'fallback',
            sessionId: 'session-1',
            seq: 42,
            transcriptBlockIndex: 1,
            role: 'assistant',
        });
    });

    it('does not collapse co-seq rows into one identity', () => {
        const user = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 7,
            transcriptBlockIndex: 0,
            routeMessageId: null,
            role: 'user',
        });
        const assistant = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 7,
            transcriptBlockIndex: 1,
            routeMessageId: null,
            role: 'assistant',
        });
        const tool = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 7,
            transcriptBlockIndex: 2,
            routeMessageId: null,
            role: 'tool',
        });

        expect(new Set([
            user ? sessionMessagePinIdentityKey(user) : null,
            assistant ? sessionMessagePinIdentityKey(assistant) : null,
            tool ? sessionMessagePinIdentityKey(tool) : null,
        ]).size).toBe(3);
    });

    it('rejects identities without the required seq locator, including tool route ids', () => {
        expect(buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: null,
            transcriptBlockIndex: 0,
            routeMessageId: 'tool:call-1',
            role: 'tool',
        })).toBeNull();
        expect(buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: Number.NaN,
            transcriptBlockIndex: 0,
            routeMessageId: 'server:message-1',
            role: 'assistant',
        })).toBeNull();
    });

    it('keeps fallback keys distinct for unknown block positions instead of keying on seq alone', () => {
        const withKnownBlock = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 9,
            transcriptBlockIndex: 0,
            routeMessageId: null,
            role: 'assistant',
        });
        const withUnknownBlock = buildSessionMessagePinIdentity({
            sessionId: 'session-1',
            seq: 9,
            transcriptBlockIndex: null,
            routeMessageId: null,
            role: 'assistant',
        });

        expect(withKnownBlock?.kind).toBe('fallback');
        expect(withUnknownBlock?.kind).toBe('fallback');
        expect(
            withKnownBlock?.kind === 'fallback' ? sessionMessagePinFallbackIdentityKey(withKnownBlock) : null,
        ).not.toBe(
            withUnknownBlock?.kind === 'fallback' ? sessionMessagePinFallbackIdentityKey(withUnknownBlock) : null,
        );
    });
});
