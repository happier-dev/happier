import {
    ExternalSessionOperationSharedPresentationV1Schema,
} from '@happier-dev/protocol';
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
});
