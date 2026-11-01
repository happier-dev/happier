import { describe, expect, it } from 'vitest';

import type { Message } from './messageTypes';
import { readStoredSessionMessagesReadProjectionFromStateLike } from './readStoredSessionMessages';
import {
    applyMessageChangeToTranscriptRenderableAggregate,
    buildTranscriptRenderableAggregate,
} from './transcriptRenderableAggregate';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';

function agentText(overrides: Partial<Extract<Message, { kind: 'agent-text' }>> = {}): Extract<Message, { kind: 'agent-text' }> {
    return {
        id: 'agent-1',
        kind: 'agent-text',
        localId: null,
        seq: 1,
        createdAt: 1,
        text: 'hello',
        ...overrides,
    };
}

describe('readStoredSessionMessagesReadProjectionFromStateLike', () => {
    it('reads updated aggregate primitives without revisiting history or retaining its mutable identity', () => {
        let historicalVisits = 0;
        const historical: Message = {
            ...agentText({ id: 'historical' }),
            get transcriptObservationProvenance() {
                historicalVisits += 1;
                return undefined;
            },
        };
        const streaming = agentText({ id: 'streaming', seq: 2, createdAt: 2 });
        const aggregate = buildTranscriptRenderableAggregate({ messages: [historical, streaming], completedRequests: null });
        const state = {
            messageIdsOldestFirst: [historical.id, streaming.id],
            messagesById: { [historical.id]: historical, [streaming.id]: streaming },
            renderableAggregate: aggregate,
        };
        historicalVisits = 0;
        const before = readStoredSessionMessagesReadProjectionFromStateLike(state);

        const updated = agentText({ ...streaming, seq: 3, text: 'hello world' });
        expect(applyMessageChangeToTranscriptRenderableAggregate({ aggregate, previous: streaming, next: updated })).toBe(true);
        state.messagesById[streaming.id] = updated;

        expect(readStoredSessionMessagesReadProjectionFromStateLike(state)).toEqual({
            hasMessages: true,
            latestUnreadAffectingMessageSeq: 3,
        });
        expect(before).toEqual({ hasMessages: true, latestUnreadAffectingMessageSeq: 2 });
        expect(historicalVisits).toBe(0);
    });

    it('falls back to current messages after a non-monotone change invalidates the aggregate', () => {
        const earlier = agentText({ id: 'earlier', seq: 1 });
        const latest = agentText({ id: 'latest', seq: 2, createdAt: 2 });
        const aggregate = buildTranscriptRenderableAggregate({ messages: [earlier, latest], completedRequests: null });
        const recovered = agentText({
            ...latest,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        });
        expect(applyMessageChangeToTranscriptRenderableAggregate({ aggregate, previous: latest, next: recovered })).toBe(false);

        expect(readStoredSessionMessagesReadProjectionFromStateLike({
            messageIdsOldestFirst: [earlier.id, recovered.id],
            messagesById: { [earlier.id]: earlier, [recovered.id]: recovered },
            renderableAggregate: undefined,
        })).toEqual({ hasMessages: true, latestUnreadAffectingMessageSeq: 1 });
    });

    it('uses the existing array and record representations when no aggregate is available', () => {
        const message = agentText({ seq: 7 });
        expect(readStoredSessionMessagesReadProjectionFromStateLike({ messages: [message] })).toEqual({
            hasMessages: true,
            latestUnreadAffectingMessageSeq: 7,
        });
        expect(readStoredSessionMessagesReadProjectionFromStateLike({
            messageIdsOldestFirst: [message.id],
            messagesMap: { [message.id]: message },
        })).toEqual({ hasMessages: true, latestUnreadAffectingMessageSeq: 7 });
        expect(readStoredSessionMessagesReadProjectionFromStateLike(undefined)).toEqual({
            hasMessages: false,
            latestUnreadAffectingMessageSeq: null,
        });
    });

    it('preserves recovered-only and maintenance-only transcript presence without terminal seq fallback', () => {
        const recovered = agentText({
            seq: 7,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        });
        const maintenance = {
            id: 'maintenance',
            kind: 'agent-event',
            seq: 8,
            createdAt: 8,
            event: {
                type: 'connected-service-account-switch',
                serviceId: 'openai-codex',
                groupId: 'codex-main',
                fromProfileId: 'profile-a',
                toProfileId: 'profile-b',
                reason: 'usage_limit',
                mode: 'hot_apply',
            },
        } satisfies Message;
        for (const message of [recovered, maintenance]) {
            const messages = [message];
            for (const renderableAggregate of [undefined, buildTranscriptRenderableAggregate({ messages, completedRequests: null })]) {
                const messagesProjection = readStoredSessionMessagesReadProjectionFromStateLike({ messages, renderableAggregate });
                expect(messagesProjection).toEqual({ hasMessages: true, latestUnreadAffectingMessageSeq: null });
                expect(resolveSessionReadableSeq({ messagesProjection, sessionSeq: 9, latestTurnStatus: 'completed', includeTerminalSessionSeq: true })).toBeNull();
                expect(resolveSessionReadableSeq({ messagesProjection, latestReadyEventSeq: 10, includeTerminalSessionSeq: true })).toBe(10);
            }
        }
    });
});
