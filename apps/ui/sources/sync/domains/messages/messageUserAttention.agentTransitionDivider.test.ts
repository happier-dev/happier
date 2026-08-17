import { describe, expect, it } from 'vitest';

import {
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_MESSAGE_USER_ATTENTION_IMPACT,
} from '@happier-dev/protocol';

import {
    messageAttentionImpact,
    storedSessionMessageAttentionImpact,
    storedSessionMessageContentAttentionImpactOrNull,
} from './messageUserAttention';

/**
 * The deciding CLIENT-side check for the transition divider's no-attention
 * property.
 *
 * `attentionImpact` is not a persisted column, so a write-time value does not
 * survive a re-read: after a reload the client re-derives attention from stored
 * content. A server-only assertion therefore goes green while unread counts and
 * badges still regress. Both entry points below — the live decoded event and the
 * stored content envelope — must agree, and both must inherit the decision from
 * the shared `agentEventAttentionImpact` owner rather than testing it locally.
 */

function dividerEvent(sidecar: unknown = { v: 1, fromAgentId: 'claude', toAgentId: 'codex' }) {
    return {
        type: 'message',
        message: 'Continued with another Agent.',
        sessionAgentTransitionV1: sidecar,
    };
}

function storedAgentEventContent(data: unknown) {
    return {
        t: 'plain' as const,
        v: { role: 'agent', content: { type: 'event', id: 'agent-transition:local-1', data } },
    };
}

describe('messageUserAttention — Agent-transition divider', () => {
    it('treats a decoded transition divider as carrying no user attention', () => {
        expect(messageAttentionImpact({ kind: 'agent-event', event: dividerEvent() } as never))
            .toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
    });

    it('treats a re-read stored divider envelope as carrying no user attention', () => {
        const content = storedAgentEventContent(dividerEvent());

        expect(storedSessionMessageContentAttentionImpactOrNull(content))
            .toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
        expect(storedSessionMessageAttentionImpact({ content }))
            .toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
    });

    it('keeps ordinary passthrough agent messages attention-bearing', () => {
        const ordinary = { type: 'message', message: 'Context was reset' };

        expect(messageAttentionImpact({ kind: 'agent-event', event: ordinary } as never))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        expect(storedSessionMessageContentAttentionImpactOrNull(storedAgentEventContent(ordinary)))
            .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
    });

    it('does not silence a malformed or unknown-version sidecar, and still renders the row', () => {
        for (const sidecar of [{ v: 2, fromAgentId: 'claude', toAgentId: 'codex' }, { v: 1 }, 'garbage']) {
            expect(messageAttentionImpact({ kind: 'agent-event', event: dividerEvent(sidecar) } as never))
                .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
            // A malformed sidecar must never make the stored row unparseable:
            // `null` here would mean "cannot decide", not "attention-bearing".
            expect(storedSessionMessageContentAttentionImpactOrNull(storedAgentEventContent(dividerEvent(sidecar))))
                .toEqual(SESSION_MESSAGE_USER_ATTENTION_IMPACT);
        }
    });
});
