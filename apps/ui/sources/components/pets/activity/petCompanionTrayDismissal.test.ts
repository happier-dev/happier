import { describe, expect, it } from 'vitest';

import {
    PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX,
    appendDismissedPetCompanionTrayItemKey,
    normalizeDismissedPetCompanionTrayItemKeys,
} from './petCompanionTrayDismissal';

describe('pet companion tray dismissal keys', () => {
    it('deduplicates dismissed activity-version keys and keeps the most recent bounded set', () => {
        const staleKeys = Array.from(
            { length: PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX + 2 },
            (_, index) => `waiting:session:${index}`,
        );

        const next = appendDismissedPetCompanionTrayItemKey(staleKeys, 'waiting:session:new');

        expect(next).toHaveLength(PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX);
        expect(next).not.toContain('waiting:session:0');
        expect(next).toContain('waiting:session:new');
        expect(appendDismissedPetCompanionTrayItemKey(next, 'waiting:session:new')).toEqual(next);
    });

    it('ignores malformed persisted dismissal values', () => {
        expect(normalizeDismissedPetCompanionTrayItemKeys([
            'waiting:session:1',
            '',
            '   ',
            42,
            'failed:session:2',
        ])).toEqual(['waiting:session:1', 'failed:session:2']);
    });
});
