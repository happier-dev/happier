import { useRef } from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/** Retained custody becomes readable when its existing Home/Account scope hydrates. */
export function usePendingTerminalConnect(enabled = true) {
    const { serverId } = useActiveServerSnapshot(enabled);
    useActiveServerAccountScope(serverId);
    // The pending owner also expires retained custody at the next natural render.
    const pending = enabled ? getPendingTerminalConnect() : null;
    const retained = useRef(pending);
    retained.current = retainIfEqual(retained.current, pending);
    return retained.current;
}
