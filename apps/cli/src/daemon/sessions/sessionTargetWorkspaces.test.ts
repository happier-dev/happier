import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import axios from 'axios';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { spawnSessionHolderChild, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';

import { createFilesystemEffectAdmission, type FilesystemEffectSessionContext } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { runWithWorkspaceSourceDemand } from '@/workspaces/source/workspaceSource';
import { openProject } from '@/workspaces/activation/openProject';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { registerManagedWorkspaceTarget, registerSessionTargetWorkspace, resolveSessionTargetWorkspace } from './sessionTargetWorkspaces';

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

    it('accepts a confined guest folder as an exact Project Account row', async () => {
        const serverId = 'srv_managed_account_project';
        const serverUrl = 'https://managed-project.invalid';
        const controller = { machineId: 'machine', installationId: 'installation' };
        const lifetime = new AbortController();
        await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl });
        const rows: unknown[] = [];
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
        const post = vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows));
        onTestFinished(() => { lifetime.abort(); get.mockRestore(); post.mockRestore(); });
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
        let opened = 0;
        const runtime = { serverId, serverHttpBaseUrl: serverUrl, machineId: controller.machineId, accountId: 'owner',
            readCredentials: async () => credentials,
            openManagedProjectWorkspace: async () => ({ lifetime: lifetime.signal,
                holderPath: holderExecutable!, helperPath: helperExecutable!,
                openChannel(argv: readonly string[]) { opened += 1; return operations.openChannel(argv); } }),
        };
        const context = { signal: lifetime.signal, callerAuthority: 'present_user',
            machineAdmission: { ...controller, actorAccountId: 'owner', custodianAccountId: 'owner', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true } as const;
        const request = { serverId, machineId: controller.machineId,
            source: { kind: 'folder', path: guestRoot },
            materialization: { kind: 'attach', targetManaged: { managedId: 'managed-machine', controller } },
        } as const;
        await expect(openProject({ ...request, subdir: '../' }, runtime, context))
            .resolves.toMatchObject({ kind: 'refused', code: 'workspace_root_unsafe' });
        expect(opened).toBe(0);
        expect(rows).toEqual([]);
        const result = await openProject(request, runtime, context);
        expect(result).toMatchObject({ kind: 'opened', workspace: { kind: 'managed', v: 2, serverId,
            controller, managedId: 'managed-machine', rootPath: guestRoot }, directory: guestRoot });
        if (result.kind !== 'opened' || result.workspace.kind !== 'managed') throw Error('managed workspace unavailable');
        const source = resolveSessionTargetWorkspace({ workspace: result.workspace });
        await expect(runWithWorkspaceSourceDemand(source!, () => source!.readFile(join(guestRoot, 'a.txt'))))
            .resolves.toEqual(Buffer.from('in the target\n'));
        expect(opened).toBe(2);
    });

    it('F2: overlapping managed workspace requests reuse one holder and the last release closes it', async () => {
        const lifetime = new AbortController();
        const workspace = {
            v: 2 as const, kind: 'managed' as const, workspaceId: 'managed-project', managedId: 'row-2', serverId: 'home',
            controller: { machineId: 'machine', installationId: 'install' }, rootPath: guestRoot,
        };
        const exits: Promise<number | null>[] = [];
        let openChannels = 0;
        try {
            registerManagedWorkspaceTarget({ workspace, target: {
                lifetime: lifetime.signal, holderPath: holderExecutable!, helperPath: helperExecutable!,
                openChannel(argv) {
                    openChannels += 1;
                    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                    exits.push(new Promise((resolve, reject) => {
                        child.once('error', reject);
                        child.once('exit', resolve);
                    }));
                    return Duplex.from({ readable: child.stdout!, writable: child.stdin! });
                },
            } });
            expect(openChannels).toBe(0);
            const source = resolveSessionTargetWorkspace({ workspace });
            expect(source?.kind).toBe('target');
            expect(resolveSessionTargetWorkspace({ workspace: { ...workspace, controller: { ...workspace.controller,
                installationId: 'other-install' } } })).toBeNull();
            expect(resolveSessionTargetWorkspace({ workspace, sessionId: 'unrelated-session' })).toBeNull();
            expect(openChannels).toBe(0);

            const request = () => runWithWorkspaceSourceDemand(source!, () => source!.readFile(join(guestRoot, 'a.txt')));
            const content = Buffer.from('in the target\n');
            await expect(Promise.all([request(), request(), request()])).resolves.toEqual([content, content, content]);
            expect(openChannels).toBe(1);
            await expect(exits[0]).resolves.toBe(0);
            await expect(request()).resolves.toEqual(content);
            expect(openChannels).toBe(2);
            await expect(exits[1]).resolves.toBe(0);
            lifetime.abort();
            expect(resolveSessionTargetWorkspace({ workspace })).toBeNull();
        } finally { lifetime.abort(); }
    });

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
