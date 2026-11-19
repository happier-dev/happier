/**
 * The pinned conversation's turns take the panel room its header, asks and reply field leave, and scroll only
 * past it. The island asks the planner for every turn (`overflow` joins the panel's natural height), and the
 * planner caps that at the visible frame, so the conversation grows to the screen and the height is decided
 * once, natively, for both drawing and input.
 */
export function resolveConversationTurnsLayout(params: Readonly<{
    /** The panel's content room inside the planner's island; `null` until it is known. */
    available: number | null;
    /** Everything in the conversation that is not the turns' viewport. */
    chromeHeight: number;
    turnsContentHeight: number;
}>): Readonly<{ maxHeight: number | undefined; overflow: number }> {
    if (params.available === null) return { maxHeight: undefined, overflow: 0 };
    const maxHeight = Math.max(0, params.available - params.chromeHeight);
    return { maxHeight, overflow: Math.max(0, params.turnsContentHeight - maxHeight) };
}
