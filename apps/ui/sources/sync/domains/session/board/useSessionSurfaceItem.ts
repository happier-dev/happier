import * as React from 'react';
import { useSessionSystemRecordBinding } from '@/sync/domains/sessionSystemRecords/useSessionSystemRecordBinding';
import { observeSessionSurfaceItem, type SessionSurfaceItemBinding } from './observeSessionSurfaceItem';

export function useSessionSurfaceItem(input: Readonly<{
    serverId: string | null;
    sessionId: string;
    itemId: string;
    enabled: boolean;
}>): SessionSurfaceItemBinding & Readonly<{ refresh: () => void }> {
    const observe = React.useCallback((options: Omit<Parameters<typeof observeSessionSurfaceItem>[0], 'itemId'>) => observeSessionSurfaceItem({ ...options, itemId: input.itemId }), [input.itemId]);
    const loading = React.useMemo(() => ({ status: 'ready' as const, item: { itemId: input.itemId, revision: null, state: { kind: 'loading' as const } }, freshness: 'stale' as const, reachability: 'unknown' as const, loading: 'initial' as const }), [input.itemId]);
    return useSessionSystemRecordBinding<Extract<SessionSurfaceItemBinding, { status: 'ready' }>>({ ...input, observe, loading });
}
