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

    it('returns partial-success recovery guidance when commit sha exists', () => {
        const message = buildScmCommitFailureMessage({
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'fatal: unable to update index',
            commitSha: '1234567890abcdef',
        });

        expect(message).toContain('Commit 1234567890ab was created');
        expect(message).toContain('virtual selection is preserved');
    });
});
