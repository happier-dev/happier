import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import type { ActionId } from '@happier-dev/protocol';

import { listDirectoryEntries } from './directoryListing/listDirectoryEntries';
import { validatePath } from '../pathSecurity';
import { authorizeFilesystemPathWithinRoot } from './accessPolicy/filesystemPathAuthorization';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { registerRootedFilesystemRpcHandlers } from './registerRootedFilesystemRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { registerFilesystemMutationActionHandlers, type FilesystemMutationActionIngress } from './pathMutationHandlers';
import { assertFilesystemEffectCurrent } from './accessPolicy/filesystemEffectAdmission';

type ListDirectoryRequest = Readonly<{ rootPath?: string; path: string; includeGitIgnore?: boolean }>;

type DirectoryEntry = Readonly<{
  name: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
  modified?: number;
  gitIgnored?: boolean;
}>;

type ListDirectoryResponse =
  | Readonly<{ success: true; entries: DirectoryEntry[]; truncated?: boolean; gitIgnoreAvailable?: boolean }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

type GetDirectoryTreeRequest = Readonly<{ rootPath?: string; path: string; maxDepth: number }>;

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: TreeNode[];
};

type GetDirectoryTreeResponse =
  | Readonly<{ success: true; tree: TreeNode; truncated?: boolean }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

type DirectoryHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
  assertCurrentAuthority?: () => Promise<void>;
  limits: Readonly<{
    listMaxEntries: number;
    treeMaxDepth: number;
    treeMaxNodes: number;
  }>;
}>;

function normalizePositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeNonNegativeInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

async function listDirectoryForRpc(
  data: ListDirectoryRequest | undefined,
  deps: Pick<DirectoryHandlerDeps, 'workingDirectory' | 'accessPolicy' | 'getAdditionalAllowedReadDirs' | 'limits' | 'assertCurrentAuthority'>,
): Promise<ListDirectoryResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('List directory request:', path);
  const validation = data?.rootPath === undefined
    ? validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy)
    : authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: data.rootPath,
      defaultDirectory: deps.workingDirectory, accessPolicy: deps.accessPolicy,
      additionalAllowedDirs: deps.getAdditionalAllowedReadDirs() });
  if (!validation.valid) {
    return { success: false, error: validation.error, errorCode: validation.errorCode };
  }

  try {
    await deps.assertCurrentAuthority?.();
    const listed = await listDirectoryEntries({
      directoryPath: validation.resolvedPath,
      includeFiles: true,
      maxEntries: normalizePositiveInt(deps.limits.listMaxEntries, 500),
      statConcurrency: 16,
      includeGitIgnore: data?.includeGitIgnore === true,
    });
    await deps.assertCurrentAuthority?.();
    const directoryEntries: DirectoryEntry[] = listed.entries.map((entry) => ({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      modified: entry.modified,
      ...(entry.gitIgnored !== undefined ? { gitIgnored: entry.gitIgnored } : {}),
    }));

    return {
      success: true,
      entries: directoryEntries,
      ...(listed.truncated ? { truncated: true } : {}),
      ...(listed.gitIgnoreAvailable !== undefined ? { gitIgnoreAvailable: listed.gitIgnoreAvailable } : {}),
    };
  } catch (error) {
    logger.debug('Failed to list directory:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
  }
}

