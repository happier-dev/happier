import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';

describe('typesRaw context compaction normalization', () => {
    it('normalizes ACP context compaction records as event rows with pause metadata', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'pi',
                data: {
                    type: 'context-compaction',
                    phase: 'completed',
                    lifecycleId: 'pi:context-compaction',
                    source: 'provider-event',
                    continuation: 'paused',
                    pauseReason: 'provider-idle-after-compaction',
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
            provider: 'pi',
            lifecycleId: 'pi:context-compaction',
            source: 'provider-event',
            continuation: 'paused',
            pauseReason: 'provider-idle-after-compaction',
        });
    });
});
