import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from "./normalize.js";

describe('typesRaw context compaction normalization', () => {
    it('preserves the idle trigger and measured native before/after values in retained history', () => {
        const data = { type: 'context-compaction', phase: 'completed', lifecycleId: 'native-compact',
            trigger: 'idle', tokenCountSource: 'providerReported', tokenCountBefore: 200000, tokenCountAfter: 12000 };
        const normalized = normalizeRawMessage('idle-compact', null, 1000, {
            role: 'agent', content: { type: 'event', id: 'idle-compact', data },
        });
        expect(normalized).toMatchObject({ role: 'event', content: data });
    });
    it('normalizes ACP context compaction records as event rows with pause metadata', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'pi',
                data: {
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'pi:context-compaction',
                    source: 'agent-event',
                    continuation: 'paused',
                    pauseReason: 'agent-idle-after-compaction',
                },
            },
        } satisfies Record<string, unknown>;

        const normalized = normalizeRawMessage('msg-compact-paused', null, 1000, raw);

        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('event');
        if (normalized.role !== 'event') return;
        expect(normalized.content).toMatchObject({
            type: 'context-compaction',
            phase: 'completed',
            agentId: 'pi',
            lifecycleId: 'pi:context-compaction',
            source: 'agent-event',
            continuation: 'paused',
            pauseReason: 'agent-idle-after-compaction',
        });
    });
});
