import { describe, expect, it } from 'vitest';
import {
    ForgeCiAnnotationV1Schema,
    ForgeCiAttemptRefV1Schema,
    ForgeCiFailureExcerptV1Schema,
    ForgeCiFailureSummaryV1Schema,
    ForgeCiIdV1Schema,
    ForgeCiJobRefV1Schema,
    ForgeCiRunRefV1Schema,
    ForgeCiSelectionV1Schema,
    ForgeCiStateV1Schema,
    ForgeCiStepRefV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import * as triage from '@happier-dev/triage-protocol/ci/v1';

describe('the canonical CI evidence closure', () => {
    it('publishes the exact public SDK executable values through Triage', () => {
        const schemas = [
            [triage.ForgeCiIdV1Schema, ForgeCiIdV1Schema],
            [triage.ForgeCiRunRefV1Schema, ForgeCiRunRefV1Schema],
            [triage.ForgeCiAttemptRefV1Schema, ForgeCiAttemptRefV1Schema],
            [triage.ForgeCiSelectionV1Schema, ForgeCiSelectionV1Schema],
            [triage.ForgeCiJobRefV1Schema, ForgeCiJobRefV1Schema],
            [triage.ForgeCiStepRefV1Schema, ForgeCiStepRefV1Schema],
            [triage.ForgeCiStateV1Schema, ForgeCiStateV1Schema],
            [triage.ForgeCiAnnotationV1Schema, ForgeCiAnnotationV1Schema],
            [triage.ForgeCiFailureExcerptV1Schema, ForgeCiFailureExcerptV1Schema],
            [triage.ForgeCiFailureSummaryV1Schema, ForgeCiFailureSummaryV1Schema],
        ] as const;
        for (const [exported, canonical] of schemas) {
            expect(exported).toBe(canonical);
        }
    });
});
