export type ToolTimelineDensity = 'comfortable' | 'compact';

export function deriveToolTimelineDensity(effectiveDetailLevel: 'title' | 'compact' | 'summary' | 'full'): {
    density: ToolTimelineDensity;
    iconSize: 16 | 18;
} {
    if (effectiveDetailLevel === 'title' || effectiveDetailLevel === 'compact') {
        return { density: 'compact', iconSize: 16 };
    }
    return { density: 'comfortable', iconSize: 18 };
}
