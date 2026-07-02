import type { PopoverPortalOptions } from './_types';

/**
 * Portal options for floating popovers that may render inside Expo Router / Radix modals.
 *
 * `web: true` intentionally leaves web target selection to Popover so it can prefer the
 * active modal-local portal target when one exists, instead of forcing `document.body`.
 */
export const MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS = {
    web: true,
    native: true,
    matchAnchorWidth: false,
    anchorAlign: 'start',
} as const satisfies PopoverPortalOptions;
