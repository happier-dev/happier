import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMemberWorkspaceReadSource } from '@/workspaces/activation/memberWorkspaceSource';
import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { executeMemberSessionDirectoryRemoval } from './memberSessionDirectoryRemoval';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each([false, true])('retains the prepared member effect until Home decides deletion (%s)', async homeAccepted => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'member-session-home-'));
    roots.push(workspaceRoot);
    const directory = join(workspaceRoot, 'allocation');
    await mkdir(directory);
    await writeFile(join(directory, 'kept'), 'original');
    let admit!: (accepted: boolean) => void;
    const decision = new Promise<boolean>(resolve => { admit = resolve; });
    let prepared!: () => void;
    const ready = new Promise<void>(resolve => { prepared = resolve; });
    const pending = executeMemberSessionDirectoryRemoval({ kind: 'session_directory_remove', workspaceRoot, directory },
        new AbortController().signal, { async removeSessionDirectory(reads, removeDirectory) {
            expect(Buffer.from(await reads.readFile(join(directory, 'kept'))).toString()).toBe('original');
            prepared();
            if (await decision) await removeDirectory();
        } });
    await ready;
    expect(await readFile(join(directory, 'kept'), 'utf8')).toBe('original');
    admit(homeAccepted);
    await pending;
    if (homeAccepted) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(join(directory, 'kept'), 'utf8')).toBe('original');
});

it('keeps cleanup reads and physical removal inside the member child before acknowledging the host', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'member-session-remove-'));
    roots.push(workspaceRoot);
    const directory = join(workspaceRoot, 'allocation');
    await mkdir(directory);
    await writeFile(join(directory, 'cleanup-input'), 'original');
    let cleaned = false;
    await executeMemberSessionDirectoryRemoval({ kind: 'session_directory_remove', workspaceRoot, directory },
        new AbortController().signal, { async removeSessionDirectory(reads, removeDirectory) {
            const source = createMemberWorkspaceReadSource(reads, workspaceRoot);
            await runWithWorkspaceSource(source, async () => {
                expect((await currentWorkspaceSource().readFile(join(directory, 'cleanup-input'))).toString()).toBe('original');
                cleaned = true;
                await removeDirectory();
            });
        } });
    expect(cleaned).toBe(true);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains the private directory when host cleanup refuses and never follows a substituted directory link', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'member-session-refuse-'));
    roots.push(workspaceRoot);
    const directory = join(workspaceRoot, 'allocation');
    const outside = await mkdtemp(join(tmpdir(), 'member-session-outside-'));
    roots.push(outside);
    await mkdir(directory);
    await writeFile(join(directory, 'kept'), 'retained');
    const effect = { kind: 'session_directory_remove' as const, workspaceRoot, directory };
    await expect(executeMemberSessionDirectoryRemoval(effect, new AbortController().signal, {
        async removeSessionDirectory() { throw Object.assign(new Error('cleanup refused'), { code: 'project_setup_step_failed' }); },
    })).rejects.toMatchObject({ code: 'project_setup_step_failed' });
    expect(await readFile(join(directory, 'kept'), 'utf8')).toBe('retained');
    await rm(directory, { recursive: true });
    await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(executeMemberSessionDirectoryRemoval(effect, new AbortController().signal, {
        async removeSessionDirectory() { throw new Error('Host must not receive a substituted allocation'); },
    })).rejects.toMatchObject({ data: { code: 'session_directory_unavailable' } });
    await access(outside);
});
