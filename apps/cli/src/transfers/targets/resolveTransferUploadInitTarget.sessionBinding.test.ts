import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveTransferUploadInitTarget } from './resolveTransferUploadInitTarget';

describe('attachment upload Session binding', () => {
  it.each(['workspace', 'os_temp'] as const)('keeps an attachment folder tree within the %s attachment destination', async (uploadLocation) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-folder-attachment-'));
    directories.push(root);
    const base = { workingDirectory: root, tempUploadRoot: join(root, 'temp'),
      attachmentUpload: { resolveSessionWorkingDirectory: async () => root } };
    const request = { t: 'session_attachment_upload_v1' as const, sessionId: 'hosted',
      messageLocalId: 'm1', fileName: 'a.txt', sizeBytes: 1,
      uploadLocation, workspaceRelativeDir: '.uploads',
      vcsIgnoreStrategy: 'none' as const, vcsIgnoreWritesEnabled: false,
      relativePath: 'draft-folder/project/nested/a.txt' };
    const result = await resolveTransferUploadInitTarget({ ...base, request });
    const destination = uploadLocation === 'workspace' ? join(root, '.uploads') : join(root, 'temp');
    expect(result).toMatchObject({ success: true, target: { destPath: join(destination, 'messages/hosted/m1/draft-folder/project/nested/a.txt') } });
    for (const relativePath of ['../escape.txt', '/absolute.txt', 'C:\\escape.txt', 'folder/../../escape']) {
      expect(await resolveTransferUploadInitTarget({ ...base, request: { ...request, relativePath } })).toMatchObject({ success: false });
      expect(await resolveTransferUploadInitTarget({ ...base, request: { ...request,
        relativePath: 'draft-folder/project', directoryEntries: [relativePath], sizeBytes: 0 } })).toMatchObject({ success: false });
    }
  });
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('refuses a foreign Session and a caller-selected root outside the hosted Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-attachment-'));
    directories.push(root);
    const base = {
      workingDirectory: root,
      tempUploadRoot: join(root, 'temp'),
      attachmentUpload: { resolveSessionWorkingDirectory: async (sessionId: string) => sessionId === 'hosted' ? join(root, 'hosted') : null },
    };
    const request = {
      t: 'session_attachment_upload_v1' as const,
      sessionId: 'foreign', messageLocalId: 'input', fileName: 'hello.txt', sizeBytes: 1,
      uploadLocation: 'workspace' as const, workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'none' as const, vcsIgnoreWritesEnabled: false,
    };
    expect(await resolveTransferUploadInitTarget({ ...base, request } as unknown as Parameters<typeof resolveTransferUploadInitTarget>[0]))
      .toMatchObject({ success: false });
    expect(await resolveTransferUploadInitTarget({ ...base, request: { ...request, sessionId: 'hosted', workspaceRootPath: root } } as unknown as Parameters<typeof resolveTransferUploadInitTarget>[0]))
      .toMatchObject({ success: false });
    const admitted = await resolveTransferUploadInitTarget({ ...base, request: { ...request, sessionId: 'hosted' } } as unknown as Parameters<typeof resolveTransferUploadInitTarget>[0]);
    expect(admitted).toMatchObject({ success: true });
    if (admitted.success) {
      expect(admitted.target).toMatchObject({ destPath: expect.stringContaining(join(root, 'hosted')) });
    }
  });
});
