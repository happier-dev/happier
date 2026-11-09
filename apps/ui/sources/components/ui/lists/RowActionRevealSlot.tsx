import * as React from 'react';
import { HappierRowActionRevealSlot, type HappierRowActionRevealSlotProps } from '@happier-dev/plugin-ui/presentation';

/** An action icon that mounts on its slot's first reveal (see `HappierRowActionDeferredIcon`). */
export { HappierRowActionDeferredIcon as RowActionDeferredIcon } from '@happier-dev/plugin-ui/presentation';

import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type RowActionRevealSlotProps = Omit<HappierRowActionRevealSlotProps, 'readReducedMotion'>;

/**
 * Happier core's binding of the shared row-action reveal (`@happier-dev/plugin-ui/presentation`, the same
 * owner a public List row's overflow reveals through). It supplies only core's reduced-motion read, taken
 * when the slot renders rather than subscribed: one media-query listener per mounted slot is what the
 * shared watch exists to avoid.
 */
export function RowActionRevealSlot(props: RowActionRevealSlotProps): React.ReactElement {
    return <HappierRowActionRevealSlot {...props} readReducedMotion={readReducedMotionPreference} />;
}
