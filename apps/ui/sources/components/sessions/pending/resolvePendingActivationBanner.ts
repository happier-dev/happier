import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { SessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';

export type PendingActivationBannerPresentation = Readonly<{
    kind: 'waiting_offline' | 'waiting' | 'failed' | 'queued' | 'queued_offline' | 'held' | 'held_offline';
    row: PendingMessage | null;
    primaryAction: 'retry' | 'resume' | 'process_when_online' | null;
    secondaryAction: 'keep_queued' | null;
    settingsAction: 'settings';
    managedWakeProjection?: ManagedWakeProjection;
    holdReason?: PendingMessage['pendingActivationHoldReason'];
    titleKey?: 'managedWake.refused';
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
    machineReachable: boolean | null;
    canWrite: boolean;
    resumingAt?: number | null;
    pendingMessages: readonly PendingMessage[];
    managedWakeProjection?: ManagedWakeProjection | null;
    autoResumeAdmission?: SessionAutoResumeAdmissionV1;
}>): PendingActivationBannerPresentation | null {
    if (!input.canWrite) return null;
    const managedWakeProjection = input.managedWakeProjection;
    const rows = input.pendingMessages.filter(isEligiblePendingUserRow).sort(comparePendingRows);
    if (!input.active && input.resumingAt == null && rows.length > 0 && input.autoResumeAdmission === 'held_by_person') {
        return { kind: input.machineReachable === false ? 'held_offline' : 'held', row: rows[0], primaryAction: input.machineReachable === true ? 'resume' : null,
            secondaryAction: null, settingsAction: 'settings' };
    }
    // Current refusal can outlive a retained target after a grant downgrade.
    // Actual native progress/loss still wins over an older queue diagnostic.
    const held = !input.machineReachable && input.resumingAt == null
        && (!managedWakeProjection || managedWakeProjection.kind === 'unknown' || managedWakeProjection.kind === 'waiting'
            || managedWakeProjection.kind === 'agentStartFailed' && managedWakeProjection.canRequestWake)
        ? rows.find(row => row.pendingActivationHoldReason) : undefined;
    if (held) return {
        kind: input.machineReachable === false ? 'queued_offline' : 'queued', row: held, holdReason: held.pendingActivationHoldReason,
        ...(held.pendingActivationHoldReason === 'managed_power_required' ? { titleKey: 'managedWake.refused' as const } : {}),
        primaryAction: input.machineReachable === null || held.pendingActivationHoldReason === 'managed_power_required' ? null : 'process_when_online',
        secondaryAction: null, settingsAction: 'settings',
    };
    if (managedWakeProjection) {
        // The managed badge owns observed native stages, including runtime resume,
        // absence and uncertain custody; the generic banner must not reinterpret them.
        const row = input.pendingMessages.filter(isEligiblePendingUserRow)
            .find(candidate => candidate.localId === input.authorization?.requestId) ?? null;
        // Stopped input needs the same recovery as before its first wake
        // attempt. Keep native progress in the badge; rearming uses the existing
        // queue status line and its Process when online control.
        if (row && managedWakeProjection.canRequestWake) return {
            kind: input.machineReachable === false ? 'queued_offline' : 'queued', row,
            primaryAction: input.machineReachable === null ? null : 'process_when_online',
            secondaryAction: null, settingsAction: 'settings',
        };
        return {
            kind: managedWakeProjection.kind === 'agentStartFailed' ? 'failed' : input.machineReachable === false ? 'waiting_offline' : 'waiting',
            managedWakeProjection, row,
            primaryAction: row && managedWakeProjection.canRetryAgentStart ? 'retry'
                : row && managedWakeProjection.canResumeRuntime ? 'resume' : null,
            secondaryAction: null,
            settingsAction: 'settings',
        };
    }
    if (input.resumingAt != null) return null;
    if (input.active && input.machineReachable) return null;
    const authorization = input.authorization && input.authorization.requestedAt > input.activeAt
        ? input.authorization
        : null;
    if (authorization) {
        const row = rows.find((candidate) => candidate.localId === authorization.requestId) ?? null;
        if (authorization.status === 'failed') {
            return {
                kind: 'failed',
                row,
                primaryAction: row && input.machineReachable !== null
                    ? (input.machineReachable ? 'retry' : 'process_when_online')
                    : null,
                secondaryAction: row ? 'keep_queued' : null,
                settingsAction: 'settings',
            };
        }
        return {
            kind: input.machineReachable === false ? 'waiting_offline' : 'waiting',
            row,
            primaryAction: null,
            secondaryAction: row ? 'keep_queued' : null,
            settingsAction: 'settings',
        };
    }
    if (rows.length === 0) return null;
    return {
        kind: input.machineReachable === false ? 'queued_offline' : 'queued',
        row: rows[0],
        primaryAction: input.machineReachable === null ? null : input.machineReachable ? 'resume' : 'process_when_online',
        secondaryAction: null,
        settingsAction: 'settings',
    };
}
