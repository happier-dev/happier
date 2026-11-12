import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import type { CustomModalChromeCardConfig } from '@/modal/types';
import { MODAL_CARD_DIALOG_HEIGHT_RATIO } from './useModalCardDimensions';

/**
 * Shared Share/Connect placement: anchored on wide layouts, a bottom sheet on phones. Either way it hangs over
 * whatever the page shows, so its glass takes the picture-safe coat.
 */
export function createAnchoredSheetChrome(input: Pick<CustomModalChromeCardConfig,
    'title' | 'subtitle' | 'testID' | 'anchor'>): CustomModalChromeCardConfig {
    return {
        kind: 'card',
        material: 'overContent',
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

/**
 * Every value picker hung from its field (a saved secret, a working folder, a Session): the same sheet at a dialog's
 * height, opening below the field (above only when that side has more room) and never covering it (`anchorRole`).
 */
export function createAnchoredPickerChrome(input: Pick<CustomModalChromeCardConfig,
    'title' | 'subtitle' | 'testID' | 'anchor'>): CustomModalChromeCardConfig {
    return {
        ...createAnchoredSheetChrome(input),
        anchorRole: 'picker',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: MODAL_CARD_DIALOG_HEIGHT_RATIO, size: 'md' },
    };
}
