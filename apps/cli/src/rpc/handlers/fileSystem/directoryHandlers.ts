import { mkdir, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ActionId } from '@happier-dev/protocol';

import { listDirectoryEntries } from './directoryListing/listDirectoryEntries';
import { validatePath } from '../pathSecurity';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';

type CreateDirectoryRequest = Readonly<{ path: string }>;

type CreateDirectoryResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string }>;

type ListDirectoryRequest = Readonly<{ path: string }>;

type DirectoryEntry = Readonly<{
  name: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
  modified?: number;
}>;

type ListDirectoryResponse =
  | Readonly<{ success: true; entries: DirectoryEntry[]; truncated?: boolean }>
  | Readonly<{ success: false; error: string }>;

type GetDirectoryTreeRequest = Readonly<{ path: string; maxDepth: number }>;

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
  | Readonly<{ success: false; error: string }>;

type DirectoryHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
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
  deps: Pick<DirectoryHandlerDeps, 'workingDirectory' | 'accessPolicy' | 'getAdditionalAllowedReadDirs' | 'limits'>,
): Promise<ListDirectoryResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('List directory request:', path);

  const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy);
  if (!validation.valid || !validation.resolvedPath) {
    return { success: false, error: validation.error ?? 'Access denied' };
  }

  try {
    const listed = await listDirectoryEntries({
      directoryPath: validation.resolvedPath,
      includeFiles: true,
      maxEntries: normalizePositiveInt(deps.limits.listMaxEntries, 500),
      statConcurrency: 16,
    });
    const directoryEntries: DirectoryEntry[] = listed.entries.map((entry) => ({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      modified: entry.modified,
    }));

    return { success: true, entries: directoryEntries, ...(listed.truncated ? { truncated: true } : {}) };
  } catch (error) {
    logger.debug('Failed to list directory:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
  }
}

async function getDirectoryTreeForRpc(
  data: GetDirectoryTreeRequest | undefined,
  deps: Pick<DirectoryHandlerDeps, 'workingDirectory' | 'accessPolicy' | 'getAdditionalAllowedReadDirs' | 'limits'>,
): Promise<GetDirectoryTreeResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  const requestedMaxDepth = typeof data?.maxDepth === 'number' ? data.maxDepth : Number(data?.maxDepth ?? 0);
  logger.debug('Get directory tree request:', path, 'maxDepth:', requestedMaxDepth);

  const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy);
  if (!validation.valid || !validation.resolvedPath) {
    return { success: false, error: validation.error ?? 'Access denied' };
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
      const stats = await stat(nodePath);
      const node: TreeNode = {
        name,
        path: nodePath,
        type: stats.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modified: stats.mtime.getTime(),
      };

      if (stats.isDirectory() && currentDepth < maxDepth) {
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
    return { success: true, tree, ...(truncated ? { truncated: true } : {}) };
  } catch (error) {
    logger.debug('Failed to get directory tree:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
  }
}

function createDirectoryRpcActionExecutor(deps: DirectoryHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown) {
      if (actionId === 'daemon.filesystem.listDirectory') {
        return {
          ok: true,
          result: await listDirectoryForRpc(input as ListDirectoryRequest | undefined, deps),
        };
      }
      if (actionId === 'daemon.filesystem.getDirectoryTree') {
        return {
          ok: true,
          result: await getDirectoryTreeForRpc(input as GetDirectoryTreeRequest | undefined, deps),
        };
      }
      return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
    },
  };
}

export function registerDirectoryHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: DirectoryHandlerDeps & Readonly<{ actionExecutor?: RpcActionExecutor }>,
): void {
  rpcHandlerManager.registerHandler<CreateDirectoryRequest, CreateDirectoryResponse>(
    RPC_METHODS.CREATE_DIRECTORY,
    async (data) => {
      const path = typeof data?.path === 'string' ? data.path : '';
      logger.debug('Create directory request:', path);

      const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedWriteDirs(), deps.accessPolicy);
      if (!validation.valid || !validation.resolvedPath) {
        return { success: false, error: validation.error ?? 'Access denied' };
      }

      try {
        await mkdir(validation.resolvedPath, { recursive: true });
        return { success: true };
      } catch (error) {
        logger.debug('Failed to create directory:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to create directory' };
      }
    },
  );

  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: deps.actionExecutor ?? createDirectoryRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree'],
  });
}
