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

        // Malformed known output types should not crash normalization; they are treated as unknown and dropped.
        expect(normalizeRawMessage('msg-assistant-1', null, 1000, raw)).toBeNull();
    });
});
