import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { attachSessionHolderWorkspaceClient, openSessionHolderWorkspaceClient, spawnSessionHolderChild, type SessionHolderChild, type SessionHolderTarget } from '@/subprocess/supervision/sessionHolder';

import { createHolderWorkspaceSource } from './holderWorkspaceSource';
import { runWithWorkspaceSource } from './workspaceSource';
import { createScmBackendRegistry } from '@/scm/registry';
import { createWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { readTransferPayloadChunk } from '@/machines/transfer/transferPayloadSource';

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
        const source = createHolderWorkspaceSource({ id: 'target:test', rootPath: root, holder, helperPath: helperExecutable! });
        const printed = await collect(source.spawn({ command: 'sh', args: ['-c', 'printf "%s|%s|%s" "$HAPPIER_TEST_HOST_TOKEN" "$GIT_AUTHOR_NAME" "$LC_ALL"'], cwd: root,
            env: { HAPPIER_TEST_HOST_TOKEN: 'host-only', GIT_AUTHOR_NAME: 'Ann', LC_ALL: 'C' } }));
        expect(printed.stdout).toBe('|Ann|C');
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
