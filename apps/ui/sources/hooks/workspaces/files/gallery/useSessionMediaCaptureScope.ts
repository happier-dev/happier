import * as React from 'react';
import { useServerScopedMachine } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveStoredImageReadScope } from '@/sync/domains/session/media/resolveStoredImageReadScope';

const selectHome = (machine: Machine | null) => machine?.metadata?.happyHomeDir ?? null;

/** The machine id is the capture producer's, which may differ from a managed workspace's controller. */
export function useSessionMediaCaptureScope(serverId: string | null, machineId: string | null) {
    const happyHomeDir = useServerScopedMachine(serverId, machineId, selectHome);
    return React.useMemo(() => resolveStoredImageReadScope({
        storage: 'daemon', sessionScope: null, daemon: { serverId, machineId, happyHomeDir },
    }), [serverId, machineId, happyHomeDir]);
}
