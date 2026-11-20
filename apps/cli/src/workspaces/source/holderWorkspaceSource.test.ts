import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { attachSessionHolderWorkspaceClient, openSessionHolderWorkspaceClient, spawnSessionHolderChild, type SessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';

import { createHolderWorkspaceSource } from './holderWorkspaceSource';
import { runWithWorkspaceSource, type WorkspaceSourcePlacement } from './workspaceSource';
import { createScmBackendRegistry } from '@/scm/registry';
import { createWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { readTransferPayloadChunk } from '@/machines/transfer/transferPayloadSource';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { applyManagedWorkspaceReturn, prepareManagedWorkspaceReturnFromStage } from '@/workspaces/sync/managedWorkspaceReturn';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { prepareEnrolledWorkspaceReturn, prepareEnrolledWorkspaceReturnChildren } from '@/workspaces/sync/enrolledWorkspaceReturn';
import { runManagedWorkspaceReturnTarget } from '@/workspaces/sync/managedWorkspaceReturnTarget';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';

/**
 * The target workspace source runs every operation through the Session's
 * holder: real holder and custody helper executables, a real Git repository at
 * the holder's root, and a provider channel that is a real `holder attach`
 * process. The target is this host's shell (the Lima container run covers a
 * target whose disk differs from this Machine's).
 */

const holderExecutable = resolveSessionHolderExecutablePath();
const helperExecutable = resolveProcessCustodySupportExecutable('linux');

function collect(child: { stdout: NodeJS.ReadableStream; once(event: 'close', listener: (code: number | null) => void): unknown }) {
    return new Promise<{ code: number | null; stdout: string }>((resolve) => {
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.once('close', code => resolve({ code, stdout }));
    });
}

describe.skipIf(process.platform !== 'linux' || !holderExecutable || !helperExecutable)('holder-backed target workspace source', () => {
    let directory: string;
    let root: string;
    let holder: SessionHolderChild;
    let agent: SessionHolderChild;
    let target: SessionHolderTarget;
    const disposers: Array<() => void> = [];
    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'hws-'));
        root = join(directory, 'ws');
        execFileSync('sh', ['-c', `mkdir -p "${root}" && cd "${root}" && git init -q && git config user.email t@t && git config user.name t && printf 'needle in a haystack\\n' > a.txt && git add a.txt && git commit -qm init && printf 'changed needle\\n' > a.txt`]);
        await symlink('/etc/hostname', join(root, 'escape'));
        await writeFile(join(directory, 'outside.txt'), 'outside');
        target = {
            id: 'local-test-target', holderPath: holderExecutable!, socketDirectory: directory,
            exec: command => new Promise((resolve, reject) => {
                const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, HAPPIER_TEST_SCM_LOCATION: 'target' } });
                let stdout = '';
                child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                child.once('error', reject);
                child.once('close', status => resolve({ status: status ?? 1, stdout, stderr: '' }));
            }),
            openChannel: argv => {
                const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
                const channel = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
                child.once('close', () => channel.destroy());
                return channel;
            },
        };
        agent = spawnSessionHolderChild({ executablePath: holderExecutable!, socketPath: join(directory, 'h.sock'),
            command: 'sleep', args: ['600'], cwd: root, target });
        await new Promise<void>((resolve, reject) => { agent.once('spawn', () => resolve()); agent.once('error', reject); });
        // Workspace operations use their own client beside the Agent-control client.
        holder = await attachSessionHolderWorkspaceClient(join(directory, 'h.sock'), target);
    });
    afterAll(async () => {
        for (const dispose of disposers) dispose();
        holder?.detach();
        await agent?.terminateGroup({ graceMs: 100 });
        await rm(directory, { recursive: true, force: true });
    });

    it('runs Git and search in the target, reads through the confined helper, refuses escapes and unsupported operations', async () => {
        const source = createHolderWorkspaceSource({ id: 'target:test', rootPath: root, holder, helperPath: helperExecutable! });
        expect(source.kind).toBe('target');

        const git = await source.resolveExecutable('git', {});
        expect(git).toMatch(/\/git$/u);
        const status = await collect(source.spawn({ command: git!, args: ['status', '--porcelain=v2'], cwd: root }));
        expect(status.code).toBe(0);
        expect(status.stdout).toMatch(/^1 \.M .* a\.txt$/mu);

        const search = await source.toolLaunch({ tool: 'ripgrep', args: ['--no-heading', '-F', 'needle'], paths: ['.'] });
        const found = await collect(source.spawn({ command: search.command, args: search.args, cwd: root }));
        expect(found.stdout).toContain('a.txt:changed needle');

        await expect(source.readFile(join(root, 'a.txt'))).resolves.toEqual(Buffer.from('changed needle\n'));
        await expect(source.readFile(join(directory, 'outside.txt'))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
        // A link leaving the root is refused by the helper's handle chain, not followed.
        await expect(source.readFile(join(root, 'escape'))).rejects.toBeTruthy();
        expect(() => source.spawn({ command: 'true', args: [], cwd: directory })).toThrow(expect.objectContaining({ code: 'workspace_root_unsafe' }));

        await expect(source.resolveExecutable('definitely-not-a-command-happier', {})).resolves.toBeNull();
    }, 60_000);

    it('addresses the target workspace by the Session\'s own path when the guest keeps it elsewhere', async () => {
        // The Session's path on this Machine (what the app addresses) vs the same workspace inside the target.
        const sessionPath = '/host/sessions/ws';
        const source = createHolderWorkspaceSource({ id: 'target:mapped', rootPath: sessionPath, guestRootPath: root, holder, helperPath: helperExecutable! });
        await expect(source.readFile(`${sessionPath}/a.txt`)).resolves.toEqual(Buffer.from('changed needle\n'));
        expect((await source.readdir(sessionPath)).map(entry => entry.name)).toContain('a.txt');
        await expect(source.realpath(`${sessionPath}/a.txt`)).resolves.toBe(`${sessionPath}/a.txt`);
        await expect(source.readFile(`${root}/a.txt`)).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
    }, 60_000);

    it('prepares review against the original guest instead of the controller at the same path', async () => {
        const dir = await mkdtemp(join(directory, 'return-'));
        const original = join(dir, 'project');
        const staged = join(dir, 'stage');
        const guest = join(root, 'reviewed-project');
        const file = 'return-sentinel.txt';
        try {
            await Promise.all([mkdir(original), mkdir(staged), mkdir(guest)]);
            await Promise.all([
                writeFile(join(guest, file), 'guest original\n'),
                writeFile(join(original, file), 'controller original\n'),
                writeFile(join(staged, file), 'session edit\n'),
            ]);
            const source = createHolderWorkspaceSource({
                id: 'target:return-review', rootPath: original, guestRootPath: guest, holder, helperPath: helperExecutable!,
            });
            expect(await source.readFile(join(original, file))).toEqual(Buffer.from('guest original\n'));
            const accountId = 'return-review-account';
            const sessionId = 'managed-return-review';
            const controller = { machineId: 'return-controller', installationId: 'return-installation' };
            const sourceWorkspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'original',
                managedId: 'guest', rootPath: original, controller } as const;
            const targetWorkspace = { serverId: 'home', machineId: controller.machineId, workspaceId: 'copy', rootPath: staged };
            const prepared = await prepareEnrolledWorkspaceReturnChildren({
                sessionId, machineId: controller.machineId, activeServerDir: dir, actionRequestId: 'return-request',
                readRequesterWorkspaceScope: async () => ({ kind: 'available', homeDir: dir, workspaceRoot: null }),
                metadata: { sessionCreationCorrespondenceV1: {
                    v: 1, sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'test', creationKey: 'return' }),
                    recipe: {
                        execution: { machineId: controller.machineId, directory: { kind: 'path', path: staged } },
                        organization: { folderId: null, tagIds: [] },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
                        configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
                        terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
                        projectFilesOrigin: { sourceWorkspace, targetWorkspace },
                    },
                } },
            });
            if (!prepared) throw new Error('Expected the managed Project origin to be admitted');
            const reviewInput = {
                sessionId, activeServerDir: dir, prepared, registry: createScmBackendRegistry([]),
                resolveWorkspaceTarget: ({ workspace, requesterAccountId }: WorkspaceSourcePlacement) =>
                    workspace?.workspaceId === sourceWorkspace.workspaceId && requesterAccountId === accountId ? source : null,
                // The reviewed child transport is the only substituted boundary. The guest source is the real holder.
                invokeReviewedChild: async (child: Parameters<HostReviewedChildPortV1['invoke']>[0]) => {
                    const open = OpenProjectInputV1Schema.parse(child.input);
                    if (open.materialization.kind === 'attach') {
                        expect(open.source).toMatchObject({ kind: 'workspace', checkout: sourceWorkspace });
                        return { ok: true as const, result: { kind: 'opened', directory: original, workspace: sourceWorkspace, setup: 'notRequired' } };
                    }
                    expect(open.source).toMatchObject({ kind: 'workspace', checkout: targetWorkspace });
                    return { ok: true as const, result: { kind: 'opened', directory: staged, workspace: targetWorkspace, setup: 'notRequired' } };
                },
            };
            const withoutCustody = await runWithScmAccountScope('other-account', () => prepareEnrolledWorkspaceReturn(reviewInput));
            expect(withoutCustody).toMatchObject({ ok: false, errorCode: 'workspace_target_unavailable' });
            const review = await runWithScmAccountScope(accountId, () => prepareEnrolledWorkspaceReturn(reviewInput));
            if ('ok' in review) throw new Error(`Review failed: ${review.errorCode} ${JSON.stringify(review.failureCause)}`);
            expect(review.paths.flatMap(path => path.files)).toContainEqual(expect.objectContaining({
                path: file,
                evidence: { state: 'available', unifiedDiff: expect.stringContaining('-guest original\n') },
            }));
        } finally {
            await rm(guest, { recursive: true, force: true });
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('applies the retained review only to the original guest even when the controller has the same preimage', async () => {
        const dir = await mkdtemp(join(directory, 'return-apply-'));
        const original = join(dir, 'project');
        const staged = join(dir, 'stage');
        const guest = join(root, 'applied-project');
        const file = 'return-apply-sentinel.txt';
        try {
            await Promise.all([mkdir(original), mkdir(staged), mkdir(guest)]);
            const before = 'same original bytes\n';
            const after = 'reviewed guest change\n';
            await Promise.all([
                writeFile(join(guest, file), before),
                writeFile(join(original, file), before),
                writeFile(join(staged, file), after),
            ]);
            const registry = createScmBackendRegistry([]);
            const baseline = await scanWorkspaceManifest({ workspaceRoot: original, scmRegistry: registry });
            const source = createHolderWorkspaceSource({
                id: 'target:return-apply', rootPath: original, guestRootPath: guest, holder, helperPath: helperExecutable!,
            });
            const sessionId = 'managed-return-apply';
            const accountId = 'return-review-account';
            const workspace = { v: 2, kind: 'managed', serverId: 'home', workspaceId: 'original',
                managedId: 'guest', rootPath: original, controller: { machineId: 'controller', installationId: 'install' } } as const;
            const preview = await runWithScmAccountScope(accountId, () => prepareManagedWorkspaceReturnFromStage({
                sessionId, hostRoot: original, stageRoot: staged, activeServerDir: dir, baseline, registry,
                original: { workspace, source },
            }));
            // A fresh RPC has no inherited source. Missing native custody must fail closed.
            const applyInput = { sessionId, returnId: preview.returnId, paths: [file], activeServerDir: dir };
            await expect(runWithScmAccountScope(accountId, () => applyManagedWorkspaceReturn(applyInput)))
                .rejects.toMatchObject({ code: 'workspace_target_unavailable' });
            await expect(readFile(join(original, file), 'utf8')).resolves.toBe(before);
            await expect(source.readFile(join(original, file))).resolves.toEqual(Buffer.from(before));

            const workers: Promise<void>[] = [];
            const withManagedTarget: NonNullable<Parameters<typeof applyManagedWorkspaceReturn>[0]['withManagedTarget']> =
                async (selected, apply) => {
                    expect(selected).toEqual(workspace);
                    // Provider transport substitutes only the guest filesystem and process boundary.
                    // The private effect protocol and its native guarded replacement run unchanged.
                    const signal = new AbortController().signal;
                    await runManagedWorkspaceReturnTarget({ rootPath: guest, operationId: 'reviewed-return', signal, apply,
                        target: {
                            home: dir,
                            ensureWorkspaceRuntime: async () => ({ binaryPath: '/guest/happier' }),
                            openChannel: (argv, lifetime) => {
                                const input = new PassThrough(), output = new PassThrough();
                                const channel = Duplex.from({ readable: output, writable: input });
                                const worker = runWorkspaceEffectWorker([], { input, output, signal: lifetime,
                                    currentDirectory: () => argv[4]! }).finally(() => output.end());
                                workers.push(worker);
                                void worker.catch(error => channel.destroy(error));
                                return channel;
                            },
                        } });
                };
            try {
                const apply = () => runWithScmAccountScope(accountId, () => applyManagedWorkspaceReturn({ ...applyInput, withManagedTarget }));
                await writeFile(join(guest, file), 'later guest edit\n');
                await expect(apply()).rejects.toMatchObject({ code: 'conflict_changed', details: { appliedPaths: [], path: file } });
                await expect(readFile(join(guest, file), 'utf8')).resolves.toBe('later guest edit\n');
                await writeFile(join(guest, file), before);
                await expect(apply()).resolves.toEqual({ appliedPaths: [file], conflicts: [] });
                await expect(readFile(join(original, file), 'utf8')).resolves.toBe(before);
                await expect(source.readFile(join(original, file))).resolves.toEqual(Buffer.from(after));
            } finally {
                await Promise.all(workers);
            }
        } finally {
            await rm(guest, { recursive: true, force: true });
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('opens transfer files larger than a file preview without truncating their bytes', async () => {
        const source = createHolderWorkspaceSource({ id: 'target:transfer', rootPath: root, holder, helperPath: helperExecutable! });
        const bytes = Buffer.alloc(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES + 1, 0x81);
        const filePath = join(root, 'large-transfer.bin');
        await writeFile(filePath, bytes);
        const file = await source.open(filePath, { noFollow: true });
        try {
            const tail = Buffer.alloc(2);
            const read = await file.read(tail, 0, 2, bytes.length - 2);
            expect(read.bytesRead).toBe(2);
            expect(tail).toEqual(bytes.subarray(-2));
        } finally { await file.close(); }
    });

    it('serves handoff seed blobs from the target instead of opening the same path on the host', async () => {
        const addressedRoot = '/host-only-project-address';
        const seedRoot = join(root, 'seed-files');
        await mkdir(seedRoot);
        const source = createHolderWorkspaceSource({ id: 'target:seed', rootPath: addressedRoot,
            guestRootPath: seedRoot, holder, helperPath: helperExecutable! });
        await writeFile(join(seedRoot, 'seed-export.bin'), Buffer.from([0, 255, 2]));
        const seed = await runWithWorkspaceSource(source, () => createWorkspaceSyncSeedExport({
            operationId: 'managed-reverse', activeServerDir: directory, sourcePath: addressedRoot,
            workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] }, registry: createScmBackendRegistry([]),
        }));
        const envelope = JSON.parse(seed.payloadSource.payload.toString('utf8')) as {
            workspaceExportArtifacts: { manifest: { entries: Array<{ relativePath: string; digest?: string }> } };
            blobTransferIds: Record<string, string>;
        };
        const entry = envelope.workspaceExportArtifacts.manifest.entries.find(entry => entry.relativePath === 'seed-export.bin')!;
        const blob = await seed.onDemandScope.resolvePayloadSourceOnOpen({ transferId: envelope.blobTransferIds[entry.digest!]!, requestBody: {} });
        expect(await readTransferPayloadChunk({ source: blob, offset: 0, length: 3 })).toEqual(Buffer.from([0, 255, 2]));
    });

    it('forwards only allowlisted workspace-command environment into the target, never other host entries', async () => {
        const addressedRoot = join(directory, 'controller');
        const source = createHolderWorkspaceSource({ id: 'target:test', rootPath: addressedRoot, guestRootPath: root, holder, helperPath: helperExecutable! });
        const printed = await collect(source.spawn({ command: 'sh', args: ['-c', 'printf "%s|%s|%s|%s" "$HAPPIER_TEST_HOST_TOKEN" "$GIT_AUTHOR_NAME" "$LC_ALL" "$GIT_INDEX_FILE"'], cwd: addressedRoot,
            env: { HAPPIER_TEST_HOST_TOKEN: 'host-only', GIT_AUTHOR_NAME: 'Ann', LC_ALL: 'C', GIT_INDEX_FILE: join(addressedRoot, '.git/private') } }));
        expect(printed.stdout).toBe(`|Ann|C|${join(root, '.git/private')}`);
        expect(() => source.spawn({ command: 'git', args: ['write-tree'], cwd: addressedRoot,
            env: { GIT_INDEX_FILE: join(directory, 'outside') } })).toThrow(expect.objectContaining({ code: 'workspace_root_unsafe' }));
    }, 60_000);

    it('lists, stats, writes with expectations, renames, deletes and watches through the helper and holder', async () => {
        const source = createHolderWorkspaceSource({ id: 'target:test', rootPath: root, holder, helperPath: helperExecutable! });
        const names = (await source.readdir(root)).map(entry => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`).sort();
        expect(names).toEqual(expect.arrayContaining(['.git:d', 'a.txt:f', 'escape:l']));
        expect((await source.stat(join(root, 'a.txt'))).size).toBe(15);
        expect((await source.lstat(join(root, 'escape'))).isSymbolicLink()).toBe(true);
        await expect(source.stat(join(root, 'escape'))).rejects.toMatchObject({ code: 'workspace_root_unsafe' });
        await expect(source.readlink(join(root, 'escape'))).resolves.toBe('/etc/hostname');
        await expect(source.realpath(join(root, 'a.txt'))).resolves.toBe(join(root, 'a.txt'));

        const changes: string[] = [];
        const ready = new Promise<void>(resolve => {
            const dispose = source.watchTree([{ directory: root, onStructuralChange: (changed) => { changes.push(`s:${changed}`); }, onFileChange: (changed) => { changes.push(`f:${changed}`); } }],
                { onReady: () => resolve() });
            disposers.push(dispose);
        });
        await ready;
        await source.mkdir(join(root, 'dir/sub'), { recursive: true });
        await expect(source.readdir(join(root, 'dir/sub'))).resolves.toEqual([]);
        await expect(source.replaceFile({ destPath: join(root, 'dir/sub/n.txt'), expectation: null, source: { kind: 'bytes', bytes: Buffer.from('new') } }))
            .resolves.toMatchObject({ success: true });
        await expect(source.replaceFile({ destPath: join(root, 'dir/sub/n.txt'), expectation: null, source: { kind: 'bytes', bytes: Buffer.from('again') } }))
            .resolves.toMatchObject({ success: false, errorCode: 'expected_file_absent' });
        await expect(source.replaceFile({ destPath: join(root, 'dir/sub/n.txt'), expectation: '0'.repeat(64), source: { kind: 'bytes', bytes: Buffer.from('again') } }))
            .resolves.toMatchObject({ success: false, errorCode: 'hash_mismatch' });
        await source.rename(join(root, 'dir/sub/n.txt'), join(root, 'dir/moved.txt'));
        await expect(source.readFile(join(root, 'dir/moved.txt'))).resolves.toEqual(Buffer.from('new'));
        await expect.poll(() => changes.some(change => change.endsWith('dir/moved.txt')), { timeout: 10_000 }).toBe(true);
        await source.rm(join(root, 'dir'), { recursive: true });
        await expect(source.lstat(join(root, 'dir'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(source.writeFile(join(root, 'escape/x'), Buffer.from('x'))).rejects.toBeTruthy();
    }, 60_000);

    it('keeps the workspace client away from the Agent: its process and state ops are refused', async () => {
        for (const op of ['signal', 'status', 'meta'] as const) {
            await expect(holder.request({ op, signal: 'KILL', value: null })).resolves.toMatchObject({ ok: false, error: 'forbidden_for_workspace_client' });
        }
        await expect(agent.request({ op: 'status' })).resolves.toMatchObject({ ok: true, exit: null });
    }, 30_000);

    it('runs a terminal in the target as a tty with resize, input and exit', async () => {
        const terminal = holder.spawnStream({ op: 'pty', argv: ['sh', '-c', 'stty size; read line; echo got:$line'], cwd: '', cols: 90, rows: 30 });
        let out = '';
        terminal.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
        await expect.poll(() => out, { timeout: 10_000 }).toContain('30 90');
        terminal.resize(100, 40);
        terminal.stdin.write('hello\r');
        await new Promise(resolve => terminal.once('exit', resolve));
        expect(out).toContain('got:hello');
    }, 30_000);


});
