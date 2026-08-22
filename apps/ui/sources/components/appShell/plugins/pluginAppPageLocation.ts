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

export type PluginAppPageLocationOwner = Readonly<{
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
     * Retire a declared Back step because the page's location changed for a
     * reason this owner did not produce. Idempotent.
     */
    retireForeignLocationChange: (currentSubPath: string | null) => void;
    /** Retire everything this owner holds; the mount is gone. */
    dispose: () => void;
}>;

export type CreatePluginAppPageLocationOwnerInput = Readonly<{
    /** The page's current plugin-local location; `null` when it is not a live page. */
    currentSubPath: () => string | null;
    /** Build the host route for one plugin-local location. */
    routePathFor: (subPath: string) => string;
    /** Replace the current history entry. Never a push. */
    replaceLocation: (routePath: string) => void;
    /** The bound controller's mount predicate; this owner never makes a second one. */
    isCurrent: () => boolean;
}>;

function refusal(code: PluginUiHostApiErrorCodeV1, reason: string): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(code, [reason]);
}

export function createPluginAppPageLocationOwner(
    input: CreatePluginAppPageLocationOwnerInput,
): PluginAppPageLocationOwner {
    // The declared step, plus the location it was declared FOR. Keeping both is
    // what lets a foreign location change be told apart from this owner's own
    // replacement without a second navigation observer.
    let declaredBackLocation: string | null = null;
    let settledSubPath: string | null = null;
    let disposed = false;

    const clear = (): void => {
        declaredBackLocation = null;
        settledSubPath = null;
    };

    const handleReplaceRequest: PluginSurfaceHostApiMethodHandler = (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): PluginUiJsonValueV1 => {
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

        const { subPath, backLocation } = parsed.data;
        // The location the page is HEADED for, which is this owner's own last
        // settlement when one is still in flight. Comparing against the
        // rendered location instead would make a burst of replacements each
        // write a route the previous one already asked for.
        const at = settledSubPath ?? input.currentSubPath();
        declaredBackLocation = backLocation === undefined ? null : backLocation;
        settledSubPath = subPath;
        // A replacement TO the location already settled is not a navigation. It
        // still settles, and it still (re)declares the Back step, because the
        // page's state changed even though its location did not.
        if (subPath !== at) input.replaceLocation(input.routePathFor(subPath));
        return { subPath };
    };

    return Object.freeze({
        handleReplaceRequest,
        consumeBack: (): boolean => {
            const target = declaredBackLocation;
            if (disposed || target === null || !input.isCurrent()) return false;
            // Compare against the location this owner last settled on, not the
            // one already rendered: a replacement in flight is where the user
            // is going, and a step equal to it would be a Back that visibly
            // does nothing.
            const at = settledSubPath ?? input.currentSubPath();
            if (at === null || target === at) return false;
            settledSubPath = target;
            input.replaceLocation(input.routePathFor(target));
            return true;
        },
        retireForeignLocationChange: (currentSubPath: string | null): void => {
            if (currentSubPath !== null && currentSubPath === settledSubPath) return;
            clear();
        },
        dispose: (): void => {
            disposed = true;
            clear();
        },
    });
}
