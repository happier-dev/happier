import { describe, expect, it } from 'vitest';
import * as canonical from '@happier-dev/plugin-sdk/protocol';
import * as triage from '@happier-dev/triage-protocol/ci/v1';

describe('the canonical CI evidence closure', () => {
    it('publishes the exact public SDK executable values through Triage', () => {
        const names = [
            'ForgeCiIdV1Schema', 'ForgeCiRunRefV1Schema', 'ForgeCiAttemptRefV1Schema',
            'ForgeCiSelectionV1Schema', 'ForgeCiJobRefV1Schema', 'ForgeCiStepRefV1Schema',
            'ForgeCiStateV1Schema', 'ForgeCiAnnotationV1Schema',
            'ForgeCiFailureExcerptV1Schema', 'ForgeCiFailureSummaryV1Schema',
        ] as const;
        for (const name of names) {
            expect(triage[name]).toBe(canonical[name]);
        }
    });

});
