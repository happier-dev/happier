import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';
import { executeFilesystemEffectOperation } from './filesystemEffectOperation';

describe('admitted native filesystem operation', () => {
  it('keeps browser roots, directory and filename reads at existing restricted-root effect owners', async () => {
    await withTempDir('happier-native-browser-reads-', async root => {
      const member = join(root, 'member');
      const neighbor = join(root, 'neighbor');
      await mkdir(member);
      await mkdir(neighbor);
      await writeFile(join(member, 'target.txt'), 'owned');
      await writeFile(join(neighbor, 'private.txt'), 'private');
      const invoke = (actionId: string, input: unknown) => executeFilesystemEffectOperation({
        actionId, input, workingDirectory: member, accessPolicy: { kind: 'restrictedRoots', roots: [member] },
      });
      await expect(invoke('daemon.filesystem.listRoots', {}))
        .resolves.toMatchObject({ ok: true, roots: [{ path: member }] });
      await expect(invoke('daemon.filesystem.browseDirectory', { path: member, includeFiles: true }))
        .resolves.toMatchObject({ ok: true, entries: [expect.objectContaining({ name: 'target.txt' })] });
      await expect(invoke('daemon.filesystem.listFiles', { rootPath: member, query: 'target' }))
        .resolves.toMatchObject({ ok: true, paths: ['target.txt'], truncated: false });
      await expect(invoke('daemon.filesystem.browseDirectory', { path: neighbor }))
        .resolves.toMatchObject({ ok: false, errorCode: 'invalid_path' });
      await expect(invoke('daemon.filesystem.listFiles', { rootPath: neighbor }))
        .resolves.toMatchObject({ ok: false, errorCode: 'path_not_allowed' });
    });
  });

  it('keeps useful member read/write/list/copy at the incumbent effect owners and denies a neighboring private root', async () => {
    await withTempDir('happier-native-filesystem-', async root => {
      const member = join(root, 'member-a');
      const neighbor = join(root, 'member-b');
      await mkdir(member);
      await mkdir(neighbor);
      await writeFile(join(member, 'owned.txt'), 'member fixture');
      await writeFile(join(neighbor, 'private.txt'), 'neighbor fixture', { mode: 0o600 });
      const invoke = (actionId: string, input: unknown) => executeFilesystemEffectOperation({
        actionId, input, workingDirectory: member, accessPolicy: { kind: 'restrictedRoots', roots: [member] },
      });
      await expect(invoke('daemon.filesystem.readFile', { rootPath: member, path: 'owned.txt' }))
        .resolves.toMatchObject({ success: true, content: Buffer.from('member fixture').toString('base64') });
      await expect(invoke('daemon.filesystem.writeFile', { rootPath: member, path: 'owned.txt', content: Buffer.from('edited fixture').toString('base64') }))
        .resolves.toMatchObject({ success: true });
      expect(await readFile(join(member, 'owned.txt'), 'utf8')).toBe('edited fixture');
      await expect(invoke('daemon.filesystem.listDirectory', { rootPath: member, path: '.' }))
        .resolves.toMatchObject({ success: true, entries: [expect.objectContaining({ name: 'owned.txt' })] });
      await expect(invoke('daemon.filesystem.copy', { rootPath: member, from: 'owned.txt', to: 'copy.txt', overwrite: false, recursive: false }))
        .resolves.toMatchObject({ success: true });
      expect(await readFile(join(member, 'copy.txt'), 'utf8')).toBe('edited fixture');
      for (const input of [{ rootPath: neighbor, path: 'private.txt' }, { path: join(neighbor, 'private.txt') }]) {
        await expect(invoke('daemon.filesystem.readFile', input))
          .resolves.toMatchObject({ success: false, errorCode: 'access_denied' });
      }
      await expect(invoke('daemon.filesystem.writeFile', { rootPath: neighbor, path: 'private.txt', content: Buffer.from('denied').toString('base64') }))
        .resolves.toMatchObject({ success: false, errorCode: 'access_denied' });
      expect(await readFile(join(neighbor, 'private.txt'), 'utf8')).toBe('neighbor fixture');
    });
  });

  it('retains authorized owner OS access while explicit member roots cannot disclose through a symlink', async () => {
    await withTempDir('happier-native-filesystem-owner-', async root => {
      const member = join(root, 'member');
      const privatePath = join(root, 'owner-private.txt');
      await mkdir(member);
      await writeFile(privatePath, 'owner fixture', { mode: 0o600 });
      await symlink(privatePath, join(member, 'link.txt'));
      await expect(executeFilesystemEffectOperation({ actionId: 'daemon.filesystem.readFile',
        input: { rootPath: root, path: privatePath }, workingDirectory: root, accessPolicy: { kind: 'osUser' },
      })).resolves.toMatchObject({ success: true, content: Buffer.from('owner fixture').toString('base64') });
      await expect(executeFilesystemEffectOperation({ actionId: 'daemon.filesystem.readFile',
        input: { rootPath: member, path: 'link.txt' }, workingDirectory: member, accessPolicy: { kind: 'restrictedRoots', roots: [member] },
      })).resolves.toMatchObject({ success: false, errorCode: 'access_denied' });
    });
  });

  it('settles cancellation before native IO without making another Home admission', async () => {
    await withTempDir('happier-native-filesystem-cancel-', async root => {
      const controller = new AbortController();
      controller.abort();
      await expect(executeFilesystemEffectOperation({ actionId: 'daemon.filesystem.writeFile',
        input: { rootPath: root, path: 'never.txt', content: '' }, workingDirectory: root, accessPolicy: { kind: 'osUser' },
      }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      await expect(readFile(join(root, 'never.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
