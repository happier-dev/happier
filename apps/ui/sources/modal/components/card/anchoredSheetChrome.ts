import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import type { CustomModalChromeCardConfig } from '@/modal/types';

/** Shared Share/Connect placement: anchored on wide layouts, a bottom sheet on phones. */
export function createAnchoredSheetChrome(input: Pick<CustomModalChromeCardConfig,
    'title' | 'subtitle' | 'testID' | 'anchor'>): CustomModalChromeCardConfig {
    return {
        kind: 'card',
        phonePresentation: 'sheet',
        testID: input.testID,
        title: input.title,
        ...(input.subtitle ? { subtitle: input.subtitle } : {}),
        scrollHost: 'bounded',
        bodyScroll: 'none',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.92, size: 'md' },
        ...(input.anchor ? { anchor: input.anchor } : {}),
    };
}
