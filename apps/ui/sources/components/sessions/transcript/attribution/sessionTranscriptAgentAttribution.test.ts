import { describe, expect, it } from 'vitest';

import { createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';

import {
    EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX,
    buildSessionTranscriptAgentAttributionIndex,
    resolveHistoricalAgentIdAtSeq,
} from './sessionTranscriptAgentAttribution';

describe('sessionTranscriptAgentAttribution', () => {
    it('attributes rows on either side of the divider to the Agent that was running', () => {
        const fixture = createMixedAgentTranscriptFixture();
        const index = buildSessionTranscriptAgentAttributionIndex(fixture.messages);

        expect(index.boundaries).toEqual([
            { seq: fixture.dividerSeq, fromAgentId: fixture.sourceAgentId, toAgentId: fixture.targetAgentId },
        ]);
        for (const seq of fixture.sourceAgentSeqs) {
            expect(resolveHistoricalAgentIdAtSeq(index, seq)).toBe(fixture.sourceAgentId);
        }
        for (const seq of fixture.targetAgentSeqs) {
            expect(resolveHistoricalAgentIdAtSeq(index, seq)).toBe(fixture.targetAgentId);
        }
    });

    it('leaves a Session that never switched Agent entirely neutral', () => {
        const fixture = createMixedAgentTranscriptFixture({ withDivider: false });
        const index = buildSessionTranscriptAgentAttributionIndex(fixture.messages);

        // Referential identity matters: an unswitched transcript must not
        // invalidate a memo or re-render a row on every message.
        expect(index).toBe(EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX);
        for (const seq of fixture.neutralSeqs) {
            expect(resolveHistoricalAgentIdAtSeq(index, seq)).toBeNull();
        }
    });

    it('resolves neutral for a row that has no sequence', () => {
        const fixture = createMixedAgentTranscriptFixture();
        const index = buildSessionTranscriptAgentAttributionIndex(fixture.messages);

        expect(fixture.unsequencedMessage.seq).toBeUndefined();
        expect(resolveHistoricalAgentIdAtSeq(index, fixture.unsequencedMessage.seq)).toBeNull();
        expect(resolveHistoricalAgentIdAtSeq(index, Number.NaN)).toBeNull();
    });

    it('walks multiple dividers so a twice-switched Session keeps each span truthful', () => {
        const first = createMixedAgentTranscriptFixture({ sourceAgentId: 'claude', targetAgentId: 'codex' });
        const second = createMixedAgentTranscriptFixture({ sourceAgentId: 'codex', targetAgentId: 'gemini' });
        const secondDivider = second.messages.find((message) => message.kind === 'agent-event')!;
        const index = buildSessionTranscriptAgentAttributionIndex([
            ...first.messages,
            { ...secondDivider, id: 'msg-35', seq: 35 } as typeof secondDivider,
        ]);

        expect(index.boundaries.map((boundary) => boundary.seq)).toEqual([15, 35]);
        expect(resolveHistoricalAgentIdAtSeq(index, 10)).toBe('claude');
        expect(resolveHistoricalAgentIdAtSeq(index, 30)).toBe('codex');
        expect(resolveHistoricalAgentIdAtSeq(index, 40)).toBe('gemini');
    });

    it('refuses a malformed divider rather than half-attributing the transcript', () => {
        const fixture = createMixedAgentTranscriptFixture();
        const broken = fixture.messages.map((message) => (
            message.kind === 'agent-event'
                ? { ...message, event: { type: 'message', message: 'x', sessionAgentTransitionV1: { v: 1 } } }
                : message
        ));

        const index = buildSessionTranscriptAgentAttributionIndex(broken as typeof fixture.messages);

        expect(index).toBe(EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX);
        expect(resolveHistoricalAgentIdAtSeq(index, 10)).toBeNull();
    });

    it('does not attribute a valid divider sidecar on an ordinary localId', () => {
        const fixture = createMixedAgentTranscriptFixture();
        const forged = fixture.messages.map((message) => (
            message.kind === 'agent-event'
                ? { ...message, localId: 'ordinary-local-id' }
                : message
        ));

        const index = buildSessionTranscriptAgentAttributionIndex(forged as typeof fixture.messages);

        expect(index).toBe(EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX);
        expect(resolveHistoricalAgentIdAtSeq(index, 10)).toBeNull();
    });

    it('retains a valid divider naming an installed Agent outside the bundled catalog', () => {
        const fixture = createMixedAgentTranscriptFixture({ targetAgentId: 'acme-installed-agent' });

        const index = buildSessionTranscriptAgentAttributionIndex(fixture.messages);

        expect(index.boundaries).toEqual([{
            seq: fixture.dividerSeq,
            fromAgentId: fixture.sourceAgentId,
            toAgentId: 'acme-installed-agent',
        }]);
        expect(resolveHistoricalAgentIdAtSeq(index, fixture.targetAgentSeqs[0])).toBe('acme-installed-agent');
    });
});
