import { describe, expect, it } from 'vitest';
import { runWithBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { gitRemoteAdd, gitRemoteSetUrl } from './remoteManagementOperations.js';
import { finalizeGitRemoteMutation } from './remoteOperations.js';
import type { ScmBackendContext } from '../types.js';

const context: ScmBackendContext = {
    cwd: '/repo', projectKey: 'machine:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
};
const diagnostic = 'fatal: unable to access https://fixture:made-up-password@host.test/Repo.git';
const masked = 'fatal: unable to access https://fixture:***@host.test/Repo.git';

// Only the external Git process is replaced; result classification/projection remains real.
describe('remote password output projection', () => {
    it('masks stored passwords in a successful listing without changing password-free addresses', async () => {
        const stored = 'https://fixture:made-up-password@host.test/Repo.git';
        const usernameOnly = 'https://fixture@HOST.test:443/Repo.git';
        const result = await runWithBackendRuntimeServices({
            async runCommand(input) { return { success: true, stdout: input.args[1] === '-v'
                ? `origin ${stored} (fetch)\norigin ${stored} (push)\naddress ${usernameOnly} (fetch)` : '', stderr: '', exitCode: 0 }; },
        }, () => gitRemoteAdd({ context, request: { name: 'backup', fetchUrl: 'git@host.test:Repo.git' } }));
        expect(result).toMatchObject({ success: true, remotes: [
            { name: 'origin', fetchUrl: 'https://fixture:***@host.test/Repo.git', pushUrl: 'https://fixture:***@host.test/Repo.git' },
            { name: 'address', fetchUrl: usernameOnly },
        ] });
    });
    it('redacts a listing failure returned by remote management', async () => {
        const result = await runWithBackendRuntimeServices({
            async runCommand() { return { success: false, stdout: diagnostic, stderr: diagnostic, exitCode: 128 }; },
        }, () => gitRemoteAdd({ context, request: { name: 'backup', fetchUrl: 'git@host.test:Repo.git' } }));
        expect(result).toMatchObject({ success: false, error: masked, stderr: masked });
    });
    it('restores the original stored URL on rollback while redacting the returned failure', async () => {
        const stored = 'https://fixture:made-up-password@host.test/Repo.git';
        let restored = false;
        const result = await runWithBackendRuntimeServices({
            async runCommand(input) {
                if (input.args[0] === 'remote' && input.args[1] === '-v') return { success: true,
                    stdout: `origin ${stored} (fetch)\norigin ${stored} (push)`, stderr: '', exitCode: 0 };
                if (input.args.includes('--push')) return { success: false, stdout: '', stderr: diagnostic, exitCode: 128 };
                if (input.args[1] === 'set-url' && input.args[3] === stored) restored = true;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        }, () => gitRemoteSetUrl({ context, request: { name: 'origin',
            fetchUrl: 'https://host.test/new.git', pushUrl: 'https://host.test/push.git' } }));
        expect(restored).toBe(true);
        expect(result).toMatchObject({ success: false, error: masked });
        expect(JSON.stringify(result)).not.toContain('made-up-password');
    });
    it.each(['fetch', 'push'] as const)('redacts %s diagnostics before returning an Action result', async kind => {
        const result = await runWithBackendRuntimeServices({
            async runCommand() { return { success: false, stdout: '', stderr: '', exitCode: 128 }; },
        }, () => finalizeGitRemoteMutation({ context, kind,
            command: { success: false, stdout: diagnostic, stderr: diagnostic, exitCode: 128 } }));
        expect(result).toMatchObject({ success: false, error: masked, stdout: masked, stderr: masked });
        expect(JSON.stringify(result)).not.toContain('made-up-password');
    });
});
