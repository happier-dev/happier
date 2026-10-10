import type { CompositionSegment } from '@happier-dev/plugin-ui/presentation';

import type { UsageComposition } from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';

export function usageCompositionShareLabel(share: number): string {
    return share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
}

/** Translate domain facts without recomputing their supplied whole or shares. */
export function usageCompositionSegments(composition: UsageComposition, color: (index: number) => string): readonly CompositionSegment[] {
    return composition.segments.map((segment, index) => ({
        id: segment.key,
        label: t(`usage.tokenMix.${segment.key}`),
        value: segment.tokens,
        color: color(index),
    })).filter(segment => segment.value > 0);
}
