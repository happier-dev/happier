import {
    resolveWorkspaceSyncErrorTranslationKey,
    type WorkspaceSyncErrorTranslationKey,
} from './workspaceSyncPresentation';
import type { WorkspaceSyncEngineReadinessSnapshot } from './workspaceSyncEngineReadinessStore';

export type SessionHandoffStartBlockedReason =
    | 'target_machine_not_selected'
    | 'target_machine_unavailable'
    | 'source_machine_unavailable'
    | 'relationship_unavailable'
    | 'workspace_engine_readiness_pending'
    | 'workspace_engine_unavailable'
    | 'source_path_unsafe'
    | 'target_path_unsafe'
    | 'workspace_action_incomplete';

export type SessionHandoffStartReadiness =
    | Readonly<{ canStart: true }>
    | Readonly<{
        canStart: false;
        reason: SessionHandoffStartBlockedReason;
        engineErrorCode?: string;
    }>;

export type SessionHandoffStartBlockedTranslationKey =
    | 'workspaceSync.start.blocked.targetMachine'
    | 'workspaceSync.start.blocked.targetMachineOffline'
    | 'machineRequester.handoffUnavailable'
    | 'workspaceSync.start.blocked.relationshipUnavailable'
    | 'workspaceSync.start.blocked.sourceFolder'
    | 'workspaceSync.start.blocked.destinationFolder'
    | 'workspaceSync.start.blocked.workspaceOptions'
    | 'workspaceSync.engine.checking'
    | WorkspaceSyncErrorTranslationKey;

const STARTABLE: SessionHandoffStartReadiness = { canStart: true };

function engineBlock(
    readiness: WorkspaceSyncEngineReadinessSnapshot,
    machineCarrierRequired: boolean,
): SessionHandoffStartReadiness | null {
    if (readiness.phase === 'idle' || readiness.phase === 'probing') {
        return { canStart: false, reason: 'workspace_engine_readiness_pending' };
    }
    if (readiness.phase === 'unavailable') {
        return {
            canStart: false,
            reason: 'workspace_engine_unavailable',
            ...(readiness.errorCode ? { engineErrorCode: readiness.errorCode } : {}),
        };
    }
    if (machineCarrierRequired && readiness.carrierPhase === 'unknown') {
        return { canStart: false, reason: 'workspace_engine_readiness_pending' };
    }
    if (!machineCarrierRequired || readiness.carrierPhase !== 'unavailable') return null;
    return {
        canStart: false,
        reason: 'workspace_engine_unavailable',
        ...(readiness.carrierErrorCode ? { engineErrorCode: readiness.carrierErrorCode } : {}),
    };
}

/**
 * One resolver for whether the handoff can start and, when it cannot, the
 * exact actionable reason. Every input is an observation the picker already
 * holds: a settings-resolved relationship, the protocol path-safety verdict,
 * and each owning daemon's own workspace-sync readiness answer. Nothing here
 * guesses from a filesystem path or a machine record shape.
 */
export function resolveSessionHandoffStartReadiness(input: Readonly<{
    targetMachineSelected: boolean;
    targetMachineAttemptable: boolean;
    sourceMachineAttemptable: boolean;
    relationshipRequested: boolean;
    relationshipResolved: boolean;
    workspaceActionResolved: boolean;
    workspaceEngineRequired: boolean;
    machineCarrierRequired: boolean;
    sourcePathAllowed: boolean;
    targetPathAllowed: boolean;
    sourceEngineReadiness: WorkspaceSyncEngineReadinessSnapshot;
    targetEngineReadiness: WorkspaceSyncEngineReadinessSnapshot;
}>): SessionHandoffStartReadiness {
    if (!input.targetMachineSelected) {
        return { canStart: false, reason: 'target_machine_not_selected' };
    }
    if (!input.targetMachineAttemptable) {
        return { canStart: false, reason: 'target_machine_unavailable' };
    }
    if (!input.sourceMachineAttemptable) {
        return { canStart: false, reason: 'source_machine_unavailable' };
    }
    if (input.relationshipRequested && !input.relationshipResolved) {
        return { canStart: false, reason: 'relationship_unavailable' };
    }
    if (input.workspaceEngineRequired) {
        // The destination is reported first: it is the endpoint the user just
        // chose and the one they can still change here.
        const blocked = engineBlock(input.targetEngineReadiness, input.machineCarrierRequired)
            ?? engineBlock(input.sourceEngineReadiness, input.machineCarrierRequired);
        if (blocked) return blocked;
        if (!input.sourcePathAllowed) return { canStart: false, reason: 'source_path_unsafe' };
    }
    if (!input.targetPathAllowed) return { canStart: false, reason: 'target_path_unsafe' };
    if (!input.workspaceActionResolved) {
        return { canStart: false, reason: 'workspace_action_incomplete' };
    }
    return STARTABLE;
}

export function resolveSessionHandoffStartBlockedTranslationKey(
    readiness: SessionHandoffStartReadiness,
): SessionHandoffStartBlockedTranslationKey | null {
    if (readiness.canStart) return null;
    switch (readiness.reason) {
        case 'target_machine_not_selected':
            return 'workspaceSync.start.blocked.targetMachine';
        case 'target_machine_unavailable':
            return 'workspaceSync.start.blocked.targetMachineOffline';
        case 'source_machine_unavailable':
            return 'machineRequester.handoffUnavailable';
        case 'relationship_unavailable':
            return 'workspaceSync.start.blocked.relationshipUnavailable';
        case 'source_path_unsafe':
            return 'workspaceSync.start.blocked.sourceFolder';
        case 'target_path_unsafe':
            return 'workspaceSync.start.blocked.destinationFolder';
        case 'workspace_action_incomplete':
            return 'workspaceSync.start.blocked.workspaceOptions';
        case 'workspace_engine_readiness_pending':
            return 'workspaceSync.engine.checking';
        case 'workspace_engine_unavailable':
            return resolveWorkspaceSyncErrorTranslationKey(readiness.engineErrorCode)
                ?? 'workspaceSync.error.needsAttention';
    }
}
