import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';

import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

import { validatePath } from '../pathSecurity';
import { authorizeFilesystemPathWithinRoot, resolveNativeFilesystemPathForAuthorization } from './accessPolicy/filesystemPathAuthorization';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { DEFAULT_JSONL_FOLLOW_POLICY } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { assertFilesystemEffectCurrent, createFilesystemEffectRpcRegistrar, type FilesystemEffectAdmission } from './accessPolicy/filesystemEffectAdmission';
import {
  authorizeExactAllowedReadFile,
  type ExactAllowedReadFile,
} from './accessPolicy/exactAllowedReadFile';
import { registerRootedFilesystemRpcHandlers } from './registerRootedFilesystemRpcHandlers';
import type { RpcActionExecutor, RpcActionExecutorContext } from '../_actionDispatchAdapter';
import type { ActionId } from '@happier-dev/protocol';
import { FilesystemReadFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { currentWorkspaceSource, type WorkspaceReadHandle } from '@/workspaces/source/workspaceSource';

async function readFileRange(
  file: Pick<WorkspaceReadHandle, 'read'>,
  offset: number,
  length: number,
  beforeRead: () => void | Promise<void>,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    await beforeRead();
    const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
    if (chunk.bytesRead === 0) break;
    bytesRead += chunk.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

// Darwin's <sys/fcntl.h> flag rejects symlinks in every component at open time.
// Node does not expose it in fs.constants.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/** One native member file. With no baseline, sample the end of the last existing row. */
export async function readNativeMemberTranscript(
  target: Readonly<{ home: string; path: string }>,
  range: Readonly<{ path: string; offset: number; fileIdentity: string | null }> | undefined,
  signal?: AbortSignal,
) {
  const refuse = () => Object.assign(new Error('Member transcript access denied'), { code: 'access_denied' });
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin') throw refuse();
  const home = await realpath(target.home);
  const path = resolveNativeFilesystemPathForAuthorization(target.path);
  if (path === home || !isCanonicalAbsolutePathInsideRoot(home, path) || (range && range.path !== path)) throw refuse();
  const noFollow = platform === 'darwin' ? DARWIN_O_NOFOLLOW_ANY : constants.O_NOFOLLOW;
  const file = await open(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw refuse();
  });
  if (!file) return { path, fileIdentity: null, sizeBytes: 0, contentBase64: '' };
  try {
    // Linux checks the opened descriptor for parent redirects. On Darwin the
    // kernel already refused redirects in any component of the canonical path.
    if (platform === 'linux' && await realpath(`/proc/self/fd/${file.fd}`).catch(() => null) !== path) throw refuse();
    const stats = await file.stat();
    if (!stats.isFile()) throw refuse();
    const fileIdentity = `${stats.dev}:${stats.ino}`;
    if (range?.fileIdentity && range.fileIdentity !== fileIdentity) {
      return { path, fileIdentity, sizeBytes: stats.size, contentBase64: '' };
    }
    const start = range?.offset ?? Math.max(0, stats.size - 1);
    const length = Math.min(range ? DEFAULT_JSONL_FOLLOW_POLICY.maxDrainBytesPerTick : 1,
      Math.max(0, stats.size - start));
    const content = await readFileRange(file, start, length, () => signal?.throwIfAborted());
    if (content.length !== length) throw refuse();
    return { path, fileIdentity, sizeBytes: stats.size, contentBase64: content.toString('base64') };
  } finally {
    await file.close();
  }
}

type ReadFileRequest = Readonly<{ rootPath?: string; path: string; offset?: number; length?: number }>;

type ReadFileResponse =
  | Readonly<{ success: true; content: string; sizeBytes?: number; eof?: boolean }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

type ReadFileHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
  effectAdmission?: FilesystemEffectAdmission;
}>;

