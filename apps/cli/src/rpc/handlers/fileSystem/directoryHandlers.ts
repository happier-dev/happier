import { mkdir, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { listDirectoryEntries } from './directoryListing/listDirectoryEntries';
import { validatePath } from '../pathSecurity';

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
  | Readonly<{ success: true; entries: DirectoryEntry[] }>
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
  | Readonly<{ success: true; tree: TreeNode }>
  | Readonly<{ success: false; error: string }>;

export function registerDirectoryHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  }>,
): void {
  rpcHandlerManager.registerHandler<CreateDirectoryRequest, CreateDirectoryResponse>(
    RPC_METHODS.CREATE_DIRECTORY,
    async (data) => {
      const path = typeof data?.path === 'string' ? data.path : '';
      logger.debug('Create directory request:', path);

      const validation = validatePath(path, deps.workingDirectory);
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

  rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>(
    RPC_METHODS.LIST_DIRECTORY,
    async (data) => {
      const path = typeof data?.path === 'string' ? data.path : '';
      logger.debug('List directory request:', path);

      const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs());
      if (!validation.valid || !validation.resolvedPath) {
        return { success: false, error: validation.error ?? 'Access denied' };
      }

      try {
        const listed = await listDirectoryEntries({
          directoryPath: validation.resolvedPath,
          includeFiles: true,
          maxEntries: null,
          statConcurrency: 16,
        });
        const directoryEntries: DirectoryEntry[] = listed.entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          size: entry.size,
          modified: entry.modified,
        }));

        return { success: true, entries: directoryEntries };
      } catch (error) {
        logger.debug('Failed to list directory:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
      }
    },
  );

  rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>(
    RPC_METHODS.GET_DIRECTORY_TREE,
    async (data) => {
      const path = typeof data?.path === 'string' ? data.path : '';
      const maxDepth = typeof data?.maxDepth === 'number' ? data.maxDepth : Number(data?.maxDepth ?? 0);
      logger.debug('Get directory tree request:', path, 'maxDepth:', maxDepth);

      const validation = validatePath(path, deps.workingDirectory);
      if (!validation.valid || !validation.resolvedPath) {
        return { success: false, error: validation.error ?? 'Access denied' };
      }

      if (!Number.isFinite(maxDepth) || maxDepth < 0) {
        return { success: false, error: 'maxDepth must be non-negative' };
      }

      async function buildTree(nodePath: string, name: string, currentDepth: number): Promise<TreeNode | null> {
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
            const entries = await readdir(nodePath, { withFileTypes: true });
            const children: TreeNode[] = [];

            await Promise.all(
              entries.map(async (entry) => {
                if (entry.isSymbolicLink()) {
                  logger.debug(`Skipping symlink: ${join(nodePath, entry.name)}`);
                  return;
                }
                const childPath = join(nodePath, entry.name);
                const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
                if (childNode) children.push(childNode);
              }),
            );

            children.sort((a, b) => {
              if (a.type === 'directory' && b.type !== 'directory') return -1;
              if (a.type !== 'directory' && b.type === 'directory') return 1;
              return a.name.localeCompare(b.name);
            });

            if (children.length > 0) node.children = children;
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
        return { success: true, tree };
      } catch (error) {
        logger.debug('Failed to get directory tree:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
      }
    },
  );
}
