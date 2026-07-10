import { describe, expect, it } from 'vitest';

import { runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/experimental/scm/backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { gitRemoteAdd, gitRemoteSetUrl } from './remoteManagementOperations.js';
import type { ScmBackendContext } from '../types.js';

const context: ScmBackendContext = {
    cwd: '/repo',
    projectKey: 'machine:/repo',
    detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
};

describe('git remote management operations', () => {
    it('rejects git transport-helper remote URLs before invoking git', async () => {
        let gitInvocations = 0;

        const result = await runWithScmBackendRuntimeServices({
            async runCommand() {
                gitInvocations += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        }, async () => await gitRemoteAdd({
            context,
            request: {
                name: 'origin',
                fetchUrl: 'ext::sh -c "touch /tmp/happier-owned"',
            },
        }));

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(result.error).toContain('Remote fetch URL');
        expect(gitInvocations).toBe(0);
    });

    it('rejects non-allowlisted remote URL schemes on set-url requests', async () => {
        let gitInvocations = 0;

        const result = await runWithScmBackendRuntimeServices({
            async runCommand() {
                gitInvocations += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        }, async () => await gitRemoteSetUrl({
            context,
            request: {
                name: 'origin',
                fetchUrl: 'fd::4',
            },
        }));

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(result.error).toContain('Remote fetch URL');
        expect(gitInvocations).toBe(0);
    });
});
