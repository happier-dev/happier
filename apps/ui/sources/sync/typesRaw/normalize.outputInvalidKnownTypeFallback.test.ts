import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { RawRecordSchema } from './schemas';

describe('typesRaw output schema (fail-soft)', () => {
    it('accepts malformed assistant output payloads by treating them as unknown output types', () => {
        const raw: any = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'assistant-1',
                    message: {
                        role: 'assistant',
                        model: 'model-x',
                        // Invalid shape for known assistant outputs (should be array of content blocks).
                        content: 'hello',
                    },
                },
            },
        };

        const parsed = RawRecordSchema.safeParse(raw);
        expect(parsed.success).toBe(true);

        // Malformed known output types should not crash normalization; they should be surfaced as an opaque message.
        const normalized = normalizeRawMessage('msg-assistant-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        if (normalized.role !== 'agent') return;
        expect(normalized.content[0]?.type).toBe('text');
    });

    it('materializes assistant string content as a text block (no unsupported placeholder)', () => {
        const raw: any = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'assistant-1',
                    message: {
                        role: 'assistant',
                        model: 'model-x',
                        content: 'hello',
                    },
                },
            },
        };

        const normalized = normalizeRawMessage('msg-assistant-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('agent');
        if (normalized.role !== 'agent') return;
        expect(normalized.content[0]).toEqual(
            expect.objectContaining({
                type: 'text',
                text: 'hello',
            }),
        );
    });
});
