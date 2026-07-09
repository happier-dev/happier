import { describe, expect, it } from 'vitest';

import {
    createLegendListRuntimeModel,
    type LegendListRuntimeModelRow,
} from './legendListRuntimeModel';

function rows(count: number, options: Readonly<{ heightPx?: number; start?: number }> = {}): LegendListRuntimeModelRow[] {
    const heightPx = options.heightPx ?? 100;
    const start = options.start ?? 0;
    return Array.from({ length: count }, (_value, index) => ({
        heightPx,
        key: `message-${start + index}`,
    }));
}

describe('Legend List runtime contract model', () => {
    it('opens chronological data at the live tail without using an inverted raw-offset model', () => {
        const model = createLegendListRuntimeModel({
            alignItemsAtEnd: true,
            initialScrollAtEnd: true,
            layoutHeightPx: 300,
            rows: rows(8, { heightPx: 75 }),
        });

        expect(model.observe()).toMatchObject({
            dataOrder: 'oldest-first',
            distanceFromEndPx: 0,
            initialScrollAtEnd: true,
            orientation: 'standard',
            rawOffsetY: 300,
        });
        expect(model.onScreenTopOfRow('message-7')).toBe(225);
    });

    it('keeps the anchored row stable when giant markdown prepends grow after measurement', () => {
        const model = createLegendListRuntimeModel({
            initialScrollAtEnd: false,
            layoutHeightPx: 800,
            maintainVisibleContentPosition: { data: true, size: true },
            rows: rows(12, { heightPx: 220 }),
        });

        model.scrollToIndex({ index: 5, viewPosition: 0.25 });
        const beforeTop = model.onScreenTopOfRow('message-5');

        model.prependOlder([
            { key: 'giant-old-2', heightPx: 3200 },
            { key: 'giant-old-1', heightPx: 2800 },
        ]);
        expect(model.onScreenTopOfRow('message-5')).toBe(beforeTop);

        model.resizeRow('giant-old-2', 6400);
        model.resizeRow('giant-old-1', 5200);

        expect(model.onScreenTopOfRow('message-5')).toBe(beforeTop);
        expect(model.observe().distanceFromEndPx).toBeGreaterThan(0);
    });
});
