import { describe, expect, it } from 'vitest';
import { ManagedServiceNativeLogResultV1Schema } from './nativeLogsV1.js';

const recipeRemedy = { pluginId: 'happier.machine.recipes', recipeId: 'journal-reader', revision: '1' };

describe('native journal permission remedy', () => {
    it('preserves a canonical recipe reference on a denied read without inventing setup inputs or approval', () => {
        const denied = { kind: 'unavailable', reason: 'denied', recipeRemedy };
        expect(ManagedServiceNativeLogResultV1Schema.safeParse(denied)).toMatchObject({ success: true, data: denied });
    });

    it('retains existing unavailable results and refuses authority-bearing remedy extras', () => {
        expect(ManagedServiceNativeLogResultV1Schema.safeParse({ kind: 'unavailable', reason: 'denied' }).success).toBe(true);
        for (const extra of [{ journalGroup: 'guessed' }, { inputs: {} }, { approved: true }]) {
            expect(ManagedServiceNativeLogResultV1Schema.safeParse({ kind: 'unavailable', reason: 'denied',
                recipeRemedy: { ...recipeRemedy, ...extra } }).success).toBe(false);
        }
        expect(ManagedServiceNativeLogResultV1Schema.safeParse({ kind: 'unavailable', reason: 'denied',
            recipeRemedy: { ...recipeRemedy, pluginId: 'not a plugin' } }).success).toBe(false);
    });
});
