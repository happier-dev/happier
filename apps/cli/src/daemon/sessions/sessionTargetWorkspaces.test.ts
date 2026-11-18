import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSessionHolderChild, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';

import { createFilesystemEffectAdmission, type FilesystemEffectSessionContext } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from './sessionTargetWorkspaces';

/**
 * Files/Git for a Session placed on a target: the daemon's filesystem admission
 * resolves that Session's workspace to its holder in the target (a workspace
 * client next to the Agent client), addressed by the Session's own path. The
 * target here is this host's shell behind the daemon's provider operations.
 */
const holderExecutable = resolveSessionHolderExecutablePath();
const helperExecutable = resolveProcessCustodySupportExecutable('linux');

describe.skipIf(process.platform !== 'linux' || !holderExecutable || !helperExecutable)('Session target workspaces (daemon Files/Git)', () => {
    let directory: string;
    let guestRoot: string;
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'stw-'));
        guestRoot = join(directory, 'guest-ws');
        execFileSync('sh', ['-c', `mkdir -p "${guestRoot}" && printf 'in the target\\n' > "${guestRoot}/a.txt"`]);
    });
    afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

    const operations = {
        exec: (command: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
            child.once('error', reject); child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
        }),
        openChannel: (argv: readonly string[]) => {
            const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
            const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
            child.once('close', () => channel.destroy());
            return channel;
        },
    };

    it('selects directory-only descendants and physical aliases, keeps source identity, and leaves sibling folders local', async () => {
        const lifetime = new AbortController();
        const root = join(directory, 'placed');
        const child = join(root, 'nested');
        const alias = join(directory, 'alias');
        await mkdir(child, { recursive: true });
        await symlink(root, alias);
        registerSessionTargetWorkspace({ sessionId: 'path-session', lifetime: lifetime.signal,
            primarySocketPath: join(directory, 'not-started.sock'),
            target: { id: 'path-target', lifetime: lifetime.signal, holderPath: holderExecutable!, helperPath: helperExecutable!, socketDirectory: directory, ...operations },
            workspace: { hostRoot: root, targetRoot: guestRoot } });
        try {
            const source = resolveSessionTargetWorkspace({ rootPath: child });
            expect(source?.kind).toBe('target');
            expect(source?.id).toBe('path-target:path-session');
            expect(resolveSessionTargetWorkspace({ rootPath: join(alias, 'nested') })).toBe(source);
            expect(resolveSessionTargetWorkspace({ rootPath: `${root}-sibling` })).toBeNull();
            expect(resolveSessionTargetWorkspace({ rootPath: join(root, 'not-created') })).toBe(source);
            // Another person's Session scope reaching into this root selects this Machine's source, so the
            // host identity check decides; the directory match serves only requests without a Session scope.
            const admission = createFilesystemEffectAdmission({ resolveWorkspaceTarget: resolveSessionTargetWorkspace });
            const otherSession: FilesystemEffectSessionContext = { authorization: { kind: 'session.write', sessionId: 'unplaced-session' } };
            expect(admission.selectWorkspaceSource(otherSession, { cwd: child }).kind).toBe('local');
            expect(admission.selectWorkspaceSource(otherSession, { rootPath: join(alias, 'nested') }).kind).toBe('local');
            const ownSession: FilesystemEffectSessionContext = { authorization: { kind: 'session.write', sessionId: 'path-session' } };
            expect(admission.selectWorkspaceSource(ownSession, { cwd: child })).toBe(source);
            expect(admission.selectWorkspaceSource(undefined, { cwd: child })).toBe(source);
            lifetime.abort();
            expect(resolveSessionTargetWorkspace({ rootPath: child })).toBeNull();
        } finally { lifetime.abort(); }
    });

    it('resolves a target Session to its holder workspace once the Agent holder is up, and to nothing after the Session ends', async () => {
        const lifetime = new AbortController();
        const primarySocketPath = join(directory, 'primary.sock');
        registerSessionTargetWorkspace({ sessionId: 'session-t1', lifetime: lifetime.signal, primarySocketPath,
            target: { id: 'managed:row-1', lifetime: lifetime.signal, holderPath: holderExecutable!, helperPath: helperExecutable!, socketDirectory: directory, ...operations },
            workspace: { hostRoot: '/host/sessions/ws', targetRoot: guestRoot } });
        // A request scoped to another Session never borrows this Session's placement (SEC1116G item 1).
        expect(resolveSessionTargetWorkspace({ sessionId: 'another-session', rootPath: '/host/sessions/ws' })).toBeNull();

        // Before the Session's Agent holder runs, the target source refuses (typed), never this Machine's disk.
        const early = resolveSessionTargetWorkspace({ sessionId: 'session-t1', rootPath: '/host/sessions/ws' });
        expect(early?.kind).toBe('target');
        await expect(early!.readFile('/host/sessions/ws/a.txt')).rejects.toBeTruthy();

        const agent: SessionHolderChild = spawnSessionHolderChild({ executablePath: holderExecutable!, socketPath: primarySocketPath,
            command: 'sleep', args: ['600'], cwd: guestRoot, target: { id: 'managed:row-1', holderPath: holderExecutable!, socketDirectory: directory, ...operations } });
        await new Promise<void>((resolve, reject) => { agent.once('spawn', () => resolve()); agent.once('error', reject); });
        try {
            const source = resolveSessionTargetWorkspace({ sessionId: 'session-t1', rootPath: '/host/sessions/ws' })!;
            await expect(source.readFile('/host/sessions/ws/a.txt')).resolves.toEqual(Buffer.from('in the target\n'));
            lifetime.abort();
            expect(resolveSessionTargetWorkspace({ sessionId: 'session-t1', rootPath: '/host/sessions/ws' })).toBeNull();
        } finally {
            await agent.terminateGroup({ graceMs: 100 });
        }
    }, 60_000);
});
