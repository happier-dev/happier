import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { GROUPED_SURFACE_RADIUS_PX } from '@/components/ui/lists/pageListMetrics';

export type SurfaceCardPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * The card's corner and inset, published rather than copied.
 *
 * A consumer that has to reach the card's true edge — full-bleed media, an
 * embedded surface, a renderer that owns its own frame — needs the exact numbers
 * this card draws with. Keep these metrics independent of the rendering graph
 * so consumers can use them while their stylesheets initialize.
 */
export const SURFACE_CARD_RADIUS_PX: number = GROUPED_SURFACE_RADIUS_PX;

export const SURFACE_CARD_PADDING_PX: Readonly<Record<
    SurfaceCardPadding,
    Readonly<{ horizontal: number; vertical: number }>
>> = Object.freeze({
    none: Object.freeze({ horizontal: 0, vertical: 0 }),
    // `md` is the card role (the sheet rows' inset); `sm` and `lg` are the steps either side of it.
    sm: Object.freeze({ horizontal: 12, vertical: 12 }),
    md: Object.freeze({ horizontal: HAPPIER_PAGE_METRICS.cardPaddingPx, vertical: HAPPIER_PAGE_METRICS.cardPaddingPx }),
    lg: Object.freeze({ horizontal: 20, vertical: 20 }),
});
