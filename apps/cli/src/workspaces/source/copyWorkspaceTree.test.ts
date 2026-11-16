import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { copyWorkspaceTree } from './copyWorkspaceTree';
import { localWorkspaceSource } from './localWorkspaceSource';

const created: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copy-workspace-tree-'));
  created.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// A target source over real paths: like the holder, readlink returns an outside target verbatim.
const target = {
  ...localWorkspaceSource,
  kind: 'target' as const,
  id: 'target:copy-tree',
};

describe('copyWorkspaceTree across sources', () => {
  it('never stages a link that resolves outside the copied tree on this Machine', async () => {
    const [workspace, hostSecrets, staging] = [
      await tempDir(),
      await tempDir(),
      await tempDir(),
    ];
    await writeFile(join(hostSecrets, 'host-secret.txt'), 'HOST-SECRET');
    await mkdir(join(workspace, 'project'));
    await writeFile(join(workspace, 'project', 'kept.txt'), 'kept');
    await symlink('kept.txt', join(workspace, 'project', 'inner'));
    await symlink(hostSecrets, join(workspace, 'project', 'leak'));
    await symlink('../../outside', join(workspace, 'project', 'up'));
    await symlink(hostSecrets, join(workspace, 'leak'));

    await copyWorkspaceTree({
      from: { source: target, path: join(workspace, 'project') },
      to: { source: localWorkspaceSource, path: join(staging, 'project') },
    });
    await copyWorkspaceTree({
      from: { source: target, path: join(workspace, 'leak') },
      to: { source: localWorkspaceSource, path: join(staging, 'leak') },
    });

    expect((await readdir(staging)).sort()).toEqual(['project']);
    expect((await readdir(join(staging, 'project'))).sort()).toEqual([
      'inner',
      'kept.txt',
    ]);
    await expect(readlink(join(staging, 'project', 'inner'))).resolves.toBe(
      'kept.txt',
    );
  });

  it('keeps links verbatim inside one source', async () => {
    const [workspace, hostSecrets] = [await tempDir(), await tempDir()];
    await symlink(hostSecrets, join(workspace, 'leak'));
    await copyWorkspaceTree({
      from: { source: target, path: join(workspace, 'leak') },
      to: { source: target, path: join(workspace, 'copy') },
    });
    await expect(readlink(join(workspace, 'copy'))).resolves.toBe(hostSecrets);
  });
});
