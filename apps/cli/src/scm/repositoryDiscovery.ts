import { join } from 'node:path';

import type { ScmRepositoryDiscoverRequest, ScmRepositoryDiscoverResponse } from '@happier-dev/protocol/scm/repositoryDiscovery';
import { normalizeScmHostingRepositoryIdentity, readScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';

import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { resolveFilesystemAccessPolicy, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { runWithScmCommandOperation } from './commandOperation';
import { resolveTildePath, runScmCommand } from './runtime';
import { resolveScmHostingRepositoryAddress } from './hostingProviders/resolveAddress';
import type { ResolvedScmHostingProviderRegistry } from './hostingProviders/registry';

function discoveryFailure(error: unknown) {
  const carried = error !== null && typeof error === 'object'
    ? Reflect.get(error, 'errorCode') ?? Reflect.get(error, 'code') : undefined;
  return { success: false as const,
    errorCode: typeof carried === 'string' && carried ? carried : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    error: error instanceof Error ? error.message : 'Repository discovery is unavailable.' };
}

/** Search only the person's selected folder, without registering or changing a checkout. */
export async function discoverScmRepositories(input: Readonly<{
  request: ScmRepositoryDiscoverRequest;
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  hostingProviderRegistry?: ResolvedScmHostingProviderRegistry;
  signal?: AbortSignal;
}>): Promise<ScmRepositoryDiscoverResponse> {
  const accessPolicy = input.accessPolicy ?? resolveFilesystemAccessPolicy();
  let authorized: ReturnType<typeof authorizeFilesystemPath>;
  try {
    authorized = authorizeFilesystemPath({ targetPath: resolveTildePath(input.request.cwd),
      defaultDirectory: resolveTildePath(input.workingDirectory), accessPolicy });
  } catch (error) { return discoveryFailure(error); }
  if (!authorized.valid) return { success: false, errorCode: authorized.errorCode, error: authorized.error };
  const source = currentWorkspaceSource();
  const repositories = input.request.repositories.map(repository => normalizeScmHostingRepositoryIdentity(repository));
  return runWithScmCommandOperation(input.signal, async () => {
    const matches: Extract<ScmRepositoryDiscoverResponse, { success: true }>['matches'] = [];
    const skipped: Extract<ScmRepositoryDiscoverResponse, { success: true }>['skipped'] = [];
    try {
      input.signal?.throwIfAborted();
      const children = await source.readdir(authorized.resolvedPath);
      for (const child of children) {
        if (!child.isDirectory()) continue;
        input.signal?.throwIfAborted();
        const rootPath = join(authorized.resolvedPath, child.name);
        try {
          const marker = await source.lstat(join(rootPath, '.git')).catch((error: unknown) => {
            if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
            throw error;
          });
          if (!marker || (!marker.isDirectory() && !marker.isFile())) continue;
          const origin = await runScmCommand({ bin: 'git', cwd: rootPath,
            args: ['config', '--local', '--get', 'remote.origin.url'], signal: input.signal });
          input.signal?.throwIfAborted();
          // Git's exit 1 with no diagnostic means this repository has no origin.
          if (!origin.success) {
            if (origin.exitCode === 1 && !origin.stderr.trim()) continue;
            skipped.push({ rootPath, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
              error: origin.stderr || 'Repository origin is unavailable.' });
            continue;
          }
          const address = await resolveScmHostingRepositoryAddress({ address: origin.stdout.trim(),
            registry: input.hostingProviderRegistry, signal: input.signal });
          if (!address.success || address.kind !== 'resolved') {
            skipped.push({ rootPath, origin: address });
            continue;
          }
          const repositoryIdentity = readScmHostingRepositoryIdentity({ ...address.selector.provider,
            nameWithOwner: address.selector.repository.nameWithOwner });
          if (repositoryIdentity && repositories.some(repository =>
            sameScmHostingRepositoryIdentity(repositoryIdentity, repository))) matches.push({ rootPath, repositoryIdentity });
        } catch (error) {
          input.signal?.throwIfAborted();
          const failure = discoveryFailure(error);
          skipped.push({ rootPath, errorCode: failure.errorCode, error: failure.error });
        }
      }
      return { success: true, matches, skipped };
    } catch (error) {
      input.signal?.throwIfAborted();
      return discoveryFailure(error);
    }
  });
}
