import { Platform } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';

/**
 * A side pane's one text edge: its header title, every section label in its body and every row's
 * leading mark start this far from the pane's edge (calm-shell lab `.cs-phd` / `.cs-pbody`). It is the
 * page row inset, so a pane reads like a page's sheet; the body reads it through `useSidePaneTextEdge`.
 */
export const PANE_TEXT_INSET_PX = HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx;

/**
 * The top band a column opens with: the session header over the transcript and the header of a
 * side pane beside it. Both take their height from `useHeaderHeight()` and their text and inset
 * from here, so side by side they read as one band with one baseline.
 */
export const HEADER_BAND_HORIZONTAL_PADDING_PX = Platform.OS === 'ios' ? 8 : PANE_TEXT_INSET_PX;

export const HEADER_BAND_TITLE_TEXT = {
    ...Typography.variant('heading'),
} as const;

export const HEADER_BAND_SUBTITLE_TEXT = {
    ...Typography.variant('meta'),
    marginTop: 1,
} as const;
