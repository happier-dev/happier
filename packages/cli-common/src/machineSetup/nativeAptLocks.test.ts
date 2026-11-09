import { readFile, stat } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectAptLocks, mutateApt } from './nativePackageBackend.js';
import type { NativeRun } from './nativeSystemBackend.js';

vi.mock('node:fs/promises', async importOriginal => ({
    ...await importOriginal<typeof import('node:fs/promises')>(),
    readFile: vi.fn(), stat: vi.fn(),
}));

// Only the kernel/filesystem and command adapters are substituted.
const unresolved: NativeRun = async () => ({ code: 0, stdout: '{"locks":[{"path":"/..."}]}', stderr: '' });
const inode = 9007199254740993n;
beforeEach(async () => {
    vi.resetAllMocks();
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const real = await fs.stat(import.meta.filename, { bigint: true });
    vi.mocked(stat).mockImplementation(async path => {
        if (path !== '/var/lib/dpkg/lock-frontend') throw Object.assign(new Error('Absent'), { code: 'ENOENT' });
        return Object.assign(real, { dev: 2050n, ino: inode });
    });
});

describe('APT locks with unresolved native paths', () => {
    it('allows APT when unreadable paths belong to unrelated locks, including the same inode on another device', async () => {
        vi.mocked(readFile).mockResolvedValue(`1: POSIX ADVISORY WRITE 42 08:03:${inode} 0 EOF\n`);
        expect(await inspectAptLocks(unresolved)).toBe('clear');
        const effects: string[] = [];
        await mutateApt(async (executable, args, env) => {
            if (executable === 'lslocks') return unresolved(executable, args, env);
            effects.push(executable);
            return { code: 0, stdout: '', stderr: '' };
        }, ['install', '--yes', '--', 'hello']);
        expect(effects).toEqual(['apt-get']);
    });

    it.each(['POSIX', 'FLOCK', 'OFDLCK'])('retains a real %s APT lock even when its path cannot be resolved', async kind => {
        vi.mocked(readFile).mockResolvedValue(`1: ${kind} ADVISORY WRITE ${kind === 'OFDLCK' ? -1 : 42} 08:02:${inode} 0 EOF\n`);
        expect(await inspectAptLocks(unresolved)).toBe('busy');
        await expect(mutateApt(unresolved, ['install', '--yes', '--', 'hello'])).rejects.toMatchObject({ reasonCode: 'package_manager_busy' });
    });

    it('does not confuse adjacent inode values beyond Number precision', async () => {
        vi.mocked(readFile).mockResolvedValue(`1: POSIX ADVISORY WRITE 42 08:02:${inode - 1n} 0 EOF\n`);
        expect(await inspectAptLocks(unresolved)).toBe('clear');
    });

    it('accepts an empty kernel lock table and missing APT lock files', async () => {
        vi.mocked(readFile).mockResolvedValue('');
        vi.mocked(stat).mockRejectedValue(Object.assign(new Error('Absent'), { code: 'ENOENT' }));
        expect(await inspectAptLocks(unresolved)).toBe('clear');
    });

    it('keeps genuinely unreadable kernel evidence unavailable without running APT', async () => {
        vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('Denied'), { code: 'EACCES' }));
        expect(await inspectAptLocks(unresolved)).toBe('unknown');
        await expect(mutateApt(unresolved, ['install', '--yes', '--', 'hello'])).rejects.toMatchObject({ reasonCode: 'needs_admin_to_check' });
    });

    it('keeps unreadable APT file identities unavailable', async () => {
        vi.mocked(readFile).mockResolvedValue('');
        vi.mocked(stat).mockRejectedValue(Object.assign(new Error('Denied'), { code: 'EACCES' }));
        expect(await inspectAptLocks(unresolved)).toBe('unknown');
    });

    it('keeps malformed kernel records unavailable', async () => {
        vi.mocked(readFile).mockResolvedValue('unrecognized kernel record\n');
        expect(await inspectAptLocks(unresolved)).toBe('unknown');
    });
});
