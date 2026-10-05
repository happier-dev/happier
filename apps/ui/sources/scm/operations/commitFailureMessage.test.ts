import { describe, expect, it } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { buildScmCommitFailureMessage } from './commitFailureMessage';

describe('buildScmCommitFailureMessage', () => {
    it('returns normalized SCM error when commit sha is absent', () => {
        const message = buildScmCommitFailureMessage({
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
            error: 'missing upstream',
        });

        expect(message).toBe('Set a tracking target before pull or push.');
    });

});
