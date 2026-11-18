import { createAnchoredSheetChrome } from '@/modal/components/card/anchoredSheetChrome';
import type { CustomModalChromeCardConfig } from '@/modal/types';

/**
 * The Connect sheet's one presentation (owner O4, 2026-11-18): a multi-field flow, so a centred dialog on wide
 * layouts and a bottom sheet on a phone, whichever control opened it. Decided here for the presenter and the
 * heading alike; no caller anchors it to its trigger.
 */
export function createConnectSheetChrome(input: Pick<CustomModalChromeCardConfig, 'title' | 'subtitle' | 'testID'>): CustomModalChromeCardConfig {
    return createAnchoredSheetChrome(input);
}
