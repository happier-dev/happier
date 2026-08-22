import { describe, expect, it } from 'vitest';

import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
} from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    buildAgentTransitionDividerLocalId,
    createAgentEventMessageFixture,
    createAgentTransitionDividerEventFixture,
    createStoredAgentEventContentFixture,
} from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';
import {
    createSessionListReadableActivityAccumulator,
    foldSessionListReadableActivityMessage,
} from '@/sync/domains/session/listing/sessionListReadableActivity';

import {
    messageAttentionImpact,
    storedSessionMessageAttentionImpact,
    storedSessionMessageContentAttentionImpactOrNull,
} from './messageUserAttention';

function agentText(): Message {
    return {
        id: 'agent-1',
        kind: 'agent-text',
        localId: null,
        createdAt: 1_000,
        seq: 10,
        text: 'hello',
    } as unknown as Message;
}

describe('messageUserAttention — Agent-transition divider', () => {
    it('treats a decoded transition divider as carrying no user attention', () => {
        const divider = createAgentEventMessageFixture(createAgentTransitionDividerEventFixture());

        expect(messageAttentionImpact(divider)).toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
    });

    it('treats a stored transition divider content envelope as carrying no user attention', () => {
        const content = createStoredAgentEventContentFixture(createAgentTransitionDividerEventFixture());
        const localId = buildAgentTransitionDividerLocalId('local-1');

        expect(storedSessionMessageContentAttentionImpactOrNull(content, localId))
            .toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
        expect(storedSessionMessageAttentionImpact({ content, localId }))
            .toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
    });

    it('does not silence a stored divider envelope carried by an ordinary localId', () => {
        // The reserved namespace is refused by every generic ingress, so a
        // sidecar under an ordinary localId cannot have come from the cutover
        // and must not buy an attention exemption.
        const content = createStoredAgentEventContentFixture(createAgentTransitionDividerEventFixture());

        expect(storedSessionMessageContentAttentionImpactOrNull(content, 'local-1'))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        expect(storedSessionMessageAttentionImpact({ content, localId: null }))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });

    it('keeps ordinary passthrough agent messages attention-bearing', () => {
        const ordinary = { type: 'message', message: 'Context was reset' };

        expect(messageAttentionImpact(createAgentEventMessageFixture(ordinary)))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        expect(storedSessionMessageContentAttentionImpactOrNull(
            createStoredAgentEventContentFixture(ordinary),
            buildAgentTransitionDividerLocalId('local-1'),
        )).toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });

    it('does not silence a malformed or unknown-version transition sidecar', () => {
        const wrongVersion = createAgentTransitionDividerEventFixture({
            sidecar: { v: 2, fromAgentId: 'claude', toAgentId: 'codex' },
        });
        const missingAgents = createAgentTransitionDividerEventFixture({ sidecar: { v: 1 } });

        expect(messageAttentionImpact(createAgentEventMessageFixture(wrongVersion)))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        expect(messageAttentionImpact(createAgentEventMessageFixture(missingAgents)))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });

    it('does not advance the canonical unread/meaningful-activity fold', () => {
        const accumulator = createSessionListReadableActivityAccumulator();
        foldSessionListReadableActivityMessage(accumulator, agentText());
        const afterAgentText = { ...accumulator };

        foldSessionListReadableActivityMessage(
            accumulator,
            createAgentEventMessageFixture(createAgentTransitionDividerEventFixture()),
        );

        expect(accumulator).toEqual(afterAgentText);
        expect(accumulator.latestCommittedMessageSeq).toBe(10);
        expect(accumulator.latestCommittedMessageCreatedAt).toBe(1_000);
    });
});
