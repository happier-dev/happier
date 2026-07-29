import { describe, expect, it } from 'vitest';

import type { ExternalSessionOperationActionErrorCodeV1 } from '@happier-dev/protocol';

import { presentExternalSessionOperationActionError } from './externalSessionOperationActionErrorPresentation';

describe('presentExternalSessionOperationActionError', () => {
    it.each([
        ['upgrade_required', 'externalSessions.operationActionErrorUpgradeRequired'],
        ['operation_not_found', 'externalSessions.operationActionErrorNotFound'],
        ['operation_conflict', 'externalSessions.operationActionErrorConflict'],
        ['stale_revision', 'externalSessions.operationActionErrorStaleRevision'],
        ['invalid_state', 'externalSessions.operationActionErrorInvalidState'],
        ['not_allowed', 'externalSessions.operationActionErrorNotAllowed'],
        ['reconciliation_required', 'externalSessions.operationStatusNeedsReview'],
        ['source_unavailable', 'externalSessions.operationErrorSourceUnavailable'],
        ['internal_error', 'externalSessions.operationErrorInternal'],
    ] satisfies ReadonlyArray<readonly [ExternalSessionOperationActionErrorCodeV1, string]>)(
        'maps %s to safe translated copy',
        (code, expected) => {
            expect(presentExternalSessionOperationActionError(code)).toBe(expected);
        },
    );
});
