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

    // A finished operation has no current phase: "Complete · Publishing imported session" read as still publishing.
    it('names no phase once the operation is complete', () => {
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: 'operation-1',
            revision: 4,
            kind: 'materialize',
            status: 'completed',
            phase: 'publishing',
        });

        expect(presentExternalSessionOperationShared(presentation)).toMatchObject({
            statusKey: 'externalSessions.operationStatusCompleted',
            phaseKey: null,
        });
    });
});