async function getDirectoryTreeForRpc(
  data: GetDirectoryTreeRequest | undefined,
  deps: Pick<DirectoryHandlerDeps, 'workingDirectory' | 'accessPolicy' | 'getAdditionalAllowedReadDirs' | 'limits' | 'assertCurrentAuthority'>,
): Promise<GetDirectoryTreeResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  const requestedMaxDepth = typeof data?.maxDepth === 'number' ? data.maxDepth : Number(data?.maxDepth ?? 0);
  logger.debug('Get directory tree request:', path, 'maxDepth:', requestedMaxDepth);
  const validation = data?.rootPath === undefined
    ? validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy)
    : authorizeFilesystemPathWithinRoot({ targetPath: path, rootPath: data.rootPath,
      defaultDirectory: deps.workingDirectory, accessPolicy: deps.accessPolicy,
      additionalAllowedDirs: deps.getAdditionalAllowedReadDirs() });
  if (!validation.valid) {
    return { success: false, error: validation.error, errorCode: validation.errorCode };
  }

  if (!Number.isFinite(requestedMaxDepth) || requestedMaxDepth < 0) {
    return { success: false, error: 'maxDepth must be non-negative' };
  }

  const maxDepth = Math.min(
    Math.floor(requestedMaxDepth),
    normalizeNonNegativeInt(deps.limits.treeMaxDepth, 5),
  );
  const maxNodes = normalizePositiveInt(deps.limits.treeMaxNodes, 2_000);
  let visitedNodes = 0;
  let truncated = false;

  async function buildTree(nodePath: string, name: string, currentDepth: number): Promise<TreeNode | null> {
    if (visitedNodes >= maxNodes) {
      truncated = true;
      return null;
    }
    visitedNodes += 1;
    try {
      await deps.assertCurrentAuthority?.();
      const stats = await stat(nodePath);
      const node: TreeNode = {
        name,
        path: nodePath,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modified: stats.mtime.getTime(),
      };

      if (stats.isDirectory() && currentDepth < maxDepth) {
        await deps.assertCurrentAuthority?.();
        const entries = (await readdir(nodePath, { withFileTypes: true })).sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        const children: TreeNode[] = [];

        for (const entry of entries) {
          if (visitedNodes >= maxNodes) {
            truncated = true;
            break;
          }
          if (entry.isSymbolicLink()) {
            logger.debug(`Skipping symlink: ${join(nodePath, entry.name)}`);
            continue;
          }
          const childPath = join(nodePath, entry.name);
          const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
          if (childNode) children.push(childNode);
        }

        if (children.length > 0) node.children = children;
        if (children.length < entries.filter((entry) => !entry.isSymbolicLink()).length) {
          truncated = true;
        }
      }

      return node;
    } catch (error) {
      logger.debug(`Failed to process ${nodePath}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  try {
    const resolvedPath = validation.resolvedPath;
    const baseName = resolvedPath === '/' ? '/' : basename(resolvedPath);
    const tree = await buildTree(resolvedPath, baseName, 0);
    if (!tree) return { success: false, error: 'Failed to access the specified path' };
    await deps.assertCurrentAuthority?.();
    return { success: true, tree, ...(truncated ? { truncated: true } : {}) };
  } catch (error) {
    logger.debug('Failed to get directory tree:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
  }
}

export function createDirectoryRpcActionExecutor(deps: DirectoryHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown, context) {
      const currentDeps = { ...deps, assertCurrentAuthority: async () => {
        await deps.assertCurrentAuthority?.(); await assertFilesystemEffectCurrent(context);
      } };
      if (actionId === 'daemon.filesystem.listDirectory') {
        return {
          ok: true,
          result: await listDirectoryForRpc(input as ListDirectoryRequest | undefined, currentDeps),
        };
      }
      if (actionId === 'daemon.filesystem.getDirectoryTree') {
        return {
          ok: true,
          result: await getDirectoryTreeForRpc(input as GetDirectoryTreeRequest | undefined, currentDeps),
        };
      }
      return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
    },
  };
}

export function registerDirectoryHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: DirectoryHandlerDeps & FilesystemMutationActionIngress,
): void {
  registerFilesystemMutationActionHandlers(rpcHandlerManager, deps, ['daemon.filesystem.createDirectory']);

  registerRootedFilesystemRpcHandlers({
    rpcHandlerManager,
    workingDirectory: deps.workingDirectory,
    actionExecutor: deps.actionExecutor,
    incumbentExecutor: createDirectoryRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree'],
  });
}
