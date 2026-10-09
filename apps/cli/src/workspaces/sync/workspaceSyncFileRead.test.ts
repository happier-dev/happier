import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { measureWorkspaceSyncRegularFileBytesAtRoot, observeWorkspaceSyncEntryAtRoot, readWorkspaceSyncFileAtRoot } from './workspaceSyncFileRead';
import { readWorkspaceSyncRootObjectIdentity } from './workspaceSyncRootIdentity';

describe('readWorkspaceSyncFileAtRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns one bounded text preview and verifies its digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-read-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'index.ts'), 'hello');
    const digest = createHash('sha1').update('hello').digest('hex');

    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'src/index.ts',
      expectedDigest: digest,
      maxBytes: 1024,
    })).resolves.toEqual({ status: 'text', text: 'hello', digest, size: 5 });

    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')('reads the exact POSIX filename without trimming whitespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-read-exact-'));
    await writeFile(join(root, ' note.txt'), 'same');
    await writeFile(join(root, 'note.txt'), 'same');
    await writeFile(join(root, String.raw`nested\note.txt`), 'backslash');
    const digest = createHash('sha1').update('same').digest('hex');

    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: ' note.txt',
      expectedDigest: digest,
      maxBytes: 1024,
    })).resolves.toEqual({ status: 'text', text: 'same', digest, size: 4 });

    await rm(join(root, ' note.txt'));
    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: ' note.txt',
      expectedDigest: digest,
      maxBytes: 1024,
    })).resolves.toEqual({ status: 'missing' });
    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'note.txt',
      expectedDigest: digest,
      maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'text', text: 'same' });
    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: String.raw`nested\note.txt`,
      maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'text', text: 'backslash' });

    await rm(root, { recursive: true, force: true });
  });

  it('reports changed, binary, too-large and missing without leaking a body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-read-'));
    await writeFile(join(root, 'changed.txt'), 'changed');
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, 'large.txt'), '0123456789');

    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'changed.txt',
      expectedDigest: '0'.repeat(40),
      maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'changed' });
    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'binary.dat',
      maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'binary', size: 4 });
    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'large.txt',
      maxBytes: 4,
    })).resolves.toEqual({ status: 'too_large', size: 10 });
    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'missing.txt',
      maxBytes: 1024,
    })).resolves.toEqual({ status: 'missing' });

    await rm(root, { recursive: true, force: true });
  });

  it('rejects root, traversal and symlink escape reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-read-'));
    const outside = await mkdtemp(join(tmpdir(), 'workspace-sync-read-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await symlink(outside, join(root, 'escape-parent'), 'dir');

    for (const relativePath of ['.', '../secret.txt', 'escape.txt', 'escape-parent/secret.txt']) {
      await expect(readWorkspaceSyncFileAtRoot({ rootPath: root, relativePath, maxBytes: 1024 }))
        .rejects.toMatchObject({ code: 'workspace_root_unsafe' });
    }

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')('cannot disclose outside bytes when an ancestor is swapped at the authority boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-read-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'workspace-sync-read-outside-'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'preview.txt'), 'inside');
    await writeFile(join(outside, 'preview.txt'), 'outside-secret');

    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'nested/preview.txt',
      maxBytes: 1024,
      assertCurrentAuthority: async () => {
        await rename(join(root, 'nested'), join(root, 'retained'));
        await symlink(outside, join(root, 'nested'), 'dir');
      },
    })).resolves.toMatchObject({ status: 'text', text: 'inside' });

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('rejects a final-component symlink swapped at the authority boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-read-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'workspace-sync-read-outside-'));
    await writeFile(join(root, 'preview.txt'), 'inside');
    await writeFile(join(outside, 'secret.txt'), 'outside-secret');

    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: root,
      relativePath: 'preview.txt',
      maxBytes: 1024,
      assertCurrentAuthority: async () => {
        await rm(join(root, 'preview.txt'));
        await symlink(join(outside, 'secret.txt'), join(root, 'preview.txt'));
      },
    })).rejects.toMatchObject({ code: 'workspace_root_unsafe' });

    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('delegates Windows preview to the native confined-filesystem boundary without pathname fallback', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const runNativeConfinedRead = vi.fn(async () => ({
      status: 'content' as const,
      content: Buffer.from('inside'),
      digest: createHash('sha1').update('inside').digest('hex'),
      size: 6,
    }));
    const assertCurrentAuthority = vi.fn(async () => undefined);

    await expect(readWorkspaceSyncFileAtRoot({
      rootPath: 'C:\\work',
      relativePath: 'preview.txt',
      maxBytes: 1024,
      assertCurrentAuthority,
    }, { runNativeConfinedRead })).resolves.toMatchObject({
      status: 'text',
      text: 'inside',
      size: 6,
    });

    expect(runNativeConfinedRead).toHaveBeenCalledWith({
      rootPath: 'C:\\work',
      relativePath: 'preview.txt',
      maxBytes: 1024,
      assertCurrentAuthority,
    });
  });
});

