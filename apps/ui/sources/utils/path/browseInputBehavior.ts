/**
 * Adapter factory: produces a `SelectionListInputBehavior` bound to the
 * path-domain helpers in `./browseSegments`. The path picker plugs this
 * into a generic SelectionList without leaking any path-domain types into
 * SelectionList itself.
 *
 * Target machine platform must be threaded through explicitly when the
 * adapter is bound to a remote machine of known platform (e.g. a Mac
 * client browsing a Windows host MUST pass `'windows'`). Default `'auto'`
 * infers from the input string shape, which is correct for local-machine
 * browsing but unreliable for cross-platform remote browsing.
 *
 * NEVER use `navigator.platform` to derive the target platform.
 */

import type { SelectionListInputBehavior } from '@/components/ui/selectionList';

import {
    splitInputIntoDirectoryAndLeaf,
    walkUpOneSegment,
    hasTrailingSeparator,
    isAtRoot,
    type PathTargetPlatform,
} from './browseSegments';

// Re-export the canonical type for ergonomic consumption from this module.
// Lane B published the source of truth in `@/components/ui/selectionList/_types.ts`
// (Phase 2.1); this import collapses the local Phase-10.x stub.
export type { SelectionListInputBehavior };

export type MakePathBrowseInputBehaviorOptions = Readonly<{
    /**
     * Target machine platform. Default `'auto'` — inferred from input shape.
     * Pass an explicit value when bound to a remote machine of known platform.
     */
    targetPlatform?: PathTargetPlatform;
}>;

export function makePathBrowseInputBehavior(
    options: MakePathBrowseInputBehaviorOptions = {},
): SelectionListInputBehavior {
    const target: PathTargetPlatform = options.targetPlatform ?? 'auto';
    return {
        getFilterQueryFromInput: (input) => splitInputIntoDirectoryAndLeaf(input, target).leaf,
        getDynamicSectionSeed: (input) => splitInputIntoDirectoryAndLeaf(input, target).dir,
        // Issue 5 (RUX-2): only walk up when the user has committed the
        // current directory with a trailing separator (`/` or `\` depending
        // on platform). When the input is mid-typed (e.g. `~/Documents/dev`)
        // we return null so the keyboard handler does NOT consume Backspace
        // and the browser performs a normal single-character delete instead
        // of deleting the whole `dev` segment.
        onBackspaceAtEnd: (input) => {
            if (!hasTrailingSeparator(input, target)) return null;
            return walkUpOneSegment(input, target);
        },
        // RUX-13: Shift+Tab walk-up. Distinct from `onBackspaceAtEnd` —
        // Shift+Tab is an EXPLICIT user intent to back up, so it walks up
        // regardless of trailing separator state. Mid-typed `~/Documents/dev`
        // becomes `~/Documents/`. Returns null at platform roots (Unix `/`,
        // home shorthand `~/`, Windows drive root `C:\`, UNC root) so the
        // keyboard handler falls through to native focus traversal.
        onBackUp: (input) => walkUpOneSegment(input, target),
        // Predicate, not a single-character match — paths must suppress on `/` AND `\`
        // AND any root state (Unix `/`, Windows drive `C:\`, UNC `\\srv\share\`).
        shouldSuppressAutocomplete: (input) =>
            hasTrailingSeparator(input, target) || isAtRoot(input, target),
    };
}
