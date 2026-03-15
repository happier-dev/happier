import { describe, expect, it } from 'vitest';

import { resolveActiveThinkingMessageId } from '@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId';

describe('resolveActiveThinkingMessageId', () => {
    it('returns null when session is not thinking', () => {
        expect(
            resolveActiveThinkingMessageId({
                sessionThinking: false,
                latestThinkingMessageId: 'm1',
                latestCommittedMessageId: 'm1',
                latestThinkingMessageActivityAtMs: 1_000,
                nowMs: 1_050,
                staleMs: 120_000,
            }),
        ).toBeNull();
    });

    it('returns null when no latest thinking message is known', () => {
        expect(
            resolveActiveThinkingMessageId({
                sessionThinking: true,
                latestThinkingMessageId: null,
                latestCommittedMessageId: null,
                latestThinkingMessageActivityAtMs: null,
                nowMs: 1_050,
                staleMs: 120_000,
            }),
        ).toBeNull();
    });

    it('returns the latest thinking message id when not stale', () => {
        expect(
            resolveActiveThinkingMessageId({
                sessionThinking: true,
                latestThinkingMessageId: 'm2',
                latestCommittedMessageId: 'm2',
                latestThinkingMessageActivityAtMs: 1_000,
                nowMs: 1_050,
                staleMs: 120_000,
            }),
        ).toBe('m2');
    });

    it('returns null when another committed message follows the thinking message', () => {
        expect(
            resolveActiveThinkingMessageId({
                sessionThinking: true,
                latestThinkingMessageId: 'm2',
                latestCommittedMessageId: 'm3',
                latestThinkingMessageActivityAtMs: 1_000,
                nowMs: 1_050,
                staleMs: 120_000,
            }),
        ).toBeNull();
    });

    it('returns null when the latest thinking message is stale', () => {
        expect(
            resolveActiveThinkingMessageId({
                sessionThinking: true,
                latestThinkingMessageId: 'm2',
                latestCommittedMessageId: 'm2',
                latestThinkingMessageActivityAtMs: 1_000,
                nowMs: 200_000,
                staleMs: 120_000,
            }),
        ).toBeNull();
    });
});
