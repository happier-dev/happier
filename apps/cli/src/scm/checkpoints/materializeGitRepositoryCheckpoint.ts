import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { currentWorkspaceSource, type WorkspaceWriteStream } from '@/workspaces/source/workspaceSource';
import { platform, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { runGitCheckpointCommand } from './gitCheckpointCommands';
import { assertWorkspaceMaterializationSymlinkTarget, resolveContainedWorkspaceMaterializationPath } from '../workspace/workspaceMaterializationSafety';

type CheckpointFile = Readonly<{ path: string; mode: string; oid: string; size: number }>;

function assertNativeCheckpointPath(path: string, symlinkTarget = false): void {
    // Win32 file names must not resolve to streams, devices or trimmed aliases.
    if (platform() === 'win32' && path.split('/').some(part => {
        if (symlinkTarget && (part === '.' || part === '..')) return false;
        return /[\\<>:"|?*\x00-\x1f]|[. ]$/.test(part)
            || /^(?:CON|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:\.|$)/i.test(part);
    })) throw new Error('Checkpoint path cannot be represented exactly on this filesystem');
}

/** Raw checkpoint objects, without checkout filters, export attributes or remote retrieval. */
export async function materializeGitRepositoryCheckpoint(input: Readonly<{
    cwd: string; endpoint: string; directory: string;
}>): Promise<void> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.endpoint)) throw new Error('An immutable checkpoint endpoint is required');
    // The materialized endpoint is written into the workspace source the Agent reads; the
    // Git listing stays in host temp space (the command owner's stdout file).
    const source = currentWorkspaceSource();
    const files: CheckpointFile[] = [];
    const paths = new Set<string>();
    const expectedChildren = new Map<string, Set<string>>([[resolve(input.directory), new Set()]]);
    const assertNativeSpelling = async () => {
        for (const [directory, expected] of expectedChildren) {
            const actual = (await source.readdir(directory)).map(entry => entry.name);
            if (actual.length !== expected.size || actual.some(name => !expected.has(name))) {
                throw new Error('Checkpoint hierarchy cannot be represented exactly on this filesystem');
            }
        }
    };
    await source.mkdir(input.directory, { recursive: true });
    const consumeEntry = async (bytes: Buffer) => {
        const row = bytes.toString('utf8');
        if (!Buffer.from(row).equals(bytes)) throw new Error('Checkpoint paths cannot be represented on this filesystem');
        const entry = /^(\d+) (blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(row);
        if (!entry) throw new Error('Git returned an invalid checkpoint entry');
        const [, mode, kind, oid, size, name] = entry;
        if (!name || name.split('/').some(part => part.toLowerCase() === '.git') || paths.has(name)) throw new Error('Checkpoint contains an unsafe or duplicate path');
        assertNativeCheckpointPath(name);
        const path = resolveContainedWorkspaceMaterializationPath({ workspaceRoot: input.directory, candidatePath: name,
            errorMessage: 'Checkpoint path escapes its pinned directory', pathRepresentation: 'native_literal' });
        if (relative(input.directory, path).split(sep).join('/') !== name) throw new Error('Checkpoint path cannot be represented exactly on this filesystem');
        paths.add(name);
        let parent = resolve(input.directory);
        const components = name.split('/');
        for (const [position, component] of components.entries()) {
            expectedChildren.get(parent)!.add(component);
            if (position < components.length - 1 || mode === '160000') {
                parent = join(parent, component);
                if (!expectedChildren.has(parent)) expectedChildren.set(parent, new Set());
            }
        }
        if (kind === 'commit' && mode === '160000') {
            // A Gitlink captures an object identity, not the submodule's working files.
            await source.mkdir(path, { recursive: true });
            return;
        }
        if (kind !== 'blob' || !['100644', '100755', '120000'].includes(mode!)) throw new Error('Checkpoint entry is not a supported file');
        const byteLength = Number(size);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('Checkpoint object size is unavailable');
        await source.mkdir(dirname(path), { recursive: true });
        files.push({ path, mode: mode!, oid: oid!, size: byteLength });
    };
    // The command owner writes raw stdout directly to an exclusively owned file.
    // Parse NUL records incrementally, without imposing its text collection budget
    // on the complete readable tree or decoding split UTF-8 path characters.
    const enumerationDirectory = await mkdtemp(join(tmpdir(), 'happier-checkpoint-tree-'));
    try {
        const listingPath = join(enumerationDirectory, 'listing');
        const listing = await runGitCheckpointCommand({ cwd: input.cwd,
            args: ['ls-tree', '-r', '-z', '-l', '--full-tree', input.endpoint], stdoutFilePath: listingPath });
        if (!listing.success) throw new Error(listing.stderr || 'The captured endpoint objects are unavailable');
        let pendingRow = Buffer.alloc(0);
        for await (const chunk of createReadStream(listingPath)) {
            const data = pendingRow.length ? Buffer.concat([pendingRow, chunk]) : chunk;
            let offset = 0;
            let delimiter: number;
            while ((delimiter = data.indexOf(0, offset)) >= 0) {
                await consumeEntry(data.subarray(offset, delimiter));
                offset = delimiter + 1;
            }
            pendingRow = Buffer.from(data.subarray(offset));
        }
        if (pendingRow.length) throw new Error('Git returned an incomplete checkpoint entry');
    } finally {
        await rm(enumerationDirectory, { recursive: true, force: true });
    }
    if (!files.length) { await assertNativeSpelling(); return; }
    // Each batch response is exactly "oid blob size\n", the declared bytes, and "\n".
    // Derive the stream allowance from these immutable object sizes, not a local file cap.
    const batchBytes = files.reduce((sum, file) => sum + file.oid.length + 6 + String(file.size).length + 2 + file.size, 0);
    if (!Number.isSafeInteger(batchBytes)) throw new Error('Checkpoint byte count cannot be represented');
    let pending = Buffer.alloc(0);
    let index = 0;
    let remaining = -1;
    let descriptor: WorkspaceWriteStream | undefined;
    // A target's writes settle asynchronously; they are awaited, in order, before the result is trusted.
    let writes: Promise<void> = Promise.resolve();
    const settle = (result: void | Promise<void>) => { if (result) writes = Promise.all([writes, result]).then(() => undefined); };
    try {
        const batch = await runGitCheckpointCommand({ cwd: input.cwd, args: ['cat-file', '--batch'],
            stdin: files.map(file => file.oid).join('\n') + '\n', maxOutputBytes: batchBytes,
            stdoutConsumer: chunk => {
                let data = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
                pending = Buffer.alloc(0);
                while (data.length) {
                    const file = files[index];
                    if (!file) throw new Error('Git returned unexpected checkpoint object bytes');
                    if (remaining === -1) {
                        const newline = data.indexOf(10);
                        if (newline < 0) { pending = data; break; }
                        if (data.subarray(0, newline).toString('ascii') !== `${file.oid} blob ${file.size}`) throw new Error('Captured checkpoint blob is unavailable');
                        descriptor = source.openWrite(file.path, { mode: file.mode === '100755' ? 0o755 : 0o644 });
                        remaining = file.size;
                        data = data.subarray(newline + 1);
                    } else if (remaining > 0) {
                        const consumed = Math.min(remaining, data.length);
                        settle(descriptor!.write(Buffer.from(data.subarray(0, consumed))));
                        remaining -= consumed;
                        data = data.subarray(consumed);
                    } else {
                        if (data[0] !== 10) throw new Error('Git returned malformed checkpoint blob framing');
                        settle(descriptor!.close()); descriptor = undefined;
                        index++; remaining = -1;
                        data = data.subarray(1);
                    }
                }
                return 'continue';
            } });
        await writes;
        if (!batch.success || index !== files.length || pending.length || descriptor !== undefined) throw new Error(batch.stderr || 'The captured checkpoint contents are incomplete');
    } finally { if (descriptor !== undefined) await descriptor.close(); await writes.catch(() => undefined); }
    // Install links only after all ordinary files are written, so links never redirect writes.
    for (const file of files.filter(file => file.mode === '120000')) {
        const targetBytes = await source.readFile(file.path);
        const target = targetBytes.toString('utf8');
        if (!Buffer.from(target).equals(targetBytes)) throw new Error('Checkpoint symlink cannot be represented exactly');
        assertNativeCheckpointPath(target, true);
        assertWorkspaceMaterializationSymlinkTarget({ workspaceRoot: input.directory, linkPath: file.path, target,
            pathRepresentation: 'native_literal' });
        await source.rm(file.path);
        await source.symlink(target, file.path);
    }
    for (const file of files.filter(file => file.mode === '120000')) {
        assertWorkspaceMaterializationSymlinkTarget({ workspaceRoot: input.directory, linkPath: file.path,
            target: await source.readlink(file.path), pathRepresentation: 'native_literal', installed: true });
    }
    await assertNativeSpelling();
}
