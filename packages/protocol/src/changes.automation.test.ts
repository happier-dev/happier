import { describe, expect, it } from 'vitest';

import { ChangeEntrySchema, ChangeKindSchema } from './changes.js';

describe('changes protocol automation kind', () => {
    it('accepts automation in ChangeKindSchema', () => {
        expect(ChangeKindSchema.parse('automation')).toBe('automation');
    });

    it('accepts automation entries in ChangeEntrySchema', () => {
        const parsed = ChangeEntrySchema.parse({
            cursor: 42,
            kind: 'automation',
            entityId: 'auto_123',
            changedAt: Date.now(),
            hint: { full: true },
        });

        expect(parsed.kind).toBe('automation');
        expect(parsed.entityId).toBe('auto_123');
    });
});
