import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveMachineRecipeStepInputsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { BACKUP_RECEIVER_RECIPE } from '../../../plugins/machine-recipes/src/backupReceiver.js';
import { runMachineSetupNativeCommand } from './nativeBackend.js';
import { probeNativeSshFile, validateNativeSshFile } from './nativeSshFile.js';
import type { NativeRun } from './nativeSystemBackend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const run: NativeRun = (executable, args) => runMachineSetupNativeCommand({ executable, args });
const administrator = { user: 'root', host: 'probe', address: '127.0.0.1' };

it.each([
    { errorCode: 'ENOENT', reasonCode: 'required_fact_unavailable' },
    { errorCode: 'EACCES', reasonCode: 'needs_admin_to_check' },
    { errorCode: undefined, reasonCode: 'validation_failed' },
])('keeps native probe failure private and reports $reasonCode', async ({ errorCode, reasonCode }) => {
    const privateOutput = 'private native configuration diagnostic';
    const boundary: NativeRun = async () => ({ code: errorCode ? null : 1, stdout: privateOutput, stderr: privateOutput,
        ...(errorCode ? { errorCode } : {}) });
    const error = await probeNativeSshFile({ kind: 'sshd', contexts: [administrator] }, boundary).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ reasonCode });
    expect(JSON.stringify(error)).not.toContain(privateOutput);
});

async function fixture(beforeInclude = '') {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-ssh-')); roots.push(root);
    const dropins = join(root, 'sshd_config.d'); await mkdir(dropins);
    const path = join(dropins, '00-happier.conf'), mainPath = join(root, 'sshd_config');
    await writeFile(mainPath, `${beforeInclude}Include "${dropins}/*.conf"\nPasswordAuthentication yes\n`);
    const candidate = join(root, 'candidate');
    await writeFile(candidate, 'PasswordAuthentication no\n');
    return { root, path, mainPath, candidate };
}

// Uses the installed native SSH parser and real root-readable host keys, never
// edits /etc/ssh or reloads the running service.
describe.skipIf(process.getuid?.() !== 0)('native SSH complete-configuration validation', () => {
    it('validates an absent drop-in in Include order and checks its effective policy without publishing it', async () => {
        const f = await fixture();
        const probe = { kind: 'sshd' as const, contexts: [{ ...administrator, expected: { passwordauthentication: 'no' } }] };
        await validateNativeSshFile({ ...f, probe, run });
        await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(f.mainPath, 'utf8')).toContain('PasswordAuthentication yes');
    });

    it('rejects an earlier winning rule even though the candidate passes sshd syntax validation', async () => {
        const f = await fixture('PasswordAuthentication yes\n');
        await expect(validateNativeSshFile({ ...f, probe: { kind: 'sshd', contexts: [
            { ...administrator, expected: { passwordauthentication: 'no' } },
        ] }, run })).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
    });

    it('keeps nested and quoted Includes in native lexical order when replacing an existing target', async () => {
        const f = await fixture();
        await writeFile(f.path, 'PasswordAuthentication yes\n');
        const nested = join(f.root, 'nested configuration');
        await writeFile(nested, `Include '${join(f.root, 'sshd_config.d')}/*.conf' # preserved comment\n`);
        await writeFile(f.mainPath, `Include = "${nested}"\nPasswordAuthentication yes\n`);
        const probe = { kind: 'sshd' as const, contexts: [{ ...administrator, expected: { passwordauthentication: 'no' } }] };
        await validateNativeSshFile({ ...f, probe, run });
        await writeFile(join(f.root, 'sshd_config.d', '00-before.conf'), 'PasswordAuthentication yes\n');
        await expect(validateNativeSshFile({ ...f, probe, run })).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(await probeNativeSshFile(probe, run, f)).toBe(false);
        expect(await readFile(f.path, 'utf8')).toBe('PasswordAuthentication yes\n');
    });

    it('preserves the administrator context while verifying a scoped receiver and validates owned removal', async () => {
        const f = await fixture();
        const inputs = { username: 'receiver', chrootPath: '/srv/receiver', repositoryPath: '/srv/receiver/repository',
            administrator: { username: administrator.user, host: administrator.host, address: administrator.address },
            connection: { host: administrator.host, address: administrator.address } };
        const policy = resolveMachineRecipeStepInputsV1(BACKUP_RECEIVER_RECIPE.steps.find(step => step.id === 'receiver-ssh-policy')!, inputs);
        const removal = resolveMachineRecipeStepInputsV1(BACKUP_RECEIVER_RECIPE.removeSteps.find(step => step.id === 'receiver-ssh-policy')!, inputs);
        if (policy?.kind !== 'file' || policy.content?.kind !== 'literal' || policy.probe?.kind !== 'sshd'
            || removal?.kind !== 'file' || typeof removal.validate !== 'object' || removal.validate.kind !== 'sshd') {
            throw new Error('Receiver policy declaration did not resolve native SSH validation');
        }
        await writeFile(f.candidate, policy.content.value);
        const probe = policy.probe;
        await validateNativeSshFile({ ...f, probe, run });
        await writeFile(f.path, await readFile(f.candidate));
        expect(await probeNativeSshFile(probe, run, f)).toBe(true);
        await validateNativeSshFile({ ...f, candidate: null, probe: removal.validate, run });
        expect(await readFile(f.path, 'utf8')).toContain('ForceCommand internal-sftp');
    });

    it('enforces explicit administrator expectations during removal while permitting reviewed policy relaxation', async () => {
        const f = await fixture();
        await writeFile(f.path, 'PasswordAuthentication no\n');
        const probe = { kind: 'sshd' as const, contexts: [{ ...administrator, expected: { port: '2222', pubkeyauthentication: 'yes' } }] };
        await expect(validateNativeSshFile({ ...f, candidate: null, probe, run })).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        await writeFile(f.mainPath, `Port 2222\nInclude "${join(f.root, 'sshd_config.d')}/*.conf"\nPasswordAuthentication yes\n`);
        await validateNativeSshFile({ ...f, candidate: null, probe, run });
        expect(await readFile(f.path, 'utf8')).toBe('PasswordAuthentication no\n');
    });

    it('refuses a candidate that changes a preserved administrator or contains invalid syntax', async () => {
        const f = await fixture();
        await expect(validateNativeSshFile({ ...f, probe: { kind: 'sshd', contexts: [administrator] }, run }))
            .rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        await writeFile(f.candidate, 'UnknownHappierOption yes\n');
        await expect(validateNativeSshFile({ ...f, probe: { kind: 'sshd', contexts: [administrator] }, run }))
            .rejects.toMatchObject({ reasonCode: 'validation_failed' });
    });
});
