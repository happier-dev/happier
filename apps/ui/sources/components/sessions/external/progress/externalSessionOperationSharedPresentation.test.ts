import {
    ExternalSessionOperationSharedPresentationV1Schema,
} from '@happier-dev/protocol/sessions/external/operationV1';
import { describe, expect, it } from 'vitest';

import { presentExternalSessionOperationShared } from './externalSessionOperationSharedPresentation';

describe('presentExternalSessionOperationShared', () => {
    it('uses only generic operation kind, status, and phase labels', () => {
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: 'operation-1',
            revision: 3,
            kind: 'materialize',
            status: 'running',
            phase: 'importing',
        });

        expect(presentExternalSessionOperationShared(presentation)).toEqual({
            titleKey: 'externalSessions.operationTitleMaterialize',
            statusKey: 'externalSessions.operationStatusRunning',
            phaseKey: 'externalSessions.operationPhaseImporting',
        });
    });

    // A settled outcome has no current phase: "Complete · Publishing imported session" or
    // "Cancelled · Importing messages" read as still running. The outcome is said alone.
    it.each(['completed', 'cancelled', 'failed', 'discarded'] as const)('names no phase once the operation is %s', (status) => {
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1, operationId: 'operation-1', revision: 4, kind: 'materialize', status, phase: 'importing',
        });

        expect(presentExternalSessionOperationShared(presentation).phaseKey).toBeNull();
    });

    it.each(['running', 'awaiting_user_resume', 'cancel_requested', 'reconciliation_required'] as const)(
        'keeps the phase while the operation is %s',
        (status) => {
            const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
                v: 1, operationId: 'operation-1', revision: 4, kind: 'materialize', status, phase: 'importing',
            });

            expect(presentExternalSessionOperationShared(presentation).phaseKey)
                .toBe('externalSessions.operationPhaseImporting');
        },
    );
});
