import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';

import { collapseUnifiedDiffContext } from './collapseUnifiedDiffContext';

function buildDemoUnifiedDiff(): string {
    const lines: string[] = [];
    lines.push('@@ -1,15 +1,15 @@');
    for (let i = 1; i <= 10; i++) {
        lines.push(` line${i}`);
    }
    lines.push('-line11');
    lines.push('+line11changed');
    for (let i = 12; i <= 15; i++) {
        lines.push(` line${i}`);
    }
    lines.push('');
    return lines.join('\n');
}

describe('collapseUnifiedDiffContext', () => {
    it('collapses long context blocks and reports a fold region', () => {
        const unifiedDiff = buildDemoUnifiedDiff();
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff });

        const collapsed = collapseUnifiedDiffContext({
            lines,
            contextThreshold: 6,
            contextRadius: 2,
            expandedRegionIds: new Set(),
        });

        expect(collapsed.regions).toHaveLength(1);
        expect(collapsed.regions[0]?.hiddenCount).toBe(6);

        expect(collapsed.lines.some((l) => l.renderCodeText === 'line1')).toBe(true);
        expect(collapsed.lines.some((l) => l.renderCodeText === 'line2')).toBe(true);
        expect(collapsed.lines.some((l) => l.renderCodeText === 'line9')).toBe(true);
        expect(collapsed.lines.some((l) => l.renderCodeText === 'line10')).toBe(true);

        expect(collapsed.lines.some((l) => l.renderCodeText === 'line3')).toBe(false);
        expect(collapsed.lines.some((l) => l.renderCodeText === 'line8')).toBe(false);

        const line2 = lines.find((l) => l.renderCodeText === 'line2');
        expect(line2).toBeTruthy();
        expect(collapsed.regions[0]?.afterLineId).toBe(line2!.id);
    });

    it('returns original lines when the region is marked expanded', () => {
        const unifiedDiff = buildDemoUnifiedDiff();
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff });

        const firstPass = collapseUnifiedDiffContext({
            lines,
            contextThreshold: 6,
            contextRadius: 2,
            expandedRegionIds: new Set(),
        });

        const regionId = firstPass.regions[0]?.id;
        expect(regionId).toBeTruthy();

        const expanded = collapseUnifiedDiffContext({
            lines,
            contextThreshold: 6,
            contextRadius: 2,
            expandedRegionIds: new Set([regionId!]),
        });

        expect(expanded.regions).toHaveLength(0);
        expect(expanded.lines).toHaveLength(lines.length);
        expect(expanded.lines.some((l) => l.renderCodeText === 'line3')).toBe(true);
        expect(expanded.lines.some((l) => l.renderCodeText === 'line8')).toBe(true);
    });
});
