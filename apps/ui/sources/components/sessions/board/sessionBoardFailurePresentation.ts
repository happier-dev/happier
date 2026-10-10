import { t } from '@/text';

export type SessionBoardFailurePresentationKind =
    | 'conflict'
    | 'outcomeUnknown'
    | 'forbidden'
    | 'offline'
    | 'unavailable'
    | 'updateRequired'
    | 'noteTooLarge'
    | 'invalid'
    | 'notFound'
    | 'storage'
    | 'server'
    | 'failed';

export type SessionBoardFailurePresentation = Readonly<{
    kind: SessionBoardFailurePresentationKind;
    message: string;
    severity: 'warning' | 'error';
}>;

/**
 * The single user-facing interpretation of Board failure codes.
 *
 * Protocol and Action owners retain the strict code and structured recovery
 * evidence. This presentation boundary deliberately exposes neither raw server
 * copy nor arbitrary detail bags, while preserving distinctions that change the
 * person's next action. Note, hosted HTML, and generic Board mutations all use
 * this mapper rather than growing similar-but-different error switches.
 */
export function resolveSessionBoardFailurePresentation(code: string): SessionBoardFailurePresentation {
    switch (code) {
        case 'session_board_revision_conflict':
        case 'session_board_source_conflict':
            return { kind: 'conflict', message: t('sessionBoard.mutation.conflict'), severity: 'warning' };
        case 'outcome_unknown':
        case 'approval_execution_outcome_unknown':
            return { kind: 'outcomeUnknown', message: t('sessionBoard.mutation.outcomeUnknown'), severity: 'warning' };
        case 'session_board_forbidden':
        case 'forbidden':
        case 'not_authenticated':
            return { kind: 'forbidden', message: t('sessionBoard.mutation.denied'), severity: 'error' };
        case 'offline':
            return { kind: 'offline', message: t('sessionBoard.mutation.offline'), severity: 'warning' };
        case 'feature_disabled':
        case 'feature_unavailable':
        case 'protocol_unavailable':
        case 'unsupported_action':
        case 'unsupported_version':
        case 'board_actions_unavailable':
        case 'board_feature_unavailable':
            return { kind: 'unavailable', message: t('sessionBoard.mutation.unavailable'), severity: 'warning' };
        case 'update_required':
            return { kind: 'updateRequired', message: t('sessionBoard.mutation.updateRequired'), severity: 'warning' };
        case 'session_board_invalid':
        case 'malformed':
            return { kind: 'invalid', message: t('sessionBoard.mutation.invalid'), severity: 'error' };
        case 'session_board_note_too_large':
            return {
                kind: 'noteTooLarge',
                message: t('sessionBoard.mutation.noteTooLarge'),
                severity: 'error',
            };
        case 'session_board_item_not_found':
        case 'not_found':
            return { kind: 'notFound', message: t('sessionBoard.mutation.notFound'), severity: 'error' };
        case 'session_board_storage_mode_mismatch':
        case 'mode_mismatch':
        case 'encryption_material_unavailable':
        case 'locked':
        case 'corrupt_or_unopenable':
            return { kind: 'storage', message: t('sessionBoard.mutation.storageFailed'), severity: 'error' };
        case 'server_error':
        case 'server_target_mismatch':
        case 'invalid_response':
            return { kind: 'server', message: t('sessionBoard.mutation.serverFailed'), severity: 'error' };
        default:
            return { kind: 'failed', message: t('sessionBoard.mutation.failed'), severity: 'error' };
    }
}
