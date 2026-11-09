/** The existing Universal Search dispatch window, shared with mounted searches. */
const SEARCH_QUERY_DEBOUNCE_MS = 120;

/** Schedule remote search work; cancel on new input or disposal. Local filtering
 * stays immediate. An explicit delay retains SelectionList's existing overrides. */
export function scheduleSearchQuery(dispatch: () => void, delayMs = SEARCH_QUERY_DEBOUNCE_MS): () => void {
    if (delayMs <= 0) {
        dispatch();
        return () => {};
    }
    const timer = setTimeout(dispatch, delayMs);
    return () => { clearTimeout(timer); };
}
