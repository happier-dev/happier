import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { resolveSessionBoardFailurePresentation } from './sessionBoardFailurePresentation';

describe('resolveSessionBoardFailurePresentation', () => {
    it.each([
        ['session_board_invalid', 'invalid', 'sessionBoard.mutation.invalid'],
        ['session_board_note_too_large', 'noteTooLarge', 'sessionBoard.mutation.noteTooLarge'],
        ['malformed', 'invalid', 'sessionBoard.mutation.invalid'],
        ['session_board_forbidden', 'forbidden', 'sessionBoard.mutation.denied'],
        ['not_authenticated', 'forbidden', 'sessionBoard.mutation.denied'],
        ['session_board_item_not_found', 'notFound', 'sessionBoard.mutation.notFound'],
        ['not_found', 'notFound', 'sessionBoard.mutation.notFound'],
        ['session_board_storage_mode_mismatch', 'storage', 'sessionBoard.mutation.storageFailed'],
        ['encryption_material_unavailable', 'storage', 'sessionBoard.mutation.storageFailed'],
        ['server_error', 'server', 'sessionBoard.mutation.serverFailed'],
        ['invalid_response', 'server', 'sessionBoard.mutation.serverFailed'],
        ['feature_disabled', 'unavailable', 'sessionBoard.mutation.unavailable'],
        ['protocol_unavailable', 'unavailable', 'sessionBoard.mutation.unavailable'],
        ['update_required', 'updateRequired', 'sessionBoard.mutation.updateRequired'],
        ['unexpected_private_detail', 'failed', 'sessionBoard.mutation.failed'],
    ] as const)('maps %s through the shared safe vocabulary', (code, kind, messageKey) => {
        const result = resolveSessionBoardFailurePresentation(code);

        expect(result).toEqual({
            kind,
            message: t(messageKey),
            severity: kind === 'unavailable' || kind === 'updateRequired' ? 'warning' : 'error',
        });
        expect(result.message).not.toContain(code);
    });

    it('keeps conflict, outcome-unknown, and offline as distinct recovery semantics', () => {
        expect(resolveSessionBoardFailurePresentation('session_board_revision_conflict')).toEqual({
            kind: 'conflict',
            message: t('sessionBoard.mutation.conflict'),
            severity: 'warning',
        });
        expect(resolveSessionBoardFailurePresentation('approval_execution_outcome_unknown')).toEqual({
            kind: 'outcomeUnknown',
            message: t('sessionBoard.mutation.outcomeUnknown'),
            severity: 'warning',
        });
        expect(resolveSessionBoardFailurePresentation('offline')).toEqual({
            kind: 'offline',
            message: t('sessionBoard.mutation.offline'),
            severity: 'warning',
        });
    });
});
