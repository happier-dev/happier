import { describe, expect, it } from 'vitest';

import {
    MACHINE_STRIP_CHIP_BORDER_PX,
    MACHINE_STRIP_CHIP_GAP_PX,
    MACHINE_STRIP_CHIP_HORIZONTAL_PADDING_PX,
    MACHINE_STRIP_CHIP_INNER_GAP_PX,
    MACHINE_STRIP_CHIP_OVERHEAD_PX,
    MACHINE_STRIP_ESTIMATED_CHAR_WIDTH_PX,
    MACHINE_STRIP_ESTIMATED_WIDE_CHAR_WIDTH_PX,
    MACHINE_STRIP_GLYPH_SIZE_PX,
    MACHINE_STRIP_MIN_ALIAS_BUDGET_PX,
    estimateMachineStripChipWidthPx,
    resolveMachineStripAliasBudgetPx,
    resolveMachineStripMode,
} from './resolveMachineStripMode';

describe('resolveMachineStripMode', () => {
    it('returns null with no machines', () => {
        expect(resolveMachineStripMode({ machineCount: 0, containerWidth: 400 })).toBe(null);
    });

    it('uses inline-metrics for a single machine regardless of width', () => {
        expect(resolveMachineStripMode({ machineCount: 1, containerWidth: 200 })).toBe('inline-metrics');
        expect(resolveMachineStripMode({ machineCount: 1, containerWidth: null })).toBe('inline-metrics');
    });

    it('keeps comfort while the container width is unmeasured', () => {
        expect(resolveMachineStripMode({ machineCount: 3, containerWidth: null })).toBe('comfort');
    });

    it('keeps a three-machine row in comfort inside a narrow sidebar when each machine can afford a short alias', () => {
        // The regression this locks: three machines in a ~220px sessions sidebar used to collapse
        // to compact whenever the full (unrenamed) hostnames overflowed. The budget model keeps
        // comfort as long as every chip can pay for a minimal alias and ellipsizes the rest.
        expect(resolveMachineStripMode({ machineCount: 3, containerWidth: 220 })).toBe('comfort');
        expect(resolveMachineStripAliasBudgetPx(220, 3)).toBeGreaterThanOrEqual(
            MACHINE_STRIP_MIN_ALIAS_BUDGET_PX,
        );
    });

    it('downgrades to compact when even minimal aliases cannot fit', () => {
        const cramped = MACHINE_STRIP_CHIP_OVERHEAD_PX * 5 + MACHINE_STRIP_CHIP_GAP_PX * 4
            + MACHINE_STRIP_MIN_ALIAS_BUDGET_PX * 5 - 1;
        expect(resolveMachineStripMode({ machineCount: 5, containerWidth: cramped })).toBe('compact');
        expect(resolveMachineStripAliasBudgetPx(cramped, 5)).toBe(null);
    });

    it('downgrades to compact for a non-positive measured width', () => {
        expect(resolveMachineStripMode({ machineCount: 3, containerWidth: 0 })).toBe('compact');
    });

    it('splits spare width evenly into per-machine alias budgets', () => {
        expect(resolveMachineStripAliasBudgetPx(220, 3)).toBe(
            Math.floor((220 - MACHINE_STRIP_CHIP_GAP_PX * 2 - MACHINE_STRIP_CHIP_OVERHEAD_PX * 3) / 3),
        );
        expect(resolveMachineStripAliasBudgetPx(400, 2)).toBe(
            Math.floor((400 - MACHINE_STRIP_CHIP_GAP_PX - MACHINE_STRIP_CHIP_OVERHEAD_PX * 2) / 2),
        );
    });

    it('estimates chip width from padding, glyph, gap, border, and code-point count', () => {
        expect(estimateMachineStripChipWidthPx('ab')).toBe(
            MACHINE_STRIP_CHIP_HORIZONTAL_PADDING_PX * 2
            + MACHINE_STRIP_GLYPH_SIZE_PX
            + MACHINE_STRIP_CHIP_INNER_GAP_PX
            + MACHINE_STRIP_CHIP_BORDER_PX * 2
            + 2 * MACHINE_STRIP_ESTIMATED_CHAR_WIDTH_PX,
        );
        expect(estimateMachineStripChipWidthPx('主机')).toBe(
            MACHINE_STRIP_CHIP_HORIZONTAL_PADDING_PX * 2
            + MACHINE_STRIP_GLYPH_SIZE_PX
            + MACHINE_STRIP_CHIP_INNER_GAP_PX
            + MACHINE_STRIP_CHIP_BORDER_PX * 2
            + 2 * MACHINE_STRIP_ESTIMATED_WIDE_CHAR_WIDTH_PX,
        );
    });

    it('counts CJK and fullwidth code points at the wide glyph advance, not the Latin average', () => {
        expect(estimateMachineStripChipWidthPx('京东云')).toBe(
            estimateMachineStripChipWidthPx('abc') + 3 * (MACHINE_STRIP_ESTIMATED_WIDE_CHAR_WIDTH_PX - MACHINE_STRIP_ESTIMATED_CHAR_WIDTH_PX),
        );
        expect(estimateMachineStripChipWidthPx('ＡＢＣ')).toBe(estimateMachineStripChipWidthPx('京东云'));
    });

    it('keeps the chip overhead in sync with its parts', () => {
        expect(MACHINE_STRIP_CHIP_OVERHEAD_PX).toBe(
            MACHINE_STRIP_CHIP_HORIZONTAL_PADDING_PX * 2
            + MACHINE_STRIP_GLYPH_SIZE_PX
            + MACHINE_STRIP_CHIP_INNER_GAP_PX
            + MACHINE_STRIP_CHIP_BORDER_PX * 2,
        );
    });
});
