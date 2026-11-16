import * as React from 'react';

import {
    sessionRunnerRuntimeStatusRetention as sessionRunnerRuntimeStatusRetentionStore,
    type SessionRunnerRuntimeStatusIdentity,
    type SessionRunnerRuntimeStatusSnapshot,
} from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention';
import { getSessionRunnerRuntimeStatusSnapshot } from '@/sync/ops/sessionRunnerRestart';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { followSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const ALWAYS_ACTIVE = Object.freeze({ get: () => true, subscribe: () => () => {} });

export function useSessionRunnerRuntimeStatusRetention(input: Readonly<{
    enabled: boolean;
    /** The host's presentation, followed by subscription: a hidden host stops refreshing without rendering. */
    active?: Readonly<{ get: () => boolean; subscribe: (listener: () => void) => () => void }>;
    serverId: string;
    sessionId: string;
    machineId?: string | null;
    activeSelectionRunnerKey?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): Readonly<{
    machineId: string | null;
    status: SessionRunnerRuntimeStatusSnapshot | null;
    invalidateAndRefresh: () => void;
}> {
    const active = input.active ?? ALWAYS_ACTIVE;
    const machineId = typeof input.machineId === 'string' && input.machineId.trim()
        ? input.machineId.trim()
        : null;
    // The identity (and the status it reads) outlives a hide: only the refresh below follows `enabled`,
    // so hiding and showing the Session keeps its last status and its commands' identity.
    const identity = React.useMemo<SessionRunnerRuntimeStatusIdentity | null>(() => (
        input.sessionId && machineId
            ? {
                serverId: input.serverId,
                machineId,
                sessionId: input.sessionId,
            }
            : null
    ), [input.serverId, input.sessionId, machineId]);
    const requestRevisionRef = React.useRef(0);
    const [refreshRevision, setRefreshRevision] = React.useState(0);
    const [, setStatusRevision] = React.useState(0);

    const status = identity ? sessionRunnerRuntimeStatusRetentionStore.read(identity) : null;
    const invalidateAndRefresh = React.useCallback(() => {
        if (!identity) return;
        requestRevisionRef.current += 1;
        setRefreshRevision((revision) => revision + 1);
    }, [identity]);

    React.useEffect(() => {
        if (!input.enabled || !identity || !machineId || !input.sessionId) return;
        return followSignal(active, (isActive) => {
            if (!isActive) return;
            const controller = new AbortController();
            const requestRevision = requestRevisionRef.current;
            const retainedBefore = sessionRunnerRuntimeStatusRetentionStore.read(identity);
            const refresh = sessionRunnerRuntimeStatusRetentionStore.beginRefresh(identity);
            const retire = () => {
                controller.abort();
                sessionRunnerRuntimeStatusRetentionStore.completeRefresh(refresh, null);
            };
            const retirement = input.accountLifetime?.onRetire(retire);
            // Starting a refresh renders only when it changed what this reader shows.
            if (sessionRunnerRuntimeStatusRetentionStore.read(identity) !== retainedBefore) {
                setStatusRevision((revision) => revision + 1);
            }
            void getSessionRunnerRuntimeStatusSnapshot({
                sessionId: input.sessionId,
                machineId,
                serverId: input.serverId,
                signal: controller.signal,
            }).then((state) => {
                if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
                sessionRunnerRuntimeStatusRetentionStore.completeRefresh(refresh, state);
                setStatusRevision((revision) => revision + 1);
            }).catch(() => {
                if (controller.signal.aborted || requestRevision !== requestRevisionRef.current) return;
                sessionRunnerRuntimeStatusRetentionStore.completeRefresh(refresh, null);
                setStatusRevision((revision) => revision + 1);
        });
        return () => {
            retirement?.dispose();
            retire();
        };
        });
    }, [
        active,
        input.enabled,
        identity,
        input.serverId,
        input.sessionId,
        machineId,
        refreshRevision,
        input.activeSelectionRunnerKey,
        input.accountLifetime,
    ]);

    return {
        machineId,
        status,
        invalidateAndRefresh,
    };
}
