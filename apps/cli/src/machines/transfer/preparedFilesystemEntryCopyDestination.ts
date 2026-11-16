import { lstat, mkdir, readdir, readlink, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { installWorkspaceTree } from '@/workspaces/source/copyWorkspaceTree';

import type { WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';

import {
  authorizeFilesystemMutationPath,
  isFilesystemMutationRootPath,
  type FilesystemMutationDeps,
} from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { stageWorkspaceSyncEntryExport } from '@/workspaces/sync/workspaceSyncEntryTransfer';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import {
  runNativeConfinedWorkspaceSyncApply,
  type NativeConfinedApplyOutcome,
  type WorkspaceSyncNativeConfinedDependencies,
} from '@/workspaces/sync/workspaceSyncNativeConfinedFileSystem';

export type PreparedFilesystemEntryCopyDestinationInput = Readonly<{
  operationId: string;
  rootPath: string;
  path: string;
  /** The containing prepared lifecycle supplies its verified requester; OS-local owners supply their admission callback. */
  requesterAccountId?: string;
  overwrite: boolean;
  recursive: boolean;
  expectation: WorkspaceSyncEntryExpectationV1;
  /** Owned by the containing prepared copy operation, never a caller-supplied OS path. */
  stagingDirectory: string;
  recoveryDirectory: string;
  requestPayload: Parameters<typeof stageWorkspaceSyncEntryExport>[0]['requestPayload'];
  assertCurrentAuthority: () => Promise<void>;
  signal?: AbortSignal;
}>;

function refuse(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Stateless destination port; the existing prepared operation retains all private custody. */
export function createPreparedFilesystemEntryCopyDestination(
  dependencies: Pick<FilesystemMutationDeps, 'workingDirectory' | 'accessPolicy'>
    & Partial<Pick<FilesystemMutationDeps, 'getAdditionalAllowedReadDirs' | 'getAdditionalAllowedWriteDirs'>>
    & Readonly<{ nativeDependencies?: WorkspaceSyncNativeConfinedDependencies }>,
): (input: PreparedFilesystemEntryCopyDestinationInput) => Promise<NativeConfinedApplyOutcome> {
  const admission: FilesystemMutationDeps = {
    ...dependencies,
    getAdditionalAllowedReadDirs: dependencies.getAdditionalAllowedReadDirs ?? (() => []),
    getAdditionalAllowedWriteDirs: dependencies.getAdditionalAllowedWriteDirs ?? (() => []),
  };
  const destination = async (input: PreparedFilesystemEntryCopyDestinationInput): Promise<NativeConfinedApplyOutcome> => {
    if (input.requesterAccountId !== undefined && !input.requesterAccountId.trim()) refuse('filesystem_requester_unavailable', 'A verified requester is required');
    if (!/^[A-Za-z0-9_-]+$/u.test(input.operationId) || typeof input.overwrite !== 'boolean'
      || typeof input.recursive !== 'boolean' || typeof input.assertCurrentAuthority !== 'function') {
      refuse('invalid_input', 'Invalid prepared entry copy input');
    }
    if (input.expectation.kind === 'missing') refuse('source_missing', 'The prepared source entry is missing');
    if (input.expectation.kind === 'directory' && !input.recursive) refuse('recursive_required', 'A directory copy requires recursive=true');
    const assertAuthority = async () => {
      input.signal?.throwIfAborted();
      await input.assertCurrentAuthority();
      input.signal?.throwIfAborted();
    };
    await assertAuthority();
    const root = authorizeFilesystemMutationPath(input.rootPath, input.rootPath, 'write', admission);
    const destination = authorizeFilesystemMutationPath(input.path, input.rootPath, 'write', admission);
    if (!root.valid) refuse('access_denied', root.error);
    if (!destination.valid) refuse('access_denied', destination.error);
    if (isFilesystemMutationRootPath(destination.resolvedPath, root.resolvedPath, admission)) {
      refuse('root_refused', 'Cannot replace a filesystem root');
    }
    const requestedRelativePath = relative(root.resolvedPath, destination.resolvedPath);
    if (requestedRelativePath === '..' || requestedRelativePath.startsWith(`..${sep}`) || isAbsolute(requestedRelativePath)) {
      refuse('access_denied', 'The destination must be within its declared root');
    }
    const components = requestedRelativePath.split(sep);
    let applyDestination = destination.resolvedPath;
    let missingParent = false;
    for (let index = 0; index < components.length - 1; index += 1) {
      const parentPath = join(root.resolvedPath, ...components.slice(0, index + 1));
      const parent = authorizeFilesystemMutationPath(parentPath, root.resolvedPath, 'write', admission);
      if (!parent.valid) refuse('access_denied', parent.error);
      const stats = await lstat(parentPath).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stats) { applyDestination = parentPath; missingParent = true; break; }
      if (!stats.isDirectory() || stats.isSymbolicLink()) refuse('workspace_root_unsafe', 'The destination parent is not a confined directory');
    }
    if (isFilesystemMutationRootPath(applyDestination, root.resolvedPath, admission)) {
      refuse('root_refused', 'Cannot replace a filesystem root or its ancestor');
    }
    const relativePath = relative(root.resolvedPath, applyDestination);
    const expectedDestination = await observeWorkspaceSyncEntryAtRoot({
      rootPath: root.resolvedPath, relativePath, assertCurrentAuthority: assertAuthority,
    });
    if (missingParent && expectedDestination.kind !== 'missing') refuse('conflict_changed', 'A missing destination parent changed before staging');
    if (expectedDestination.kind !== 'missing' && !input.overwrite) refuse('destination_exists', 'Destination already exists');

    const materialPath = await stageWorkspaceSyncEntryExport({
      operationId: input.operationId, stagingDirectory: input.stagingDirectory, expectation: input.expectation,
      requestPayload: async (request) => { await assertAuthority(); await input.requestPayload(request); },
    });
    if (materialPath === null) refuse('source_missing', 'The prepared source entry is missing');
    const validateMaterial = async (material: string, prospective: string): Promise<void> => {
      const authorized = authorizeFilesystemMutationPath(prospective, root.resolvedPath, 'write', admission);
      if (!authorized.valid) refuse('access_denied', authorized.error);
      const stats = await lstat(material);
      if (stats.isSymbolicLink()) {
        // A symlink's tilde is literal. Resolve it before the canonical user-path
        // helper so it cannot be mistaken for home expansion at this boundary.
        const target = resolve(dirname(prospective), await readlink(material));
        const admittedTarget = authorizeFilesystemMutationPath(target, root.resolvedPath, 'write', admission);
        if (!admittedTarget.valid) refuse('access_denied', admittedTarget.error);
      } else if (stats.isDirectory()) {
        for (const name of await readdir(material)) await validateMaterial(join(material, name), join(prospective, name));
      }
    };
    await validateMaterial(materialPath, destination.resolvedPath);
    let applyMaterialPath = materialPath;
    let selectedExpectation: WorkspaceSyncEntryExpectationV1 = input.expectation;
    if (missingParent) {
      // Publish missing parents and the entry in one existing native apply,
      // never as preparatory public mkdir effects. This wrapper stays private.
      applyMaterialPath = join(input.stagingDirectory, 'parents');
      const nestedMaterialPath = join(applyMaterialPath, relative(applyDestination, destination.resolvedPath));
      await mkdir(dirname(nestedMaterialPath), { recursive: true });
      await rename(materialPath, nestedMaterialPath);
      selectedExpectation = await observeWorkspaceSyncEntryAtRoot({
        rootPath: input.stagingDirectory, relativePath: 'parents', assertCurrentAuthority: assertAuthority,
      });
    }
    await assertAuthority();
    let commitAdmitted = false;
    try {
      return await runNativeConfinedWorkspaceSyncApply({
        rootPath: root.resolvedPath, relativePath, expectedDestination,
        selectedExpectation, materialPath: applyMaterialPath,
        recoveryDirectory: input.recoveryDirectory, operationId: input.operationId,
        assertCurrentAuthority: async () => { await assertAuthority(); commitAdmitted = true; },
      }, dependencies.nativeDependencies);
    } catch (error) {
      // A missing terminal result after the commit boundary cannot prove rollback.
      // Keep existing native recovery custody; never dispose private material here.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (commitAdmitted && code !== 'conflict_changed') {
        return { status: 'recovery_needed', recoveryPath: join(input.recoveryDirectory, `workspace-recovery-${input.operationId}.json`) };
      }
      throw error;
    }
  };
  return async (input) => {
    const source = currentWorkspaceSource();
    if (source.kind === 'local') return await destination(input);
    // A target destination: materialize the admitted entry in host staging with the same
    // confined owner, then install it into the target through the port (install/restore).
    const stagingRoot = createHappierTempDir({ purpose: 'filesystem-copy-target-stage' });
    try {
      const stagedPath = join(stagingRoot, 'entry');
      await localWorkspaceSource.mkdir(join(stagingRoot, 'recovery'), { recursive: true });
      const staged = await runWithWorkspaceSource(localWorkspaceSource, () => createPreparedFilesystemEntryCopyDestination({
        workingDirectory: stagingRoot, accessPolicy: { kind: 'restrictedRoots', roots: [stagingRoot] },
      })({ ...input, rootPath: stagingRoot, path: stagedPath, overwrite: false,
        stagingDirectory: join(stagingRoot, 'stage'), recoveryDirectory: join(stagingRoot, 'recovery') }));
      if (staged.status !== 'installed') return staged;
      return await installWorkspaceTree({ from: { source: localWorkspaceSource, path: stagedPath }, to: { source, path: input.path },
        overwrite: input.overwrite, ...(input.signal ? { signal: input.signal } : {}), assertCurrentAuthority: input.assertCurrentAuthority });
    } finally { await removeHappierTempDirAsync(stagingRoot); }
  };
}
