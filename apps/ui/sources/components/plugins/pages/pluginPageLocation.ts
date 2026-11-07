import {
    PluginUiReplacePageLocationRequestV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiRequestOptions,
} from '@/components/plugins/surfaces/createPluginSurfaceHostApi';

/**
 * The app page's own location, and the one page-internal step system Back
 * returns to (`plugin.ui` §3.7 navigation; `NAV-2`/`NAV-3`).
 *
 * `openSurface` selects a DESTINATION and pushes a history entry. That is the
 * right contract for "take me somewhere" and the wrong one for "the thing I am
 * already looking at is now filtered, ordered or selected differently": a page
 * that pushed on every such change would bury the user's real previous screen
 * under its own interaction trail, and Back would then walk that trail instead
 * of leaving the page. This owner is the other half — same page, new location,
 * no new history entry — and it is deliberately a separate host method rather
 * than a flag on `openSurface`, because it also answers with the location the
 * host settled on.
 *
 * The Back participant is expressed as a LOCATION rather than a callback. A
 * callback cannot be answered synchronously across the host boundary, and a
 * Back whose outcome depends on an in-flight round trip is exactly the bug a
 * user cannot describe — the same press sometimes dismissing a panel and
 * sometimes leaving the page, depending on invisible timing. A declared
 * location lets the host decide from a fact it already holds, and the user
 * always sees the location change that resulted.
 *
 * Three rules keep that decision honest, and each of them exists because its
 * absence is a silent failure:
 *
 * - a declared location equal to the one this owner is settling on is INERT.
 *   It yields rather than consuming a press that would visibly do nothing —
 *   which is also what makes the step SINGLE-SHOT without a second rule:
 *   performing it settles the page AT that location, so the next press finds
 *   it inert and becomes ordinary navigation. A page that wants a further
 *   page-internal step declares it with the replacement that produced it;
 * - any location change the page did not perform itself RETIRES it, so a push,
 *   a deep link or the user's own history walk can never leave a stale Back
 *   step armed against a location it was not declared for.
 */

export type PluginPageLocationOwner = Readonly<{
    /** The `replacePageLocation` host request handler for this exact mount. */
    handleReplaceRequest: PluginSurfaceHostApiMethodHandler;
    /**
     * Perform this page's declared Back step, if it currently has one.
     *
     * `false` means the page did not consume the press, and the caller must let
     * ordinary host navigation happen. It is never "handled, but nothing
     * visible changed".
     */
    consumeBack: () => boolean;
    /**
     * Whether a Back press would spend a declared step right now: the same fact `consumeBack` decides on,
     * readable without spending it, so the page chrome can say who answers Back.
     */
    hasBackStep: () => boolean;
    /** A declared same-editor layout step can be spent without discarding that editor. */
    hasPreservingBackStep: () => boolean;
    /**
     * The page's own declared view the settled location presents (`replacePageLocation` `view`), or `null` for the
     * mounted page itself. A location this owner did not settle on has no known view, so the mounted page names it.
     */
    selectedView: () => string | null;
    /** Whether the rendered location is this page's own settled navigation. */
    ownsCurrentLocation: () => boolean;
    /** Notified whenever {@link hasBackStep} or {@link selectedView} may have changed. Returns its unsubscribe. */
    subscribe: (listener: () => void) => () => void;
    /**
     * Retire a declared Back step because the page's location changed for a
     * reason this owner did not produce. Idempotent.
     */
    retireForeignLocationChange: (currentSubPath: string | null) => void;
    /** Retire everything this owner holds; the mount is gone. */
    dispose: () => void;
}>;

export type CreatePluginPageLocationOwnerInput<Route = string> = Readonly<{
    /** The page's current plugin-local location; `null` when it is not a live page. */
    currentSubPath: () => string | null;
    /**
     * Build the host route for one plugin-local location and the declared view it presents (`null`: the mounted page
     * itself), so a cold load of that route can name the view before the page settles anything.
     */
    routePathFor: (subPath: string, view: string | null) => Route;
    /** The declared view the route this mount arrived on names; it stands until a location the page did not produce. */
    initialView?: string | null;
    /** Replace the current history entry. Never a push. */
    replaceLocation: (routePath: Route) => void;
    /** The bound controller's mount predicate; this owner never makes a second one. */
    isCurrent: () => boolean;
    /** The existing host dirty decision runs before retiring a page-local target. */
    beforeReplace?: (options?: PluginSurfaceHostApiRequestOptions) => boolean | Promise<boolean>;
    /** Same-realm native/RNW pages retain their editor; hosted documents are replaced. */
    allowPreservingReplacement?: boolean;
}>;
/**
 * `Route` is the host route handle in whatever representation the embedding
 * route's router consumes (a plain path string, or a typed `{ pathname, params }`
 * route). This owner never interprets it: it only moves locations through the
 * embedding route's own grammar.
 */

function refusal(code: PluginUiHostApiErrorCodeV1, reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(code, [reason]);
}

