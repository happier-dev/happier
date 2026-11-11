import { formatHappierDataShare, type CompositionSegment } from '@happier-dev/plugin-ui/presentation';

import type { UsageComposition } from '@/sync/api/account/usageAnalytics';
import { getPreferredLanguage, t } from '@/text';

export function usageCompositionShareLabel(share: number): string {
    return formatHappierDataShare(share, getPreferredLanguage());
}

/** Translate domain facts without recomputing their supplied whole or shares. */
export function usageCompositionSegments(composition: UsageComposition, color: (index: number) => string): readonly CompositionSegment[] {
    return composition.segments.map((segment, index) => ({
        id: segment.key,
        label: t(`usage.tokenMix.${segment.key}`),
        value: segment.tokens,
        color: color(index),
    })).filter(segment => segment.value !== null && segment.value > 0);
}
