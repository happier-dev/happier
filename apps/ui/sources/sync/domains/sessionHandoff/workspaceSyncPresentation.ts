import { t } from '@/text';
import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { WorkspaceSyncSetAttention } from './workspaceSyncRelationshipModel';
import type { WorkspaceSyncStatusSnapshot } from './workspaceSyncStatusStore';

/** Keep known conflicts distinct from links whose current status needs checking. */
export function formatWorkspaceSyncSetAttention(attention: WorkspaceSyncSetAttention): string | null {
    const parts = [
        attention.conflictedLinkCount > 0
            ? t('workspaceSync.attention.conflictedLinks', { count: attention.conflictedLinkCount })
            : null,
        attention.unknownLinkCount > 0
            ? t('workspaceSync.attention.unavailableLinks', { count: attention.unknownLinkCount })
            : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(' · ') : null;
}

export type WorkspaceSyncModeTranslationKey =
    | 'workspaceSync.mode.copyOnce'
    | 'workspaceSync.mode.keepSynced'
    | 'workspaceSync.mode.mirrorExactly'
    | 'workspaceSync.mode.keepBothInSync';

export type WorkspaceSyncStateTranslationKey =
    | 'workspaceSync.state.starting'
    | 'workspaceSync.state.watching'
    | 'workspaceSync.state.flushing'
    | 'workspaceSync.state.paused'
    | 'workspaceSync.state.peerOffline'
    | 'workspaceSync.state.conflicted'
    | 'workspaceSync.state.controllerUnavailable'
    | 'workspaceSync.state.error'
    | 'workspaceSync.state.stopped';

export type WorkspaceSyncErrorTranslationKey =
    | 'workspaceSync.error.componentUnavailable'
    | 'workspaceSync.error.machineOffline'
    | 'workspaceSync.error.destinationNeedsPreparation'
    | 'workspaceSync.error.gitPreparationFailed'
    | 'workspaceSync.error.authorizationExpired'
    | 'workspaceSync.error.rootNoLongerAuthorized'
    | 'workspaceSync.error.conflictNeedsAttention'
    | 'workspaceSync.error.updateRequired'
    | 'workspaceSync.error.requesterAccessUnavailable'
    | 'workspaceSync.error.ownFolderOnly'
    | 'workspaceSync.error.manageRequired'
    | 'sessionHandoff.failure.partialLinked'
    | 'workspaceSync.error.needsAttention';

/**
 * One reader for the daemon-supplied typed failure code. Workspace sync
 * failures arrive as thrown transport/daemon errors, and every surface must
 * read the same field rather than parsing messages.
 */
export function readWorkspaceSyncErrorCode(error: unknown): string | null {
    const rpcCode = readRpcErrorCode(error);
    if (rpcCode) return rpcCode;
    if (!error || typeof error !== 'object') return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The refusal copy for a failed Workspace Sync Action: the daemon's typed code mapped through
 * the one error presentation, with the exact code available for diagnosis.
 */
export function presentWorkspaceSyncFailure(error: unknown): string | null {
    const code = readWorkspaceSyncErrorCode(error);
    if (!code) return null;
    const key = resolveWorkspaceSyncErrorTranslationKey(code);
    const record = error as Readonly<Record<string, unknown>>;
    // The shared presenter selects safe details and typed causes; transport prose stays private.
    const presented = presentActionExecutionFailure({ ok: false, errorCode: code,
        details: record.details,
        failureCause: record.failureCause === undefined ? undefined : readActionFailureCauseV1(record.failureCause),
    });
    const message = key ? `${t(key)} (${code})` : `${presented.reason} (${code})`;
    return [message, ...presented.technicalDetails.filter(detail => detail.key !== 'code').map(detail => detail.value)].join(' · ');
}

export function resolveWorkspaceSyncModeTranslationKey(value: unknown): WorkspaceSyncModeTranslationKey | null {
    switch (value) {
        case 'copy_once': return 'workspaceSync.mode.copyOnce';
        case 'keep_synced': return 'workspaceSync.mode.keepSynced';
        case 'mirror_exactly': return 'workspaceSync.mode.mirrorExactly';
        case 'keep_both_in_sync': return 'workspaceSync.mode.keepBothInSync';
        default: return null;
    }
}

export function formatWorkspaceSyncRelationshipTitle(input: Readonly<{
    alphaLabel: string;
    betaLabel: string;
    mode: unknown;
}>): string {
    const separator = input.mode === 'keep_both_in_sync' ? ' ↔ ' : ' → ';
    return `${input.alphaLabel}${separator}${input.betaLabel}`;
}

export function resolveWorkspaceSyncStateTranslationKey(value: unknown): WorkspaceSyncStateTranslationKey | null {
    switch (value) {
        case 'starting': return 'workspaceSync.state.starting';
        case 'watching': return 'workspaceSync.state.watching';
        case 'flushing': return 'workspaceSync.state.flushing';
        case 'paused': return 'workspaceSync.state.paused';
        case 'disconnected': return 'workspaceSync.state.peerOffline';
        case 'conflicted': return 'workspaceSync.state.conflicted';
        case 'controller_unavailable': return 'workspaceSync.state.controllerUnavailable';
        case 'error': return 'workspaceSync.state.error';
        case 'stopped': return 'workspaceSync.state.stopped';
        default: return null;
    }
}

/** Keep daemon diagnostics behind the UI boundary and present the next useful action. */
export function resolveWorkspaceSyncErrorTranslationKey(value: unknown): WorkspaceSyncErrorTranslationKey | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    switch (value) {
        case 'engine_unavailable':
        case 'mutagen_fork_release_commit_required':
            return 'workspaceSync.error.componentUnavailable';
        case 'machine_carrier_unavailable':
        case 'controller_unavailable':
        case 'peer_unavailable':
            return 'workspaceSync.error.machineOffline';
        case 'target_bootstrap_required':
        case 'target_not_empty':
            return 'workspaceSync.error.destinationNeedsPreparation';
        case 'git_selection_unavailable':
            return 'workspaceSync.error.gitPreparationFailed';
        case 'authorization_expired':
        case 'grant_expired':
            return 'workspaceSync.error.authorizationExpired';
        case 'root_changed':
        case 'root_not_authorized':
            return 'workspaceSync.error.rootNoLongerAuthorized';
        case 'conflict_changed':
            return 'workspaceSync.error.conflictNeedsAttention';
        case 'workspace_sync_update_required':
            return 'workspaceSync.error.updateRequired';
        case 'workspace_sync_partial_route_blocked':
            return 'sessionHandoff.failure.partialLinked';
        case 'relationship_not_owned':
            return 'workspaceSync.error.requesterAccessUnavailable';
        // A Can use destination opens only into the person's own member folder.
        case 'workspace_private_checkout_review_required':
            return 'workspaceSync.error.ownFolderOnly';
        case 'machine_manage_required':
            return 'workspaceSync.error.manageRequired';
        case 'engine_problems':
        case 'relationship_not_ready':
        case 'workspace_root_in_use':
            return 'workspaceSync.error.needsAttention';
        default:
            return null;
    }
}

export type WorkspaceSyncRelationshipStateLabelKey =
    | WorkspaceSyncStateTranslationKey
    | 'workspaceSync.state.engineUnavailable'
    | 'workspaceSync.state.loading';

/**
 * One presentation for the relationship human state. Daemon status is the
 * live execution owner and wins whenever it carries a readable state; the
 * durable `enabled` bit is only the pause intent, so a retained disabled
 * relationship without live status reads as Paused — resumable — never as
 * the terminal Stopped.
 */
export function resolveWorkspaceSyncRelationshipStateLabel(input: Readonly<{
    enabled: boolean;
    statusState: unknown;
    errorCode: unknown;
    statusPhase: WorkspaceSyncStatusSnapshot['phase'];
}>): WorkspaceSyncRelationshipStateLabelKey {
    if (input.errorCode === 'engine_unavailable') return 'workspaceSync.state.engineUnavailable';
    if (input.statusPhase === 'error' || (input.enabled && input.statusPhase === 'ready' && !input.statusState)) {
        return 'workspaceSync.state.controllerUnavailable';
    }
    const statusStateKey = resolveWorkspaceSyncStateTranslationKey(input.statusState);
    if (statusStateKey) return statusStateKey;
    if (!input.enabled) return 'workspaceSync.state.paused';
    return 'workspaceSync.state.loading';
}
