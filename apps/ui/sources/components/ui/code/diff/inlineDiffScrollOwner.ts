/**
 * Native diffs keep their own bounded list: only the web Pierre renderer windows against an enclosing scroller.
 * Known limitation (Providers ORCH 2026-11-20): a native diff in a list keeps its capped inner list.
 */
export function useInlineDiffSharesEnclosingScroller(): boolean {
    return false;
}
