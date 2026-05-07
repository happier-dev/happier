import { describe, expect, it } from 'vitest';

import { ChangeEntrySchema, ChangeKindSchema } from './changes.js';

describe('changes protocol automation kind', () => {
    it('accepts automation in ChangeKindSchema', () => {
        expect(ChangeKindSchema.parse('automation')).toBe('automation');
    });

    it('accepts pet library metadata changes in ChangeKindSchema', () => {
        expect(ChangeKindSchema.parse('pet')).toBe('pet');
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

    it('accepts pet metadata change entries without requiring asset bytes', () => {
        const parsed = ChangeEntrySchema.parse({
            cursor: 44,
            kind: 'pet',
            entityId: 'pet_account_123',
            changedAt: Date.now(),
            hint: {
                domain: 'accountPet',
                action: 'delete',
                accountPetId: 'pet_account_123',
                changedAt: Date.now(),
            },
        });

        expect(parsed.kind).toBe('pet');
        expect(parsed.entityId).toBe('pet_account_123');
        expect(JSON.stringify(parsed.hint)).not.toContain('base64');
    });

    it('keeps future change kinds parseable so older clients can block cursor advancement', () => {
        const parsed = ChangeEntrySchema.parse({
            cursor: 43,
            kind: 'future-domain',
            entityId: 'future_123',
            changedAt: Date.now(),
            hint: null,
        });

        expect(parsed.kind).toBe('future-domain');
    });
});
