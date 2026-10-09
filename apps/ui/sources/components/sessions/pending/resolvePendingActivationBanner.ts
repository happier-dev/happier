import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';

export type PendingActivationBannerPresentation = Readonly<{
    kind: 'waiting_offline' | 'waiting' | 'failed' | 'queued' | 'queued_offline';
    row: PendingMessage | null;
    primaryAction: 'retry' | 'resume' | 'process_when_online' | null;
    secondaryAction: 'keep_queued' | null;
    settingsAction: 'settings';
    managedWakeProjection?: ManagedWakeProjection;
}>;

function isEligiblePendingUserRow(message: PendingMessage): boolean {
    if (message.localId == null || message.messageRole !== 'user') return false;
    if (message.pendingRequestedActionMalformed === true) return false;
    if (message.pendingOutboxOperation === 'cancel') return false;
    if (
        message.pendingDeliveryStatus === 'blocked'
        || message.pendingDeliveryStatus === 'server_delivering'
        || message.deliveryStatus === 'accepted'
    ) return false;
    return message.pendingDeliveryStatus === 'server_queued'
        || message.deliveryStatus === 'queued';
}

function comparePendingRows(left: PendingMessage, right: PendingMessage): number {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return (left.localId ?? left.id).localeCompare(right.localId ?? right.id);
}

export function resolvePendingActivationBanner(input: Readonly<{
    authorization?: PendingActivationAuthorizationV1 | null;
    activeAt: number;
    active: boolean;
    machineReachable: boolean;
    canWrite: boolean;
    resumingAt?: number | null;
    pendingMessages: readonly PendingMessage[];
    managedWakeProjection?: ManagedWakeProjection | null;
}>): PendingActivationBannerPresentation | null {
    if (!input.canWrite) return null;
    const managedWakeProjection = input.managedWakeProjection;
    // The managed presentation owns these distinct facts. The legacy banner's
    // safely-queued/resuming sentence cannot describe uncertain delivery or
    // native absence/loss, and must not offer a competing runtime recovery.
    if (managedWakeProjection && !['waiting', 'starting', 'connecting', 'resuming', 'agentStartFailed'].includes(managedWakeProjection.kind)) return null;
    const managedPresentation = managedWakeProjection ? { managedWakeProjection } : {};
    if (input.resumingAt != null) return null;
    if (input.active && input.machineReachable) return null;
    const rows = input.pendingMessages.filter(isEligiblePendingUserRow).sort(comparePendingRows);
    const authorization = input.authorization && input.authorization.requestedAt > input.activeAt
        ? input.authorization
        : null;
    if (authorization) {
        const row = rows.find((candidate) => candidate.localId === authorization.requestId) ?? null;
        if (authorization.status === 'failed') {
            return {
                ...managedPresentation,
                kind: 'failed',
                row,
                primaryAction: managedWakeProjection
                    ? (row && managedWakeProjection.canRetryAgentStart ? 'retry' : null)
                    : row
                    ? (input.machineReachable ? 'retry' : 'process_when_online')
                    : null,
                secondaryAction: row ? 'keep_queued' : null,
                settingsAction: 'settings',
            };
        }
        return {
            ...managedPresentation,
            kind: input.machineReachable ? 'waiting' : 'waiting_offline',
            row,
            primaryAction: null,
            secondaryAction: row ? 'keep_queued' : null,
            settingsAction: 'settings',
        };
    }
    if (rows.length === 0) return null;
    return {
        ...managedPresentation,
        kind: input.machineReachable ? 'queued' : 'queued_offline',
        row: rows[0],
        primaryAction: managedWakeProjection
            ? (managedWakeProjection.canResumeRuntime ? 'resume' : null)
            : input.machineReachable ? 'resume' : 'process_when_online',
        secondaryAction: null,
        settingsAction: 'settings',
    };
}
