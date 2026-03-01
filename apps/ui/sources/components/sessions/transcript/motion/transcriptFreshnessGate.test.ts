import { describe, expect, it } from 'vitest';

import { createTranscriptFreshnessGate } from './transcriptFreshnessGate';

describe('createTranscriptFreshnessGate', () => {
    it('treats unseen items within freshness window as fresh once', () => {
        let now = 1000;
        const gate = createTranscriptFreshnessGate({ freshnessMs: 500, getNowMs: () => now });

        expect(gate.consumeFreshness({ id: 'm1', createdAt: 800 })).toBe(true);
        expect(gate.consumeFreshness({ id: 'm1', createdAt: 800 })).toBe(false);
    });

    it('treats items older than freshness window as not fresh', () => {
        const gate = createTranscriptFreshnessGate({ freshnessMs: 200, getNowMs: () => 1000 });

        expect(gate.consumeFreshness({ id: 'm1', createdAt: 700 })).toBe(false);
        expect(gate.consumeFreshness({ id: 'm2', createdAt: 799 })).toBe(false);
    });

    it('does not share seen state across ids', () => {
        const gate = createTranscriptFreshnessGate({ freshnessMs: 1000, getNowMs: () => 1000 });

        expect(gate.consumeFreshness({ id: 'a', createdAt: 999 })).toBe(true);
        expect(gate.consumeFreshness({ id: 'b', createdAt: 999 })).toBe(true);
        expect(gate.consumeFreshness({ id: 'a', createdAt: 999 })).toBe(false);
    });
});