async function readFileForRpc(data: ReadFileRequest | undefined, deps: ReadFileHandlerDeps, context?: RpcActionExecutorContext): Promise<ReadFileResponse> {
  // Rootless predecessor reads retain their policy and exact-file grants below;
  // the same current schema owns byte-range admission for both RPC carriers.
  const parsed = FilesystemReadFileInputSchema.safeParse({ ...data,
    rootPath: data?.rootPath === undefined ? deps.workingDirectory : data.rootPath });
  if (!parsed.success) {
    return { success: false, errorCode: 'invalid_request', error: 'Invalid file read request' };
  }
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('Read file request:', path);
  const validation = data?.rootPath === undefined
    ? validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy)
    : authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: data.rootPath,
      defaultDirectory: deps.workingDirectory, accessPolicy: deps.accessPolicy,
      additionalAllowedDirs: deps.getAdditionalAllowedReadDirs() });
  let resolvedPath: string;
  if (validation.valid) {
    resolvedPath = validation.resolvedPath;
  } else {
    if (data?.rootPath !== undefined) return { success: false, error: validation.error, errorCode: validation.errorCode };
    const exactFileValidation = authorizeExactAllowedReadFile({
      targetPath: path,
      workingDirectory: deps.workingDirectory,
      allowedFiles: deps.getAdditionalAllowedReadFiles?.(),
    });
    if (!exactFileValidation.valid) {
      return { success: false, error: exactFileValidation.error, errorCode: exactFileValidation.errorCode };
    }
    resolvedPath = exactFileValidation.resolvedPath;
  }

  const source = currentWorkspaceSource();
  try {
    await assertFilesystemEffectCurrent(context);
    const stats = await source.stat(resolvedPath);
    if (stats.isDirectory()) {
      return { success: false, error: 'Path is a directory' };
    }
    const length = parsed.data.length;
    if (length !== undefined) {
      if (length > configuration.filesReadMaxBytes) {
        return { success: false, error: 'Requested range is too large to read' };
      }
      await assertFilesystemEffectCurrent(context);
      const file = await source.open(resolvedPath);
      try {
        const sizeBytes = (await file.stat()).size;
        const offset = parsed.data.offset ?? 0;
        const requestedBytes = Math.min(length, Math.max(0, sizeBytes - offset));
        const buffer = await readFileRange(file, offset, requestedBytes, () => assertFilesystemEffectCurrent(context));
        if ((await file.stat()).size !== sizeBytes || buffer.length !== requestedBytes) {
          return { success: false, error: 'File changed during download. Try again' };
        }
        await assertFilesystemEffectCurrent(context);
        return { success: true, content: buffer.toString('base64'), sizeBytes, eof: offset + buffer.length >= sizeBytes };
      } finally {
        await file.close();
      }
    }
    if (stats.size > configuration.filesReadMaxBytes) {
      return { success: false, error: 'File is too large to read' };
    }

    await assertFilesystemEffectCurrent(context);
    const buffer = await source.readFile(resolvedPath);
    await assertFilesystemEffectCurrent(context);
    return { success: true, content: buffer.toString('base64') };
  } catch (error) {
    logger.debug('Failed to read file:', error);
    const errorCode = readRpcErrorCode(error) ?? (error instanceof Error && 'code' in error
      && error.code === 'filesystem_identity_custody_unavailable' ? error.code : undefined);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read file',
      ...(errorCode ? { errorCode } : {}) };
  }
}

export function createReadFileRpcActionExecutor(deps: ReadFileHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown, context) {
      if (actionId !== 'daemon.filesystem.readFile') {
        return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
      }
      return {
        ok: true,
        result: await readFileForRpc(input as ReadFileRequest | undefined, deps, context),
      };
    },
  };
}

export function registerReadFileHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
    getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
    effectAdmission?: FilesystemEffectAdmission;
    actionExecutor?: RpcActionExecutor;
  }>,
): void {
  registerRootedFilesystemRpcHandlers({
    rpcHandlerManager: deps.effectAdmission
      ? createFilesystemEffectRpcRegistrar(rpcHandlerManager, deps.effectAdmission)
      : rpcHandlerManager,
    workingDirectory: deps.workingDirectory,
    actionExecutor: deps.actionExecutor,
    incumbentExecutor: createReadFileRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.readFile'],
  });
}
