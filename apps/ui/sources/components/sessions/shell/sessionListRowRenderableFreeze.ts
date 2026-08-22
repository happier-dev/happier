/**
 * Whether a row boundary should read live renderables rather than its frozen snapshot.
 *
 * A row freezes its renderables while the surface is inactive, which is correct for a row that was
 * already showing something: it keeps its content instead of re-subscribing. But the frozen snapshot
 * starts EMPTY, and an inactive row does not read the store — so a row whose FIRST render happens
 * while the surface is inactive would present an empty snapshot for as long as the surface stays
 * away, which renders as a blank row.
 *
 * MEASURED in remote-dev, where the same shape exists: half-swipe back immediately after opening a
 * session and the list is blank; wait first and it is populated. Rows mount during that window
 * because the list keeps rendering behind the pushed screen.
 *
 * "Never frozen anything yet" is therefore a distinct state from "frozen an empty snapshot", and
 * only the former justifies reading live while inactive.
 */
export function shouldReadLiveRowRenderables(params: Readonly<{
    dataActive: boolean;
    hasFrozenRenderables: boolean;
}>): boolean {
    if (params.dataActive) return true;
    return !params.hasFrozenRenderables;
}
