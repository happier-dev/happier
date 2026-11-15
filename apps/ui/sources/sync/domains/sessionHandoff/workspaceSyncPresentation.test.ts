import { describe, expect, it } from 'vitest';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { t } from '@/text';

import {
    formatWorkspaceSyncRelationshipTitle,
    presentWorkspaceSyncFailure,
    readWorkspaceSyncErrorCode,
    resolveWorkspaceSyncErrorTranslationKey,
    resolveWorkspaceSyncModeTranslationKey,
    resolveWorkspaceSyncRelationshipStateLabel,
    resolveWorkspaceSyncStateTranslationKey,
} from './workspaceSyncPresentation';

describe('workspaceSyncPresentation', () => {
    it('explains unavailable requester access while preserving the original relationship refusal', () => {
        const code = 'relationship_not_owned';
        expect(resolveWorkspaceSyncErrorTranslationKey(code)).toBe('workspaceSync.error.requesterAccessUnavailable');
        expect(presentWorkspaceSyncFailure(new RpcError('Private requester diagnostic', code))).toBe(
            `${t('workspaceSync.error.requesterAccessUnavailable')} (${code})`,
        );
    });

    it('shows the original RPC failure code even when it has no translated explanation', () => {
        const error = new RpcError('Untranslated diagnostic', 'project_requester_authority_unavailable');
        expect(readWorkspaceSyncErrorCode(error)).toBe('project_requester_authority_unavailable');
        expect(presentWorkspaceSyncFailure(error)).toContain('project_requester_authority_unavailable');
        expect(presentWorkspaceSyncFailure({ code: 'relationship_not_ready' })).toContain('relationship_not_ready');
    });
    // R126S3: a Manage owner got Can use guidance plus raw "false · dispatch · Error" diagnostics.
    const nativeRefusal = { code: 'workspace_private_checkout_review_required', effectAttempted: false, requestId: 'request-r126s3',
        failureCause: { phase: 'dispatch', errorClass: 'Error', errorCode: 'workspace_private_checkout_review_required', httpStatus: null } };
    it('never gives a Manage placement the Can use own-folder guidance', () => {
        expect(presentWorkspaceSyncFailure(nativeRefusal, 'source_relationship'))
            .toBe(`${t('workspaceSync.error.needsAttention')} (workspace_private_checkout_review_required)`);
        expect(presentWorkspaceSyncFailure(nativeRefusal, 'destination_open'))
            .toBe(`${t('workspaceSync.error.ownFolderOnly')} (workspace_private_checkout_review_required)`);
    });

    it('shows the human message for the typed cause and keeps diagnostics and the request id off the screen', () => {
        const homeRefusal = { code: 'credential_scope_denied', requestId: 'request-home', details: { reason: 'target_not_authorized' },
            failureCause: { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null } };
        expect(presentWorkspaceSyncFailure(homeRefusal, 'destination_open'))
            .toBe(`${t('workspaceSync.error.manageRequired')} (machine_manage_required)`);
        const message = presentWorkspaceSyncFailure(nativeRefusal, 'destination_open') ?? '';
        for (const diagnostic of ['dispatch', ' · ', 'Error', 'request-r126s3', 'false']) expect(message).not.toContain(diagnostic);
    });

    it('uses directional relationship titles for immutable one-way and two-way modes', () => {
        expect(formatWorkspaceSyncRelationshipTitle({
            alphaLabel: 'Source',
            betaLabel: 'Destination',
            mode: 'keep_synced',
        })).toBe('Source → Destination');
        expect(formatWorkspaceSyncRelationshipTitle({
            alphaLabel: 'Alpha',
            betaLabel: 'Beta',
            mode: 'keep_both_in_sync',
        })).toBe('Alpha ↔ Beta');
    });

    it('keeps every released mode distinct and fails closed for unknown modes', () => {
        expect([
            'copy_once',
            'keep_synced',
            'mirror_exactly',
            'keep_both_in_sync',
        ].map(resolveWorkspaceSyncModeTranslationKey)).toEqual([
            'workspaceSync.mode.copyOnce',
            'workspaceSync.mode.keepSynced',
            'workspaceSync.mode.mirrorExactly',
            'workspaceSync.mode.keepBothInSync',
        ]);
        expect(resolveWorkspaceSyncModeTranslationKey('future-mode')).toBeNull();
    });

    it('does not reinterpret unavailable or unknown daemon state as healthy', () => {
        expect(resolveWorkspaceSyncStateTranslationKey('controller_unavailable')).toBe('workspaceSync.state.controllerUnavailable');
        expect(resolveWorkspaceSyncStateTranslationKey('disconnected')).toBe('workspaceSync.state.peerOffline');
        expect(resolveWorkspaceSyncStateTranslationKey('future-state')).toBeNull();
    });

    it('maps actionable daemon failures without exposing implementation vocabulary', () => {
        expect(resolveWorkspaceSyncErrorTranslationKey('engine_unavailable')).toBe('workspaceSync.error.componentUnavailable');
        expect(resolveWorkspaceSyncErrorTranslationKey('machine_carrier_unavailable')).toBe('workspaceSync.error.machineOffline');
        expect(resolveWorkspaceSyncErrorTranslationKey('target_bootstrap_required')).toBe('workspaceSync.error.destinationNeedsPreparation');
        expect(resolveWorkspaceSyncErrorTranslationKey('git_selection_unavailable')).toBe('workspaceSync.error.gitPreparationFailed');
        expect(resolveWorkspaceSyncErrorTranslationKey('root_changed')).toBe('workspaceSync.error.rootNoLongerAuthorized');
        expect(resolveWorkspaceSyncErrorTranslationKey('workspace_sync_update_required')).toBe('workspaceSync.error.updateRequired');
        expect(resolveWorkspaceSyncErrorTranslationKey('workspace_sync_partial_route_blocked')).toBe('sessionHandoff.failure.partialLinked');
        expect(resolveWorkspaceSyncErrorTranslationKey('engine_problems')).toBe('workspaceSync.error.needsAttention');
        // A pause or resume refused while the controller is still settling the link (observed live on nl3).
        expect(resolveWorkspaceSyncErrorTranslationKey('relationship_not_ready')).toBe('workspaceSync.error.needsAttention');
        expect(resolveWorkspaceSyncErrorTranslationKey('workspace_root_in_use')).toBe('workspaceSync.error.needsAttention');
        expect(resolveWorkspaceSyncErrorTranslationKey('peer_unavailable')).toBe('workspaceSync.error.machineOffline');
        expect(resolveWorkspaceSyncErrorTranslationKey('future-error')).toBeNull();
        expect(resolveWorkspaceSyncErrorTranslationKey(null)).toBeNull();
    });

    it('reads a retained disabled relationship as Paused — resumable — never as the terminal Stopped', () => {
        // A retained disabled relationship without live daemon status is pause
        // intent, so it stays resumable; the terminal Stopped label is reserved
        // for a daemon-projected `stopped` state.
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: false,
            statusState: undefined,
            errorCode: undefined,
            statusPhase: 'idle',
        })).toBe('workspaceSync.state.paused');
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: false,
            statusState: null,
            errorCode: null,
            statusPhase: 'idle',
        })).toBe('workspaceSync.state.paused');
        // Live daemon projection owns the row state whenever it carries one.
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: false,
            statusState: 'watching',
            errorCode: undefined,
            statusPhase: 'idle',
        })).toBe('workspaceSync.state.watching');
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: false,
            statusState: 'stopped',
            errorCode: undefined,
            statusPhase: 'idle',
        })).toBe('workspaceSync.state.stopped');
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: false,
            statusState: 'paused',
            errorCode: undefined,
            statusPhase: 'idle',
        })).toBe('workspaceSync.state.paused');
        // An enabled relationship with no readable state is still loading, not paused.
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: true,
            statusState: undefined,
            errorCode: undefined,
            statusPhase: 'idle',
        })).toBe('workspaceSync.state.loading');
    });

    it('settles a completed observation with no engine session as unavailable', () => {
        expect(resolveWorkspaceSyncRelationshipStateLabel({
            enabled: true, statusState: null, errorCode: null,
            statusPhase: 'ready',
        })).toBe('workspaceSync.state.controllerUnavailable');
    });
});
