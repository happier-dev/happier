import { describe, expect, it } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { stat } from 'fs/promises';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { registerWorkspaceFileTransferRpcHandlers } from '@/transfers/rpc/registerWorkspaceFileTransferRpcHandlers';

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
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerWorkspaceFileTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const configure = mgr.handlers.get(RPC_METHODS.ATTACHMENTS_CONFIGURE);
      if (!configure) throw new Error('expected attachments upload handlers to be registered');

      const configRes = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
      });
      expect(configRes).toMatchObject({
        success: true,
        uploadBasePath: '.happier/uploads/messages',
      });

      await expect(stat(join(workingDirectory, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writes a local-only ignore rule to .git/info/exclude when requested', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-git-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'info', 'exclude'), '# existing\n', 'utf8');

      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerWorkspaceFileTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const configure = mgr.handlers.get(RPC_METHODS.ATTACHMENTS_CONFIGURE);
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
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      await mkdir(join(workingDirectory, '.git'), { recursive: true });
      await writeFile(join(workingDirectory, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await writeFile(join(workingDirectory, '.gitignore'), '# existing\n', 'utf8');

      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerWorkspaceFileTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const configure = mgr.handlers.get(RPC_METHODS.ATTACHMENTS_CONFIGURE);
      if (!configure) throw new Error('expected attachments upload handlers to be registered');

      const configRes = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'gitignore',
        vcsIgnoreWritesEnabled: true,
      });
      expect(configRes).toMatchObject({
        success: true,
        uploadBasePath: '.happier/uploads/messages',
      });

      const ignoreContents = await readFile(join(workingDirectory, '.gitignore'), 'utf8');
      expect(ignoreContents).toContain('# existing');
      expect(ignoreContents).toContain('/.happier/uploads/');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('registers attachment policy plus generic files.upload handlers', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-files-upload-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerWorkspaceFileTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      expect(mgr.handlers.has(RPC_METHODS.ATTACHMENTS_CONFIGURE)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.FILES_UPLOAD_INIT)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.FILES_UPLOAD_CHUNK)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.FILES_UPLOAD_FINALIZE)).toBe(true);
      expect(mgr.handlers.has(RPC_METHODS.FILES_UPLOAD_ABORT)).toBe(true);

      const configure = mgr.handlers.get(RPC_METHODS.ATTACHMENTS_CONFIGURE);
      const init = mgr.handlers.get(RPC_METHODS.FILES_UPLOAD_INIT);
      const chunk = mgr.handlers.get(RPC_METHODS.FILES_UPLOAD_CHUNK);
      const finalize = mgr.handlers.get(RPC_METHODS.FILES_UPLOAD_FINALIZE);
      if (!configure || !init || !chunk || !finalize) {
        throw new Error('expected attachment policy and files upload handlers to be registered');
      }

      const configured: any = await configure({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      });
      expect(configured).toMatchObject({
        success: true,
        uploadBasePath: '.happier/uploads/messages',
      });

      const initResult: any = await init({
        path: `${configured.uploadBasePath}/message-1/hello.txt`,
        sizeBytes: 11,
        overwrite: false,
      });
      expect(initResult).toMatchObject({ success: true });

      expect(await chunk({
        uploadId: initResult.uploadId,
        index: 0,
        contentBase64: Buffer.from('hello world', 'utf8').toString('base64'),
      })).toEqual({ success: true });

      const finalizeResult: any = await finalize({ uploadId: initResult.uploadId });
      expect(finalizeResult).toMatchObject({
        success: true,
        path: `${configured.uploadBasePath}/message-1/hello.txt`,
        sizeBytes: 11,
      });
      await expect(readFile(resolve(workingDirectory, finalizeResult.path), 'utf8')).resolves.toBe('hello world');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns an os_temp upload base path that works with generic files.upload and files.download', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attach-os-temp-'));
    const readAllowedDirs: { current: string[] } = { current: [] };
    const writeAllowedDirs: { current: string[] } = { current: [] };

    try {
      const mgr = createRpcHandlerManager();
      const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
        onReadDirsChange: (dirs) => {
          readAllowedDirs.current = [...dirs];
        },
        onWriteDirsChange: (dirs) => {
          writeAllowedDirs.current = [...dirs];
        },
      });
      registerWorkspaceFileTransferRpcHandlers(mgr as unknown as RpcHandlerManager, {
        workingDirectory,
        getAdditionalAllowedReadDirs: () => readAllowedDirs.current,
        getAdditionalAllowedWriteDirs: () => writeAllowedDirs.current,
        attachmentUpload: {
          pathAllowanceRegistry,
        },
      });

      const configure = mgr.handlers.get(RPC_METHODS.ATTACHMENTS_CONFIGURE);
      const init = mgr.handlers.get(RPC_METHODS.FILES_UPLOAD_INIT);
      const chunk = mgr.handlers.get(RPC_METHODS.FILES_UPLOAD_CHUNK);
      const finalize = mgr.handlers.get(RPC_METHODS.FILES_UPLOAD_FINALIZE);
      const downloadInit = mgr.handlers.get(RPC_METHODS.FILES_DOWNLOAD_INIT);
      const downloadChunk = mgr.handlers.get(RPC_METHODS.FILES_DOWNLOAD_CHUNK);
      const downloadFinalize = mgr.handlers.get(RPC_METHODS.FILES_DOWNLOAD_FINALIZE);
      if (!configure || !init || !chunk || !finalize || !downloadInit || !downloadChunk || !downloadFinalize) {
        throw new Error('expected attachment policy plus generic files upload/download handlers to be registered');
      }

      const configured: any = await configure({ uploadLocation: 'os_temp' });
      expect(configured).toMatchObject({
        success: true,
        uploadLocation: 'os_temp',
      });
      expect(typeof configured.uploadBasePath).toBe('string');
      expect(configured.uploadBasePath).toMatch(/^\/.+/);

      const targetPath = `${configured.uploadBasePath}/message-2/note.txt`;
      const initResult: any = await init({
        path: targetPath,
        sizeBytes: 3,
        overwrite: false,
      });
      expect(initResult).toMatchObject({ success: true });

      expect(await chunk({
        uploadId: initResult.uploadId,
        index: 0,
        contentBase64: Buffer.from('hey', 'utf8').toString('base64'),
      })).toEqual({ success: true });

      const finalizeResult: any = await finalize({ uploadId: initResult.uploadId });
      expect(finalizeResult).toMatchObject({
        success: true,
        path: targetPath,
        sizeBytes: 3,
      });

      const downloadInitResult: any = await downloadInit({ path: finalizeResult.path });
      expect(downloadInitResult).toMatchObject({ success: true });

      const downloadChunkResult: any = await downloadChunk({
        downloadId: downloadInitResult.downloadId,
        index: 0,
      });
      expect(downloadChunkResult).toMatchObject({ success: true, isLast: true });
      expect(Buffer.from(String(downloadChunkResult.contentBase64 ?? ''), 'base64').toString('utf8')).toBe('hey');
      await expect(downloadFinalize({ downloadId: downloadInitResult.downloadId })).resolves.toEqual({ success: true });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });
});
