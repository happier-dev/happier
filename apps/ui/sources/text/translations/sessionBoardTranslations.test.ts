import { describe, expect, it } from 'vitest';

import { sessionBoardTranslations } from './sessionBoardTranslations';

describe('sessionBoardTranslations', () => {
    it('localizes distinct Show and Expand Companion labels with the item count in every locale', () => {
        const englishShow = sessionBoardTranslations.en.companion.a11y.show({ count: 3 });

        for (const [locale, board] of Object.entries(sessionBoardTranslations)) {
            const show = board.companion.a11y.show({ count: 3 });
            const expand = board.companion.a11y.expand({ count: 3 });

            expect(show, `${locale} Show Companion count`).toContain('3');
            expect(show, `${locale} Show and Expand semantics`).not.toBe(expand);
            if (locale !== 'en') {
                expect(show, `${locale} Show Companion localization`).not.toBe(englishShow);
            }
        }
    });
});
