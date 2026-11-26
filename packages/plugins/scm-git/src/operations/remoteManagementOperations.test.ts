import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
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
    it.each(['https://org@dev.azure.com/org/project/_git/repo', 'git@host:org/repo.git', 'ssh://git@host/org/repo.git'])(
        'stores username-only remote URLs unchanged for add and set-url: %s', async (url) => {
            const cwd = mkdtempSync(join(tmpdir(), 'happier-remote-url-'));
            const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
            try {
                git(['init']);
                const actualContext = { ...context, cwd };
                await runWithRealGitScmRuntime(async () => {
                    expect(await gitRemoteAdd({ context: actualContext, request: { name: 'origin', fetchUrl: url } })).toMatchObject({ success: true });
                    expect(git(['config', '--get', 'remote.origin.url'])).toBe(url);
                    expect(await gitRemoteSetUrl({ context: actualContext, request: { name: 'origin', fetchUrl: url, pushUrl: url } })).toMatchObject({ success: true });
                    expect(git(['config', '--get', 'remote.origin.url'])).toBe(url);
                    expect(git(['config', '--get', 'remote.origin.pushurl'])).toBe(url);
                    const refused = await gitRemoteSetUrl({ context: actualContext, request: { name: 'origin', fetchUrl: 'https://user:synthetic-pass@host/repo' } });
                    expect(refused).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST', error: expect.stringContaining('Remove the password') });
                    expect(refused.error).toContain("Git's credential helper or a connected account");
                    expect(git(['config', '--get', 'remote.origin.url'])).toBe(url);
                });
            } finally { rmSync(cwd, { recursive: true, force: true }); }
        });

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

    // RU2 ORCH ruling: usernames are addresses; only passwords are refused.
    it('rejects remote URLs with passwords before invoking git', async () => {
        let gitInvocations = 0;
        const run = <T>(operation: () => Promise<T>) => runWithScmBackendRuntimeServices({
            async runCommand() {
                gitInvocations += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        }, operation);
        for (const url of ['https://user:synthetic-pass@host/team/repo.git',
            'ssh://git:synthetic-pass@forge.example/team/repo.git']) {
            const added = await run(() => gitRemoteAdd({ context, request: { name: 'origin', fetchUrl: url } }));
            expect(added, url).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: expect.stringContaining('Remove the password') });
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
