import type { Server } from 'socket.io';

/** Data-free server-side (cluster) notice that a peer's push may have been lost; it carries no authority. */
export const CLUSTER_PUSH_RECONCILE_EVENT = 'happier:cluster-push-reconcile:v1';

type ClusterPushLossSignals = Readonly<{
    onSocketClusterAdapterResubscribed: (listener: () => void) => () => void;
    onSocketClusterAdapterPublishLost: (listener: () => void) => () => void;
}>;

/**
 * Pushes between API nodes (Machine access loss, sign-in policy change) travel as at-most-once
 * Redis Pub/Sub. Each node runs `reconcile` (its one-time re-check of local live sockets) when its
 * own subscriber is ready again after an outage, and when a peer announces that a message it
 * published was lost to that peer's own Redis outage (the receivers' subscribers may have stayed up).
 * The sender has already applied its own pushes locally, so it only announces.
 */
export function registerClusterPushReconcile(input: Readonly<{
    io: Pick<Server, 'on' | 'off' | 'serverSideEmit'>;
    redis: ClusterPushLossSignals;
    reconcile: () => void;
}>): () => void {
    const releaseResubscribed = input.redis.onSocketClusterAdapterResubscribed(input.reconcile);
    const releasePublishLost = input.redis.onSocketClusterAdapterPublishLost(() => {
        input.io.serverSideEmit(CLUSTER_PUSH_RECONCILE_EVENT, { v: 1 });
    });
    const onPeerReconcile = () => { input.reconcile(); };
    input.io.on(CLUSTER_PUSH_RECONCILE_EVENT, onPeerReconcile);
    return () => {
        releaseResubscribed();
        releasePublishLost();
        input.io.off(CLUSTER_PUSH_RECONCILE_EVENT, onPeerReconcile);
    };
}
