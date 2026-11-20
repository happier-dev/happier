import { useSetting } from '@/sync/store/settingsReadHooks';

import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierre/pierreRuntimeSupport.web';
import { usePierreEnclosingScrollRoot } from './pierre/PierreScrollRootVirtualizerProvider.web';

/** Whether a diff draws through Pierre. A leading lane is a per-line cell only the canonical line renderer draws. */
export function usePierreAllowed(rendersLeadingLane: boolean): boolean {
    return useSetting('filesDiffRendererMode') === 'pierre'
        && !rendersLeadingLane
        && isPierreDiffKillSwitchEnabled()
        && supportsPierreRuntime();
}

/**
 * A large inline diff in a list that hands over its scroller windows its lines against that one scroller (QB-81),
 * so its caller draws no capped viewport. Only Pierre can window a body against another scroller.
 */
export function useInlineDiffSharesEnclosingScroller(): boolean {
    // Known limitation (Providers ORCH 2026-11-20): with the "happier" renderer setting the diff keeps its capped inner list.
    const enclosing = usePierreEnclosingScrollRoot();
    return usePierreAllowed(false) && enclosing;
}
