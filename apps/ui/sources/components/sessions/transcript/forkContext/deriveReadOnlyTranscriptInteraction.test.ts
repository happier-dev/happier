import { describe, expect, it } from 'vitest';

import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { deriveReadOnlyTranscriptInteraction } from './deriveReadOnlyTranscriptInteraction';

describe('deriveReadOnlyTranscriptInteraction', () => {
    it('revokes every mutating or navigating capability, including fork, for fork-ancestor rows', () => {
        const localInteraction = deriveTranscriptInteraction({
            kind: 'session',
            accessLevel: 'edit',
            canApprovePermissions: true,
        });

        expect(deriveReadOnlyTranscriptInteraction(localInteraction, true)).toEqual({
            ...localInteraction,
            canSendMessages: false,
            canApprovePermissions: false,
            canFork: false,
            permissionDisabledReason: 'readOnly',
            disableToolNavigation: true,
        });
    });
});