describe('observeWorkspaceSyncEntryAtRoot', () => {
  it.skipIf(process.platform !== 'linux')('does not disclose replacement-root size when custody changes at the authority boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-measure-root-race-'));
    try {
      await mkdir(join(root, 'copy'));
      await writeFile(join(root, 'copy', 'owned'), 'copy');
      const expectedRootIdentity = await readWorkspaceSyncRootObjectIdentity(join(root, 'copy'));
      await mkdir(join(root, 'replacement'));
      await writeFile(join(root, 'replacement', 'private'), Buffer.alloc(4096));
      const request = {
        rootPath: root,
        relativePath: 'copy',
        expectedRootIdentity,
        assertCurrentAuthority: async () => {
          await rename(join(root, 'copy'), join(root, 'retained'));
          await rename(join(root, 'replacement'), join(root, 'copy'));
        },
      };
      await expect(measureWorkspaceSyncRegularFileBytesAtRoot(request)).rejects.toMatchObject({ code: 'root_changed' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('does not authorize a directory containing an unrepresentable filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-observe-invalid-name-'));
    await mkdir(join(root, 'tree'));
    const invalidPath = Buffer.concat([Buffer.from(join(root, 'tree') + '/'), Buffer.from([0xff])]);
    try {
      await writeFile(invalidPath, 'unreviewed');
      await expect(observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'tree' }))
        .rejects.toMatchObject({ code: 'workspace_file_unsupported' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('does not authorize an unrepresentable symlink target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-observe-invalid-link-'));
    try {
      await symlink(Buffer.from([0xff]), join(root, 'link'));
      await expect(observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'link' }))
        .rejects.toMatchObject({ code: 'workspace_file_unsupported' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('uses canonical JSON for a valid Unicode and escaped child name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-observe-unicode-'));
    const name = 'café"\\\n.txt';
    try {
      await mkdir(join(root, 'tree'));
      await writeFile(join(root, 'tree', name), 'v');
      const child = {
        kind: 'file' as const,
        digest: createHash('sha1').update('v').digest('hex'),
        executable: false,
        size: 1,
      };
      const fingerprint = createHash('sha256').update(JSON.stringify({ v: 1, entries: [[name, child]] })).digest('hex');
      await expect(observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'tree' }))
        .resolves.toEqual({ kind: 'directory', fingerprint });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('observes full binary files independently of preview bounds and executable semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-observe-'));
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0xa5);
    const path = join(root, 'large.bin');
    await writeFile(path, bytes);
    await chmod(path, 0o755);

    await expect(observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'large.bin' })).resolves.toEqual({
      kind: 'file',
      digest: createHash('sha1').update(bytes).digest('hex'),
      executable: true,
      size: bytes.byteLength,
    });
    await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')('binds symlink targets and every directory child into the complete fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-sync-observe-tree-'));
    await mkdir(join(root, 'tree'));
    await writeFile(join(root, 'tree', 'a.txt'), 'a');
    await symlink('a.txt', join(root, 'tree', 'link'));
    const first = await observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'tree' });
    await writeFile(join(root, 'tree', 'b.txt'), 'b');
    const second = await observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'tree' });

    expect(first).toMatchObject({ kind: 'directory' });
    expect(second).toMatchObject({ kind: 'directory' });
    expect(second).not.toEqual(first);
    await expect(observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: 'tree/link' }))
      .resolves.toEqual({ kind: 'symlink', target: 'a.txt' });
    await rm(root, { recursive: true, force: true });
  });
});
