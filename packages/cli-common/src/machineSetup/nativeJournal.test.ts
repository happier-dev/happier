import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';

// Native journal filesystem metadata and OS commands are the only constructed boundaries.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const machineId = 'a'.repeat(32), directory = `/var/log/journal/${machineId}`, journal = `${directory}/system.journal`;
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const missing = () => Object.assign(new Error('absent'), { code: 'ENOENT' });
afterEach(() => vi.restoreAllMocks());

function filesystem(options: { empty?: boolean; denied?: boolean; symlink?: boolean; blockedParent?: boolean } = {}) {
    vi.spyOn(fs, 'readFile').mockImplementation(async path => {
        if (String(path) !== '/etc/machine-id') throw new Error('Journal message bytes must not be read');
        return Buffer.from(`${machineId}\n`);
    });
    vi.spyOn(fs, 'readdir').mockImplementation(async path => {
        if (String(path).startsWith('/run/log/journal/')) throw missing();
        if (String(path) !== directory) throw new Error('Only the current Machine journal directory may be listed');
        if (options.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        // This observer consumes the ordinary string-list overload of the native boundary.
        return (options.empty ? ['user-1000.journal'] : ['system.journal', 'system@archive.journal', 'user-1000.journal']) as never;
    });
    vi.spyOn(fs, 'lstat').mockImplementation(async path => {
        const file = String(path).endsWith('.journal');
        const mode = file ? 0o100640 : 0o40755;
        return Object.assign(await actualFs.lstat(tmpdir()), { uid: 0, gid: file ? 190 : 0,
            mode: options.blockedParent && String(path) === directory ? 0o40700 : mode,
            isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => options.symlink && String(path) === journal,
        });
    });
}
const step = (group = 'systemd-journal') => MachineRecipeStepV1Schema.parse({ id: 'journal-access', kind: 'group', name: group,
    members: ['happier'], existingOnly: true, requiredFacts: [{ kind: 'journalReadGroup', group }] });
function runner(options: { group?: string; acl?: string; present?: boolean; aclUnavailable?: boolean; blockedParent?: boolean } = {}) {
    const calls: MachineSetupNativeCommand[] = [];
    const run = async (command: MachineSetupNativeCommand) => {
        calls.push(command);
        if (command.executable === 'getent') {
            if (command.args.includes('group')) return options.present === false ? { code: 2, stdout: '', stderr: '' }
                : ok(`${options.group ?? 'systemd-journal'}:x:${options.group === 'adm' ? 4 : 190}:foreign\n`);
            return ok('happier:x:900:900::/var/lib/happier:/usr/sbin/nologin\n');
        }
        if (command.executable === 'id') return ok('900\n');
        if (command.executable === 'getfacl') return options.aclUnavailable ? { code: null, errorCode: 'ENOENT', stdout: '', stderr: '' }
            : ok(command.args.slice(command.args.indexOf('--') + 1).map(path => `# file: ${path}\n${path.endsWith('.journal')
                ? options.acl ?? 'user::rw-\ngroup::r--\nother::---\n'
                : options.blockedParent && path === directory ? 'user::rwx\ngroup::---\nother::---\n'
                    : 'user::rwx\ngroup::r-x\nother::r-x\n'}`).join('\n'));
        throw new Error(`Observation attempted an unexpected OS effect ${command.executable}`);
    };
    return { calls, backend: createMachineSetupNativeBackend({ run }) };
}

describe('native journal read-group prerequisite', () => {
    it('proves real system-journal group read and parent traversal before offering only the missing daemon membership', async () => {
        filesystem();
        const { backend, calls } = runner();
        expect(await backend.observe(step())).toMatchObject({ status: 'drifted', facts: { missingMembers: ['happier'] } });
        expect(calls.filter(call => call.executable === 'getfacl')).toHaveLength(1);
        expect(calls.find(call => call.executable === 'getfacl')?.args).toEqual(expect.arrayContaining([journal, `${directory}/system@archive.journal`, directory, '/']));
        expect(calls.every(call => ['getent', 'getfacl', 'id'].includes(call.executable))).toBe(true);
    });
    it('accepts the selected named group only through the effective ACL mask, never existence or stat mask bits', async () => {
        filesystem();
        expect(await runner({ group: 'adm', acl: 'user::rw-\ngroup::---\ngroup:4:r--\nmask::r--\nother::---\n' }).backend.observe(step('adm')))
            .toMatchObject({ status: 'drifted' });
        for (const acl of ['user::rw-\ngroup::---\ngroup:191:r--\nmask::r--\nother::---\n',
            'user::rw-\ngroup::---\ngroup:190:r--\nmask::---\nother::---\n',
            'user::rw-\ngroup::---\ngroup:191:r--\nmask::r--\nother::---\n']) {
            const { backend } = runner({ acl });
            expect(await backend.observe(step())).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
            await expect(backend.apply(step())).rejects.toMatchObject({ reasonCode: 'required_fact_unavailable' });
        }
    });
    it('fails closed without a system journal, local group, traversable ancestors or inspectable native permissions', async () => {
        for (const options of [{ empty: true }, { symlink: true }, { blockedParent: true }]) {
            filesystem(options);
            expect(await runner({ blockedParent: options.blockedParent }).backend.observe(step())).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
            vi.restoreAllMocks();
        }
        filesystem();
        expect(await runner({ present: false }).backend.observe(step())).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        expect(await runner({ aclUnavailable: true }).backend.observe(step())).toMatchObject({ status: 'unsupported', reason: 'required_fact_unavailable' });
        vi.restoreAllMocks(); filesystem({ denied: true });
        expect(await runner().backend.observe(step())).toMatchObject({ status: 'unavailable', reason: 'needs_admin_to_check' });
    });
});
