import { describe, expect, it } from 'vitest';

import { buildDarkShadowLevels, buildLightShadowLevels } from './shadowElevation';

describe('shadow elevation recipes', () => {
    it('keeps dark shadow recipes subtler than light recipes across the shared ladder', () => {
        const darkLevels = buildDarkShadowLevels();
        const lightLevels = buildLightShadowLevels();

        for (const level of [1, 2, 3, 4, 5] as const) {
            expect(darkLevels[level].shadowOpacity).toBeLessThan(lightLevels[level].shadowOpacity);
            expect(darkLevels[level].shadowRadius).toBeLessThanOrEqual(lightLevels[level].shadowRadius);
        }
    });
});