/**
 * The route writes a segment's percent-escapes and the router later hands the same segment back decoded, so
 * the rendered location and the one this owner settled on name the same place when they differ only by that
 * decoding. Anything else is a location the page did not produce.
 */
function sameLocation(rendered: string, settled: string): boolean {
    if (rendered === settled) return true;
    try {
        return decodeURIComponent(rendered) === decodeURIComponent(settled);
    } catch {
        return false;
    }
}

export function createPluginPageLocationOwner<Route = string>(
    input: CreatePluginPageLocationOwnerInput<Route>,
): PluginPageLocationOwner {
    // The declared step, plus the location it was declared FOR. Keeping both is
    // what lets a foreign location change be told apart from this owner's own
    // replacement without a second navigation observer.
    let declaredBackLocation: string | null = null;
    let settledView: string | null = input.initialView ?? null;
    // A view the route named belongs to the location it arrived on, so a foreign location change retires it.
    let settledSubPath: string | null = settledView === null ? null : input.currentSubPath();
    let backPreservesUnsavedChanges = false;
    let disposed = false;
    const listeners = new Set<() => void>();
    const notify = (): void => { for (const listener of [...listeners]) listener(); };

    const clear = (): void => {
        declaredBackLocation = null;
        settledSubPath = null;
        settledView = null;
        backPreservesUnsavedChanges = false;
        notify();
    };
    const ownsLocation = (currentSubPath: string | null): boolean => (
        currentSubPath !== null && settledSubPath !== null && sameLocation(currentSubPath, settledSubPath)
    );
    // Compare against the location this owner last settled on, not the one already rendered: a replacement in
    // flight is where the user is going, and a step equal to it would be a Back that visibly does nothing.
    const hasBackStep = (): boolean => {
        const target = declaredBackLocation;
        if (disposed || target === null || !input.isCurrent()) return false;
        const at = settledSubPath ?? input.currentSubPath();
        return at !== null && target !== at;
    };

    const handleReplaceRequest: PluginSurfaceHostApiMethodHandler = (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1> => {
        if (options?.signal?.aborted) {
            return refusal('unavailable', 'plugin_app_page_location_replace_cancelled');
        }
        if (disposed || !input.isCurrent()) {
            return refusal('stale_surface', 'plugin_surface_retired');
        }
        const parsed = PluginUiReplacePageLocationRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) {
            return refusal('invalid_payload', 'plugin_app_page_location_payload_invalid');
        }
        if (input.currentSubPath() === null) {
            // Not a live page location: there is nothing to replace, and
            // fabricating one would let a retired mount write the route.
            return refusal('unavailable', 'plugin_app_page_location_unavailable');
        }

        const { subPath, backLocation, preserveUnsavedChanges, view } = parsed.data;
        if (preserveUnsavedChanges && !input.allowPreservingReplacement) {
            return refusal('unavailable', 'plugin_app_page_layout_continuity_unavailable');
        }
        // The location the page is HEADED for, which is this owner's own last
        // settlement when one is still in flight. Comparing against the
        // rendered location instead would make a burst of replacements each
        // write a route the previous one already asked for.
        const at = settledSubPath ?? input.currentSubPath();
        const settle = (allowed: boolean): PluginUiJsonValueV1 => {
            if (options?.signal?.aborted) return refusal('unavailable', 'plugin_app_page_location_replace_cancelled');
            if (disposed || !input.isCurrent()) return refusal('stale_surface', 'plugin_surface_retired');
            const current = input.currentSubPath();
            if (current === null) return refusal('unavailable', 'plugin_app_page_location_unavailable');
            if (!allowed) return { subPath: settledSubPath ?? current };
            declaredBackLocation = backLocation === undefined ? null : backLocation;
            backPreservesUnsavedChanges = preserveUnsavedChanges === true;
            const viewChanged = (view ?? null) !== settledView;
            settledSubPath = subPath;
            settledView = view ?? null;
            // Updating a Back declaration at the same location retires no editor; the same location in another view
            // still rewrites the route, because the view is part of where the reader is.
            if (subPath !== at || viewChanged) input.replaceLocation(input.routePathFor(subPath, settledView));
            notify();
            return { subPath };
        };
        const allowed = subPath !== at && !preserveUnsavedChanges ? input.beforeReplace?.(options) ?? true : true;
        return allowed instanceof Promise ? allowed.then(settle) : settle(allowed);
    };

    return Object.freeze({
        handleReplaceRequest,
        consumeBack: (): boolean => {
            const target = declaredBackLocation;
            if (!hasBackStep() || target === null) return false;
            settledSubPath = target;
            input.replaceLocation(input.routePathFor(target, settledView));
            notify();
            return true;
        },
        hasBackStep,
        hasPreservingBackStep: () => hasBackStep() && backPreservesUnsavedChanges,
        selectedView: () => settledView,
        ownsCurrentLocation: () => ownsLocation(input.currentSubPath()),
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        retireForeignLocationChange: (currentSubPath: string | null): void => {
            if (ownsLocation(currentSubPath)) return;
            clear();
        },
        dispose: (): void => {
            disposed = true;
            clear();
        },
    });
}
