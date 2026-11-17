import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import type { ShareSheetHost } from './shareSheetHost.js';
export function useShareSheetHost(explicit?: ShareSheetHost): ShareSheetHost {
    const mounted = useOptionalPluginUiPresentationHost();
    const host = explicit ?? mounted?.shareSheet;
    if (!host) throw new Error('ShareSheet requires a host presentation binding.');
    return host;
}
