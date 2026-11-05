import { describe, expect, it } from 'vitest';

import { buildDesktopActivityOverlayQaModel, desktopActivityOverlayQaSeedModes } from './desktopActivityOverlayQaFixtures.mjs';

describe('desktop activity overlay QA seeds', () => {
    it.each(desktopActivityOverlayQaSeedModes)('builds a visible island for the declared %s seed', (mode) => {
        const model = buildDesktopActivityOverlayQaModel(mode);

        expect(model.visible).toBe(true);
        expect(model.expanded.cards?.length ?? 0).toBeGreaterThan(0);
    });
});
