import { describe, expect, it } from 'vitest';

import { createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';

import {
    buildSessionTranscriptAgentAttributionIndex,
    resolveHistoricalAgentIdAtSeq,
} from './sessionTranscriptAgentAttribution';

/**
 * A divider chain is only evidence while it is continuous: one divider's target
 * is the next divider's source. When it is not, the two dividers disagree about
 * who was running between them, and the span they enclose has no proven Agent.
 */
describe('sessionTranscriptAgentAttribution — discontinuous divider chain', () => {
    function buildChain(
        first: Readonly<{ from: string; to: string }>,
        second: Readonly<{ from: string; to: string }>,
    ) {
        const firstFixture = createMixedAgentTranscriptFixture({
            sourceAgentId: first.from,
            targetAgentId: first.to,
        });
        const secondFixture = createMixedAgentTranscriptFixture({
            sourceAgentId: second.from,
            targetAgentId: second.to,
        });
        const secondDivider = secondFixture.messages.find((message) => message.kind === 'agent-event')!;
        return buildSessionTranscriptAgentAttributionIndex([
            ...firstFixture.messages,
            { ...secondDivider, id: 'msg-35', seq: 35 } as typeof secondDivider,
        ]);
    }

    it('is neutral across a span the two enclosing dividers disagree about', () => {
        // claude → codex at 15, then gemini → claude at 35: nothing proves who
        // produced rows 16..35, so the span must not be labelled.
        const index = buildChain({ from: 'claude', to: 'codex' }, { from: 'gemini', to: 'claude' });

        expect(index.boundaries.map((boundary) => boundary.seq)).toEqual([15, 35]);
        expect(resolveHistoricalAgentIdAtSeq(index, 30)).toBeNull();
    });

    it('keeps the spans the break does not touch', () => {
        const index = buildChain({ from: 'claude', to: 'codex' }, { from: 'gemini', to: 'claude' });

        // Before the first divider and after the last one, each divider is the
        // only evidence and nothing contradicts it.
        expect(resolveHistoricalAgentIdAtSeq(index, 10)).toBe('claude');
        expect(resolveHistoricalAgentIdAtSeq(index, 40)).toBe('claude');
    });

    it('still attributes a continuous chain', () => {
        const index = buildChain({ from: 'claude', to: 'codex' }, { from: 'codex', to: 'gemini' });

        expect(resolveHistoricalAgentIdAtSeq(index, 30)).toBe('codex');
    });
});
