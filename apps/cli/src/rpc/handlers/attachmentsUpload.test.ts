import { describe, expect, it } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { stat } from 'fs/promises';

import { registerFileSystemHandlers } from './fileSystem';
import { registerAttachmentsUploadHandlers } from './attachmentsUpload';

type Handler = (data: unknown) => Promise<unknown> | unknown;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('attachments upload (chunked)', () => {
  it('does not create a .git directory when configuring git_info_exclude in a non-git folder', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-nogit-'));
    const readAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory, {
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
      });
      registerAttachmentsUploadHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        setAdditionalAllowedReadDirs: (dirs) => {
          readAllowedDirs.current = dirs;
        },
      });

      const configure = mgr.handlers.get('attachments.configure');
      if (!configure) throw new Error('expected attachments upload handlers to be registered');

      const configRes = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      });
      expect(configRes).toMatchObject({ success: true });

      await expect(stat(join(workingDirectory, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writes a local-only ignore rule to .git/info/exclude when requested', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-git-'));
    const readAllowedDirs: { current: string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'info', 'exclude'), '# existing\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory, {
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
      });
      registerAttachmentsUploadHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        setAdditionalAllowedReadDirs: (dirs) => {
          readAllowedDirs.current = dirs;
        },
      });

      const configure = mgr.handlers.get('attachments.configure');
      if (!configure) throw new Error('expected attachments upload handlers to be registered');

      const configRes = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      });
      expect(configRes).toMatchObject({ success: true });

      const excludeContents = await readFile(join(workingDirectory, '.git', 'info', 'exclude'), 'utf8');
      expect(excludeContents).toContain('# existing');
      expect(excludeContents).toContain('/.happier/uploads/');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writes an ignore rule to .gitignore when requested', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-gitignore-'));
    const readAllowedDirs: { current: string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(join(workingDirectory, '.gitignore'), '# existing\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory, {
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
      });
      registerAttachmentsUploadHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        setAdditionalAllowedReadDirs: (dirs) => {
          readAllowedDirs.current = dirs;
        },
      });

      const configure = mgr.handlers.get('attachments.configure');
      if (!configure) throw new Error('expected attachments upload handlers to be registered');

      const configRes = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'gitignore',
        vcsIgnoreWritesEnabled: true,
      });
      expect(configRes).toMatchObject({ success: true });

      const ignoreContents = await readFile(join(workingDirectory, '.gitignore'), 'utf8');
      expect(ignoreContents).toContain('# existing');
      expect(ignoreContents).toContain('/.happier/uploads/');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('uploads a file to the configured workspace dir and returns a readable path', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-work-'));
    const readAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workingDirectory, {
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
      });
      registerAttachmentsUploadHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        setAdditionalAllowedReadDirs: (dirs) => {
          readAllowedDirs.current = dirs;
        },
      });

      const configure = mgr.handlers.get('attachments.configure');
      const init = mgr.handlers.get('attachments.upload.init');
      const chunk = mgr.handlers.get('attachments.upload.chunk');
      const finalize = mgr.handlers.get('attachments.upload.finalize');
      if (!configure || !init || !chunk || !finalize) {
        throw new Error('expected attachments upload handlers to be registered');
      }

      const configRes = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
        maxFileBytes: 5_000_000,
      });
      expect(configRes).toMatchObject({ success: true });

      const bytes = new TextEncoder().encode('hello world');
      const initRes: any = await init({
        name: 'hello.txt',
        sizeBytes: bytes.byteLength,
        mimeType: 'text/plain',
      });
      expect(initRes.success).toBe(true);
      expect(typeof initRes.uploadId).toBe('string');
      expect(typeof initRes.chunkSizeBytes).toBe('number');

      const uploadId = initRes.uploadId as string;
      const chunkB64 = Buffer.from(bytes).toString('base64');
      const chunkRes = await chunk({ uploadId, index: 0, contentBase64: chunkB64 });
      expect(chunkRes).toMatchObject({ success: true });

      const finRes: any = await finalize({ uploadId });
      expect(finRes.success).toBe(true);
      expect(typeof finRes.path).toBe('string');

      const absolutePath = resolve(workingDirectory, finRes.path);
      const fileBytes = await readFile(absolutePath);
      expect(fileBytes.toString('utf8')).toBe('hello world');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });
});
