import type { PendingMessage } from '@/sync/domains/state/storageTypes';

export function readLatestLocalOutboundPendingUserMessageAt(messages: readonly PendingMessage[]): number | null {
    let latest: number | null = null;
    for (const message of messages) {
        if (message.source !== 'local_outbound') continue;
        const createdAt = message.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}
