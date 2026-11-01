import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand } from './nativeBackend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const basis = { kind: 'bootstrap' as const, managedId: 'm-a', operationId: 'op-a', admittedInputDigest: 'a'.repeat(64) };
const fingerprint = 'A'.repeat(40);
async function fixture(options: Readonly<{ failFirstUpdate?: boolean }> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'happier-setup-native-')); roots.push(root);
    const calls: MachineSetupNativeCommand[] = [];
    let trusted = true, available = false, installed = false, failUpdate = options.failFirstUpdate === true;
    const backend = createMachineSetupNativeBackend({ run: async command => {
        calls.push(command);
        if (command.executable === 'id') return { code: 0, stdout: `${process.getuid?.()}\n`, stderr: '' };
        if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd')
            ? `root:x:${process.getuid?.()}:${process.getgid?.()}::/root:/bin/sh\n` : `root:x:${process.getgid?.()}:\n`, stderr: '' };
        if (command.executable === 'dpkg') return { code: 0, stdout: 'amd64\n', stderr: '' };
        if (command.executable === 'lslocks') return { code: 0, stdout: '{"locks":[]}', stderr: '' };
        if (command.executable === 'curl') { await writeFile(command.args[command.args.indexOf('--output') + 1]!, 'binary public key'); return { code: 0, stdout: '', stderr: '' }; }
        if (command.executable === 'gpg') return { code: 0, stdout: `pub:-:4096:1:key:0:0::-:::scSC:\nfpr:::::::::${trusted ? fingerprint : 'B'.repeat(40)}:\n`, stderr: '' };
        if (command.executable === 'dpkg-query') return { code: installed ? 0 : 1, stdout: installed ? 'wanted\tinstall ok installed\t1\tamd64\n' : '', stderr: '' };
        if (command.executable === 'apt-cache') return { code: 0, stdout: !available ? '' : command.args[0] === 'policy'
            ? 'wanted:\n  Installed: (none)\n  Candidate: 1\n  Version table:\n     1 500\n'
            : 'Package: wanted\nVersion: 1\nArchitecture: amd64\n\n', stderr: '' };
        if (command.executable === 'apt-get') {
            if (command.args[0] === 'update' && failUpdate) { failUpdate = false; return { code: 100, stdout: '', stderr: 'native refresh failed' }; }
            if (command.args[0] === 'update') available = true;
            if (command.args[0] === 'install') installed = true;
            return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected native boundary ${command.executable}`);
    } });
    return { root, calls, backend, untrust: () => { trusted = false; } };
}
describe('native setup file safety', () => {
    it('observes exact native directory ownership and resolves it independently for Apply', async () => {
        const f = await fixture(), path = join(f.root, 'observed-directory');
        await mkdir(path); await chmod(path, 0o2770);
        const uid = process.getuid?.() ?? -1, gid = process.getgid?.() ?? -1;
        let nativeUid = uid, nativeGid = gid;
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable !== 'getent') throw new Error('Directory observation must not mutate');
            return { code: 0, stdout: command.args.includes('passwd')
                ? `member:x:${nativeUid}:${gid}::/home/member:/usr/sbin/nologin\n` : `daemon:x:${nativeGid}:\n`, stderr: '' };
        } });
        const step: Extract<MachineRecipeStepV1, { kind: 'directory' }> = { id: 'observed-directory', kind: 'directory',
            path, owner: 'member', group: 'daemon', mode: 0o2770, preserveExistingOwnership: true };
        expect(await backend.observe(step)).toMatchObject({ status: 'satisfied', facts: { uid, gid, mode: 0o2770 } });
        nativeGid = gid + 1;
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        nativeGid = gid;
        await chmod(path, 0o700);
        expect(await backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await chmod(path, 0o2770);
        const linked = join(f.root, 'linked-directory'); await symlink(path, linked);
        expect(await backend.observe({ ...step, path: linked })).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(await backend.observe({ ...step, path: join(linked, 'child') })).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        nativeUid = uid + 1;
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
    });

    it('does not claim a same-owner foreign directory and atomically publishes an owned directory for retry', async () => {
        const f = await fixture(), path = join(f.root, 'jail');
        await mkdir(path); await chmod(path, 0o755);
        await writeFile(join(path, 'foreign'), 'keep');
        const step: Extract<MachineRecipeStepV1, { kind: 'directory' }> & { ownershipMarker: string } = {
            id: 'jail', kind: 'directory', path, owner: 'root', group: 'root', mode: 0o755,
            preserveExistingOwnership: true, ownershipMarker: 'happier-backup-receiver-archive',
        };
        expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(f.backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(await readFile(join(path, 'foreign'), 'utf8')).toBe('keep');
        const fresh = { ...step, path: join(f.root, 'new-jail') };
        await f.backend.apply(fresh);
        expect(await f.backend.observe(fresh)).toMatchObject({ status: 'satisfied' });
        await f.backend.apply(fresh);
        expect(await readFile(join(fresh.path, '.happier-setup-owner'), 'utf8')).toBe(`${step.ownershipMarker}\n`);
        await writeFile(join(fresh.path, '.happier-setup-owner'), 'foreign');
        expect(await f.backend.observe(fresh)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    });

    it('refuses taking over an existing directory with different reviewed ownership or mode', async () => {
        const f = await fixture(), path = join(f.root, 'foreign-repository');
        await mkdir(path, { mode: 0o755 });
        await chmod(path, 0o755);
        await writeFile(join(path, 'backup-data'), 'keep');
        const step: Extract<MachineRecipeStepV1, { kind: 'directory' }> & { preserveExistingOwnership: true } = {
            id: 'repository', kind: 'directory', path, owner: 'root', group: 'root', mode: 0o700, preserveExistingOwnership: true,
        };
        expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(f.backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(await readFile(join(path, 'backup-data'), 'utf8')).toBe('keep');
    });

    it('refuses a chroot directory beneath a writable ancestor before creating it', async () => {
        const f = await fixture(), parent = join(f.root, 'writable'), path = join(parent, 'jail');
        await mkdir(parent); await chmod(parent, 0o777);
        const step: Extract<MachineRecipeStepV1, { kind: 'directory' }> = {
            id: 'jail', kind: 'directory', path, owner: 'root', group: 'root', mode: 0o755, protectedAncestors: true,
        };
        expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(f.backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('applies user, group, directory and file dependencies through the same backend without treating missing identities as ready', async () => {
        const f = await fixture();
        let user = false, group = false;
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'getent' && command.args.includes('passwd')) return {
                code: user ? 0 : 2, stdout: user ? `new-user:x:${process.getuid?.()}:${process.getgid?.()}::/home/new-user:/usr/sbin/nologin\n` : '', stderr: '',
            };
            if (command.executable === 'getent' && command.args.includes('group')) return {
                code: group ? 0 : 2, stdout: group ? `new-group:x:${process.getgid?.()}:new-user\n` : '', stderr: '',
            };
            if (command.executable === 'id') return { code: user ? 0 : 1, stdout: user ? `${process.getgid?.()}\n` : '', stderr: '' };
            if (command.executable === 'useradd') { user = true; return { code: 0, stdout: '', stderr: '' }; }
            if (command.executable === 'groupadd') { group = true; return { code: 0, stdout: '', stderr: '' }; }
            throw new Error(`Unexpected native boundary ${command.executable}`);
        } });
        const directory = join(f.root, 'owned');
        const steps: MachineRecipeStepV1[] = [
            { id: 'user', kind: 'user', username: 'new-user', shell: '/usr/sbin/nologin' },
            { id: 'group', kind: 'group', name: 'new-group', members: ['new-user'] },
            { id: 'directory', kind: 'directory', path: directory, owner: 'new-user', group: 'new-group', mode: 0o750 },
            { id: 'file', kind: 'file', path: join(directory, 'config'), owner: 'new-user', group: 'new-group', mode: 0o600, content: { kind: 'literal', value: 'reviewed\n' } },
        ];
        const plan = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(plan.nativeFacts.every(fact => fact.status === 'drifted')).toBe(true);
        expect(plan.nativeFacts[3]?.facts).toMatchObject({ present: false, missingIdentity: ['new-user', 'new-group'] });
        expect((await applyMachineSetupEffectPlan({ plan, backend })).status).toBe('applied');
        expect(await readFile(join(directory, 'config'), 'utf8')).toBe('reviewed\n');
        const again = await checkMachineSetupEffectPlan({ basis, steps, backend });
        expect(again.nativeFacts.every(fact => fact.status === 'satisfied')).toBe(true);
    });

    it('refuses symlinked ancestors before reading or writing a reviewed path', async () => {
        const f = await fixture();
        const foreign = join(f.root, 'foreign'); await mkdir(foreign);
        await symlink(foreign, join(f.root, 'linked'));
        const step: MachineRecipeStepV1 = { id: 'file', kind: 'file', path: join(f.root, 'linked', 'new'), owner: 'root', group: 'root', mode: 0o600, content: { kind: 'literal', value: 'owned' } };
        const observation = await f.backend.observe(step);
        expect(observation).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(f.backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        await expect(readFile(join(foreign, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves unrelated nested JSON keys and refuses malformed existing JSON', async () => {
        const f = await fixture(), path = join(f.root, 'docker.json');
        await writeFile(path, JSON.stringify({ 'log-opts': { foreign: 'keep', 'max-size': 'old' }, foreign: true }));
        const step: MachineRecipeStepV1 = { id: 'json', kind: 'file', path, owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'jsonMerge', value: { 'log-opts': { 'max-size': 'reviewed' } } } };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'log-opts': { foreign: 'keep', 'max-size': 'reviewed' }, foreign: true });
        await writeFile(path, '{broken');
        expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(await readFile(path, 'utf8')).toBe('{broken');
    });

    it('refuses removal when exact bytes have foreign ownership metadata', async () => {
        const f = await fixture(), path = join(f.root, 'policy');
        const value = '# owned policy\n';
        await writeFile(path, value, { mode: 0o600 });
        const step: MachineRecipeStepV1 = { id: 'remove', kind: 'file', path, owner: 'root', group: 'root', mode: 0o440,
            state: 'absent', expectedContentDigest: createHash('sha256').update(value).digest('hex') };
        expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        await expect(f.backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(await readFile(path, 'utf8')).toBe(value);
        await chmod(path, 0o440);
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses activation if a validator observes a concurrent replacement', async () => {
        const f = await fixture(), path = join(f.root, 'sudoers');
        const step: MachineRecipeStepV1 = { id: 'policy', kind: 'file', path, owner: 'root', group: 'root', mode: 0o440,
            content: { kind: 'literal', value: '# owned policy\n' }, validate: 'sudoers' };
        const backend = createMachineSetupNativeBackend({ run: async command => {
            if (command.executable === 'visudo') { await writeFile(path, 'concurrent foreign policy'); return { code: 0, stdout: '', stderr: '' }; }
            if (command.executable === 'id') return { code: 0, stdout: `${process.getuid?.()}\n`, stderr: '' };
            if (command.executable === 'getent') return { code: 0, stdout: command.args.includes('passwd')
                ? `root:x:${process.getuid?.()}:${process.getgid?.()}::/root:/bin/sh\n` : `root:x:${process.getgid?.()}:\n`, stderr: '' };
            throw new Error(`Unexpected native command ${command.executable}`);
        } });
        await expect(backend.apply(step)).rejects.toMatchObject({ reasonCode: 'foreign_effect_conflict' });
        expect(await readFile(path, 'utf8')).toBe('concurrent foreign policy');
    });

    it('verifies signed-source trust before activation, then treats an exact source and key as a no-op', async () => {
        const f = await fixture();
        const step: MachineRecipeStepV1 = { id: 'source', kind: 'packageSource', manager: 'apt', path: join(f.root, 'vendor.list'), keyPath: join(f.root, 'vendor.gpg'),
            url: 'https://packages.example.test/stable', suite: 'bookworm', components: ['main'], architectures: ['amd64'],
            keyUrl: 'https://packages.example.test/key.gpg', keyFingerprint: fingerprint };
        const steps: MachineRecipeStepV1[] = [step, { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }];
        let plan = await checkMachineSetupEffectPlan({ basis, steps, backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        expect(await readFile(step.path, 'utf8')).toBe(`deb [arch=amd64 signed-by=${step.keyPath}] https://packages.example.test/stable bookworm main\n`);
        const downloads = f.calls.filter(command => command.executable === 'curl').length;
        const updates = f.calls.filter(command => command.executable === 'apt-get' && command.args[0] === 'update').length;
        plan = await checkMachineSetupEffectPlan({ basis, steps, backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        expect(f.calls.filter(command => command.executable === 'curl')).toHaveLength(downloads);
        expect(f.calls.filter(command => command.executable === 'apt-get' && command.args[0] === 'update')).toHaveLength(updates);
    });

    it('never activates an untrusted signing key or overwrites a foreign source', async () => {
        const f = await fixture(); f.untrust();
        const step: MachineRecipeStepV1 = { id: 'source', kind: 'packageSource', manager: 'apt', path: join(f.root, 'vendor.list'), keyPath: join(f.root, 'vendor.gpg'),
            url: 'https://packages.example.test/stable', suite: 'bookworm', components: ['main'], architectures: ['amd64'],
            keyUrl: 'https://packages.example.test/key.gpg', keyFingerprint: fingerprint };
        const plan = await checkMachineSetupEffectPlan({ basis, steps: [step], backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('failed');
        await expect(readFile(step.path)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(step.keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(step.path, 'foreign source');
        expect(await f.backend.observe(step)).toMatchObject({ status: 'unavailable', reason: 'foreign_effect_conflict' });
        expect(await readFile(step.path, 'utf8')).toBe('foreign source');
    });

    it('does not report an armored-key source satisfied when its existing asc file contains binary key bytes', async () => {
        const f = await fixture();
        const source: MachineRecipeStepV1 = { id: 'source', kind: 'packageSource', manager: 'apt', path: join(f.root, 'vendor.list'), keyPath: join(f.root, 'vendor.asc'),
            url: 'https://packages.example.test/stable', suite: 'bookworm', components: ['main'], architectures: ['amd64'],
            keyUrl: 'https://packages.example.test/key.gpg', keyFingerprint: fingerprint };
        await writeFile(source.path, `deb [arch=amd64 signed-by=${source.keyPath}] https://packages.example.test/stable bookworm main\n`, { mode: 0o644 });
        await writeFile(source.keyPath, 'binary public key', { mode: 0o644 });
        await chmod(source.path, 0o644); await chmod(source.keyPath, 0o644);
        expect(await f.backend.observe(source)).toMatchObject({ status: 'unavailable', reason: 'validation_failed' });
        expect(await readFile(source.keyPath, 'utf8')).toBe('binary public key');
    });

    it('recovers an interrupted source refresh from real installed source files without replaying an installer', async () => {
        const f = await fixture({ failFirstUpdate: true });
        const source: MachineRecipeStepV1 = { id: 'source', kind: 'packageSource', manager: 'apt', path: join(f.root, 'vendor.list'), keyPath: join(f.root, 'vendor.gpg'),
            url: 'https://packages.example.test/stable', suite: 'bookworm', components: ['main'], architectures: ['amd64'],
            keyUrl: 'https://packages.example.test/key.gpg', keyFingerprint: fingerprint };
        const steps: MachineRecipeStepV1[] = [source, { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }];
        let plan = await checkMachineSetupEffectPlan({ basis, steps, backend: f.backend });
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('failed');
        expect(await readFile(source.path, 'utf8')).toContain('signed-by=');
        plan = await checkMachineSetupEffectPlan({ basis, steps, backend: f.backend });
        expect(plan.nativeFacts[0]?.status).toBe('satisfied');
        expect((await applyMachineSetupEffectPlan({ plan, backend: f.backend })).status).toBe('applied');
        expect(f.calls.filter(command => command.executable === 'apt-get' && command.args[0] === 'install')).toHaveLength(1);
    });
});
