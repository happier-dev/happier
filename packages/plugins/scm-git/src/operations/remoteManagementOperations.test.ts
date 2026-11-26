import { describe, expect, it } from 'vitest';

import { runWithBackendRuntimeServices as runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
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

    // As clone refuses them: a credential in a remote URL is stored in plain repository config and is
    // echoed in every remote listing; credentials come from the person's Git helper or connected account.
    it('rejects remote URLs with embedded credentials before invoking git, as clone does', async () => {
        let gitInvocations = 0;
        const run = <T>(operation: () => Promise<T>) => runWithScmBackendRuntimeServices({
            async runCommand() {
                gitInvocations += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        }, operation);
        for (const url of ['https://person:secret@forge.example/team/repo.git', 'https://secret@forge.example/team/repo.git',
            'ssh://git:secret@forge.example/team/repo.git']) {
            const added = await run(() => gitRemoteAdd({ context, request: { name: 'origin', fetchUrl: url } }));
            expect(added, url).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: expect.stringContaining('embedded credentials') });
            const pushed = await run(() => gitRemoteSetUrl({ context, request: { name: 'origin', pushUrl: url } }));
            expect(pushed, url).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: expect.stringContaining('Remote push URL') });
        }
        expect(gitInvocations).toBe(0);
        // An SSH user name is an address, not a credential.
        await run(() => gitRemoteAdd({ context, request: { name: 'origin', fetchUrl: 'ssh://git@forge.example/team/repo.git' } }));
        expect(gitInvocations).toBeGreaterThan(0);
    });
});
