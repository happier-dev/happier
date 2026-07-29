import type {
    ExternalSessionStatusDemandDaemonMessageV1,
} from '@happier-dev/protocol';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

import {
    createExternalSessionStatusDemandReconciler,
    type ExternalSessionStatusDemandChange,
} from '@/api/session/external/leases/createExternalSessionStatusDemandReconciler';
import {
    loadCanonicalCurrentExternalSessionStatusDemandLink,
} from '@/api/session/external/leases/applyExternalSessionStatusDemandBatch';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

type CurrentLink = Readonly<{
    machineId: string;
    linkGeneration: string;
}>;

export type ExternalSessionStatusDemandChannel = Readonly<{
    onExternalSessionStatusDemand(
        listener: (message: ExternalSessionStatusDemandDaemonMessageV1) => void,
    ): () => void;
    onConnectionStateChange(
        listener: (state: ManagedConnectionState) => void,
    ): () => void;
}>;

type BindExternalSessionStatusDemandParams = Readonly<{
    channel: ExternalSessionStatusDemandChannel;
    machineId?: string;
    loadCurrentLink?: (input: Readonly<{
        sessionId: string;
        machineId: string;
    }>) => Promise<CurrentLink | null>;
    isCurrentLink?: (input: Readonly<{
        sessionId: string;
        linkGeneration: string;
    }>) => boolean | Promise<boolean>;
    subscribeRuntimeReload?: (listener: () => void) => () => void;
    onDemandChanges(
        changes: readonly ExternalSessionStatusDemandChange[],
    ): void | Promise<void>;
}>;

/**
 * Binds the existing machine connection lifecycle to fallback status demand.
 *
 * Current-link truth comes from the canonical linked-session reader. The
 * callback is deliberately the only projection seam so the B1 owner can merge
 * fallback demand with passive/persisted axes without a second link registry.
 */
export function bindExternalSessionStatusDemand(
    params: BindExternalSessionStatusDemandParams,
) {
    const machineId = params.machineId?.trim() ?? '';
    const loadCurrentLink = params.loadCurrentLink
        ?? loadCanonicalCurrentExternalSessionStatusDemandLink;
    if (!params.isCurrentLink && !machineId) {
        throw new Error('External-session status demand requires the current daemon machine id');
    }

    const reconciler = createExternalSessionStatusDemandReconciler({
        isCurrentLink: params.isCurrentLink ?? (async (input) => {
            let current: CurrentLink | null;
            try {
                current = await loadCurrentLink({
                    sessionId: input.sessionId,
                    machineId,
                });
            } catch {
                // Admission remains provisional when canonical state cannot be
                // loaded. The projection callback rechecks the same link and
                // rejects retryable failures into the reconciler's retained-
                // demand backoff instead of silently committing empty demand.
                return true;
            }
            return current?.machineId === machineId
                && current.linkGeneration === input.linkGeneration;
        }),
        onDemandChanges: params.onDemandChanges,
    });
    const pending = new Set<Promise<void>>();
    let disposed = false;
    let wasOnline = false;

    const track = (operation: Promise<unknown>): void => {
        let tracked: Promise<void>;
        tracked = operation
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
                pending.delete(tracked);
            });
        pending.add(tracked);
    };

    const detachMessage = params.channel.onExternalSessionStatusDemand(
        (message: ExternalSessionStatusDemandDaemonMessageV1) => {
            if (disposed) return;
            track(reconciler.accept(message));
        },
    );
    const detachConnection = params.channel.onConnectionStateChange((state) => {
        if (disposed) return;
        if (state.phase === 'online') {
            wasOnline = true;
            track(reconciler.refreshCurrentDemand());
            return;
        }
        if (!wasOnline) return;
        wasOnline = false;
        track(reconciler.clear());
    });
    const detachRuntimeReload = (
        params.subscribeRuntimeReload ?? pluginReloadController.subscribe
    )(() => {
        if (disposed) return;
        track(reconciler.refreshCurrentDemand());
    });

    const flush = async (): Promise<void> => {
        while (pending.size > 0) {
            await Promise.all([...pending]);
        }
    };

    return {
        flush,
        async reconcileCredentialInvalidation(): Promise<void> {
            if (disposed) return;
            await reconciler.reconcileCredentialInvalidation();
        },
        async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            detachMessage();
            detachConnection();
            detachRuntimeReload();
            await flush();
            await reconciler.dispose();
        },
    };
}
