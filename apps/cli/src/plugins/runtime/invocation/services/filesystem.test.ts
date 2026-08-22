import { mkdtemp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createPluginFileSystemService,
  isCanonicalPathAuthorizedByPluginFileSystemScopes,
} from './filesystem';

describe('plugin invocation filesystem service', () => {
  it('is the sole plugin filesystem service owner', async () => {
    const predecessorExists = await stat(
      new URL('../../context/fs.ts', import.meta.url),
    ).then(() => true, () => false);
    expect(predecessorExists).toBe(false);
  });

  it('authorizes canonical media roots only inside a readable exact scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-media-scope-'));
    const workspace = join(root, 'workspace');
    const projectA = join(root, 'project-a');
    const projectB = join(root, 'project-a-sibling');
    const outside = join(root, 'outside');
    await Promise.all([
      mkdir(join(workspace, 'allowed'), { recursive: true }),
      mkdir(join(workspace, 'allowed-sibling'), { recursive: true }),
      mkdir(projectA, { recursive: true }),
      mkdir(projectB, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await symlink(outside, join(workspace, 'allowed', 'escape'));
    const roots = {
      pluginData: join(root, 'plugin-data'),
      workspace,
      projects: new Map([['a', projectA], ['b', projectB]]),
    };

    await expect(isCanonicalPathAuthorizedByPluginFileSystemScopes({
      roots,
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read'] }],
      canonicalPath: await realpath(join(workspace, 'allowed')),
      access: 'read',
    })).resolves.toBe(true);
    await expect(isCanonicalPathAuthorizedByPluginFileSystemScopes({
      roots,
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read'] }],
      canonicalPath: await realpath(join(workspace, 'allowed-sibling')),
      access: 'read',
    })).resolves.toBe(false);
    await expect(isCanonicalPathAuthorizedByPluginFileSystemScopes({
      roots,
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['write'] }],
      canonicalPath: await realpath(join(workspace, 'allowed')),
      access: 'read',
    })).resolves.toBe(false);
    await expect(isCanonicalPathAuthorizedByPluginFileSystemScopes({
      roots,
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read'] }],
      canonicalPath: await realpath(join(workspace, 'allowed', 'escape')),
      access: 'read',
    })).resolves.toBe(false);
    await expect(isCanonicalPathAuthorizedByPluginFileSystemScopes({
      roots,
      scopes: [{ root: 'project', projectId: 'a', access: ['read'] }],
      canonicalPath: await realpath(projectB),
      access: 'read',
    })).resolves.toBe(false);
  });

  it('round-trips binary bytes atomically inside an exact authorized scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-'));
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read', 'write', 'delete'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });
    const bytes = new Uint8Array([0, 255, 1, 2]);
    await service.writeFile({ root: 'workspace', relativePath: 'allowed/data.bin' }, bytes);
    await expect(service.readFile({ root: 'workspace', relativePath: 'allowed/data.bin' })).resolves.toEqual(bytes);
    expect(new Uint8Array(await readFile(join(root, 'allowed/data.bin')))).toEqual(bytes);
  });

  it('diagnoses a disclosure mismatch while preserving traversal, symlink, size, and generation fences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'happier-svc07-outside-'));
    await mkdir(join(root, 'allowed'), { recursive: true });
    await symlink(outside, join(root, 'allowed', 'link'));
    let current = true;
    const disclosureMismatches: unknown[] = [];
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read', 'write'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => current,
      recordDisclosureMismatch: (mismatch) => {
        disclosureMismatches.push(mismatch);
        throw new Error('diagnostic sink failed');
      },
    });
    await expect(service.readFile({ root: 'workspace', relativePath: '../outside' })).rejects.toMatchObject({ code: 'plugin_fs_path_denied' });
    await expect(service.writeFile({ root: 'workspace', relativePath: 'other/a' }, new Uint8Array([1]))).resolves.toBeUndefined();
    expect(disclosureMismatches).toEqual([{
      root: 'workspace',
      relativePath: 'other/a',
      access: 'write',
    }]);
    await expect(service.writeFile({ root: 'workspace', relativePath: 'allowed/link/a' }, new Uint8Array([1]))).rejects.toMatchObject({ code: 'plugin_fs_path_denied' });
    await service.writeFile({ root: 'workspace', relativePath: 'allowed/large' }, new Uint8Array([1, 2]));
    await expect(service.readFile({ root: 'workspace', relativePath: 'allowed/large' }, { maxBytes: 1 })).rejects.toMatchObject({ code: 'plugin_fs_too_large' });
    current = false;
    await expect(service.stat({ root: 'workspace', relativePath: 'allowed/large' })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
  });

  it('does not create directories through a symlink before rejecting the escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'happier-svc07-outside-'));
    await mkdir(join(root, 'allowed'), { recursive: true });
    await symlink(outside, join(root, 'allowed', 'link'));
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['write'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    await expect(service.writeFile(
      { root: 'workspace', relativePath: 'allowed/link/escaped/side-effect.bin' },
      new Uint8Array([1]),
    )).rejects.toMatchObject({ code: 'plugin_fs_path_denied' });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('rejects Windows device names, case-fold collisions, and invalid read limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-portable-'));
    await mkdir(join(root, 'allowed'), { recursive: true });
    await writeFile(join(root, 'allowed', 'Case.txt'), 'safe');
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read', 'write'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    await expect(service.writeFile(
      { root: 'workspace', relativePath: 'allowed/CON.txt' },
      new Uint8Array([1]),
    )).rejects.toMatchObject({ code: 'plugin_fs_path_denied' });
    await expect(service.writeFile(
      { root: 'workspace', relativePath: 'allowed/case.txt' },
      new Uint8Array([1]),
    )).rejects.toMatchObject({ code: 'plugin_fs_case_collision' });
    await expect(service.readFile(
      { root: 'workspace', relativePath: 'allowed/Case.txt' },
      { maxBytes: Number.NaN },
    )).rejects.toMatchObject({ code: 'plugin_fs_invalid_limit' });
  });

  it('treats NFC and NFD spellings as the same portable path without weakening case checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-unicode-'));
    await mkdir(join(root, 'allowed'), { recursive: true });
    const nfcName = 'caf\u00e9.txt';
    const nfdName = nfcName.normalize('NFD');
    await writeFile(join(root, 'allowed', nfcName), 'normalized');
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', pathPrefix: 'allowed', access: ['read'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    await expect(service.readFile({
      root: 'workspace',
      relativePath: `allowed/${nfdName}`,
    })).resolves.toEqual(new TextEncoder().encode('normalized'));
  });

  it('lists an authorized root with a bounded scope-bound opaque cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-list-'));
    await mkdir(join(root, 'first'), { recursive: true });
    await writeFile(join(root, 'second.txt'), 'two');
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', access: ['read'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    const firstPage = await service.list({ root: 'workspace', relativePath: '' }, { limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toMatch(/^v1\./);
    expect(firstPage.nextCursor).not.toBe('1');
    const secondPage = await service.list(
      { root: 'workspace', relativePath: '' },
      { limit: 1, cursor: firstPage.nextCursor },
    );
    expect(secondPage.items).toHaveLength(1);
    await expect(service.list(
      { root: 'workspace', relativePath: 'first' },
      { cursor: firstPage.nextCursor },
    )).rejects.toMatchObject({ code: 'plugin_fs_invalid_cursor' });
  });

  it('fails closed on non-portable directory entries and unavailable host roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-collision-'));
    await writeFile(join(root, 'CON.txt'), 'device-name');
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', access: ['read'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });
    await expect(service.list({ root: 'workspace', relativePath: '' }))
      .rejects.toMatchObject({ code: 'plugin_fs_path_denied' });

    const unavailable = createPluginFileSystemService({
      roots: { pluginData: join(root, 'missing-root'), workspace: join(root, 'missing-root'), projects: new Map() },
      scopes: [{ root: 'workspace', access: ['read'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });
    await expect(unavailable.list({ root: 'workspace', relativePath: '' }))
      .rejects.toMatchObject({ code: 'plugin_fs_root_unavailable' });
  });

  it('uses stable kind and recursive-removal errors instead of leaking Node error shapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-errors-'));
    await mkdir(join(root, 'directory'), { recursive: true });
    await writeFile(join(root, 'directory', 'child.txt'), 'child');
    await writeFile(join(root, 'file.txt'), 'file');
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', access: ['read', 'write', 'delete'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    await expect(service.list({ root: 'workspace', relativePath: 'file.txt' }))
      .rejects.toMatchObject({ code: 'plugin_fs_unsupported_kind' });
    await expect(service.writeFile(
      { root: 'workspace', relativePath: 'directory' },
      new Uint8Array([1]),
    )).rejects.toMatchObject({ code: 'plugin_fs_unsupported_kind' });
    await expect(service.remove({ root: 'workspace', relativePath: 'directory' }))
      .rejects.toMatchObject({ code: 'plugin_fs_recursive_required' });
  });

  it('enforces portable path, project, cancellation, write, and pagination boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-boundaries-'));
    const project = await mkdtemp(join(tmpdir(), 'happier-svc07-project-'));
    const abort = new AbortController();
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map([['project-a', project]]) },
      scopes: [
        { root: 'workspace', access: ['read', 'write'] },
        { root: 'project', projectId: 'project-a', access: ['read', 'write'] },
      ],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    for (const relativePath of ['/absolute', '\\server\\share', 'C:\\device', 'safe//empty']) {
      await expect(service.stat({ root: 'workspace', relativePath }))
        .rejects.toMatchObject({ code: 'plugin_fs_path_denied' });
    }
    await expect(service.writeFile(
      { root: 'project', projectId: 'project-b', relativePath: 'denied.bin' },
      new Uint8Array([1]),
    )).rejects.toMatchObject({ code: 'plugin_fs_root_unavailable' });
    await expect(service.writeFile(
      { root: 'workspace', relativePath: 'oversized.bin' },
      new Uint8Array((16 * 1024 * 1024) + 1),
    )).rejects.toMatchObject({ code: 'plugin_fs_too_large' });

    abort.abort();
    await expect(service.stat(
      { root: 'workspace', relativePath: 'missing' },
      { signal: abort.signal },
    )).rejects.toMatchObject({ code: 'plugin_fs_aborted' });

    for (let index = 0; index < 101; index += 1) {
      await writeFile(join(root, `item-${String(index).padStart(3, '0')}.txt`), 'x');
    }
    const page = await service.list({ root: 'workspace', relativePath: '' }, { limit: 101 });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toMatch(/^v1\./);
  });

  it('rechecks cancellation before destructive removal and preserves the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-svc07-remove-abort-'));
    await mkdir(join(root, 'kept'), { recursive: true });
    await writeFile(join(root, 'kept', 'child.txt'), 'child');
    const abort = new AbortController();
    const service = createPluginFileSystemService({
      roots: { pluginData: root, workspace: root, projects: new Map() },
      scopes: [{ root: 'workspace', access: ['read', 'delete'] }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
    });

    const removal = service.remove(
      { root: 'workspace', relativePath: 'kept' },
      { recursive: true, signal: abort.signal },
    );
    queueMicrotask(() => abort.abort());

    await expect(removal).rejects.toMatchObject({ code: 'plugin_fs_aborted' });
    await expect(service.stat({ root: 'workspace', relativePath: 'kept' }))
      .resolves.toMatchObject({ kind: 'directory' });
  });
});
