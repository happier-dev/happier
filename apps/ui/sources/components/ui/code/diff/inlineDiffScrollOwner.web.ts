import { useSetting } from '@/sync/store/settingsReadHooks';

import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierre/pierreRuntimeSupport.web';
import { usePierreEnclosingScrollRoot } from './pierre/PierreScrollRootVirtualizerProvider.web';

/** Whether a diff draws through Pierre (a leading lane included: the adapter draws it beside Pierre's rows). */
export function usePierreAllowed(): boolean {
    return useSetting('filesDiffRendererMode') === 'pierre'
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
    return usePierreAllowed() && enclosing;
}
