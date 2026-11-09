/** Body-level floating surfaces share one ordering; nested portals remain inside their parent layer. */
export const POPOVER_Z_INDEX = 200000;
/**
 * A hover card (a preview the resting pointer opened) stacks under every popover or menu someone opened,
 * whichever mounted last: its content (`+1`) stays below an opened popover's backdrop (`POPOVER_Z_INDEX`).
 */
export const HOVER_CARD_Z_INDEX = POPOVER_Z_INDEX - 2;
export const MODAL_Z_INDEX_STEP = 10;
export const MODAL_Z_INDEX = POPOVER_Z_INDEX + MODAL_Z_INDEX_STEP;
export const SCREEN_OVERLAY_Z_INDEX = 90000;
/**
 * The transient notice (toast) floats above every dialog: its Undo stays reachable while the dialog
 * that made the change is still open. Stacked modals step by `MODAL_Z_INDEX_STEP`, far below this.
 */
export const NOTICE_Z_INDEX = POPOVER_Z_INDEX + 100000;

/** The attribute that marks a screen's popover host (see `PopoverPortalTargetProvider`). */
export const POPOVER_PORTAL_HOST_ATTRIBUTE = 'data-happy-popover-portal-host';

/**
 * Where a web modal mounts, so a dialog opened from inside a popover (Add → Session, Add → confirm)
 * always stacks above it. A screen's popover host that sits on the body is only a positioning layer
 * at `POPOVER_Z_INDEX`, appended in screen mount order: a modal inside it would be ordered against
 * other screens' popovers by DOM order. The modal goes to the body instead, where `MODAL_Z_INDEX`
 * orders it above every popover layer. A host kept inside a route modal's dialog is that dialog's
 * containment boundary, and the modal stays in it.
 */
export function resolveModalWebPortalTarget<Target>(inherited: Target | null, body: Target | null): Target | null {
    const candidate = inherited as unknown as { parentElement?: unknown; hasAttribute?: (name: string) => boolean } | null;
    if (candidate && candidate.parentElement === body && candidate.hasAttribute?.(POPOVER_PORTAL_HOST_ATTRIBUTE) === true) return body;
    return inherited ?? body;
}
