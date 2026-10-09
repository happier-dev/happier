import { stat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ScmRepositoryCloneInputSchema, ScmRepositoryContainedSubdirV1Schema } from '@happier-dev/protocol/scm/repositoryClone';
import { readScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { WorkspaceActivationRequestV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { WorkspaceSyncHandoffAdapter, PrepareWorkspaceSyncHandoffInput } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { resolveDirectoryInCheckout } from './resolveDirectoryInCheckout';
import type { RpcHandlerContext } from '@/api/rpc/types';

export type MaterializedProjectCheckout = Readonly<{
  rootPath: string;
  directory: string;
  created?: boolean;
  repositoryIdentity?: ScmHostingRepositoryIdentityV1;
}>;

export type MaterializeProjectCheckoutInput = Readonly<{
  materialization: WorkspaceActivationRequestV1;
  sourceDirectory?: string;
  sourceRootPath?: string;
  selector?: ProjectSourceRepositorySelectorV1;
  ref?: string;
  subdir?: string;
  registry?: ScmBackendRegistry;
  signal?: AbortSignal;
  /** Called at the owning materializer's effect boundary, never at draft admission. */
  onEffectsIssued?: () => void;
  /** Existing Sync custody, admitted by the containing Open owner. */
  sync?: Readonly<{
    adapter: WorkspaceSyncHandoffAdapter;
    request: Omit<PrepareWorkspaceSyncHandoffInput, 'action' | 'targetRootPath' | 'signal'>;
    context?: RpcHandlerContext;
  }>;
}>;

function refused(code: string, message = code): never {
  throw Object.assign(new Error(message), { code });
}

async function existingDirectory(path: string | undefined): Promise<string> {
  const normalized = path ? resolveCanonicalAbsolutePath(path) : null;
  if (!normalized) return refused('invalid_directory');
  try {
    if (!(await stat(normalized.path)).isDirectory()) return refused('invalid_directory');
    return await realpath(normalized.path);
  } catch {
    return refused('invalid_directory');
  }
}

async function containedDirectory(root: string, directory: string): Promise<string> {
  const physicalDirectory = await existingDirectory(directory);
  if (!isCanonicalAbsolutePathInsideRoot(root, physicalDirectory)) return refused('invalid_directory');
  return physicalDirectory;
}

async function explicitSubdirectory(root: string, subdir: string): Promise<string> {
  const parsed = ScmRepositoryContainedSubdirV1Schema.safeParse(subdir);
  if (!parsed.success) return refused('invalid_directory');
  const selected = await containedDirectory(root, resolve(root, parsed.data.replaceAll('\\', '/')));
  return resolveDirectoryInCheckout({ sourceDirectory: selected, sourceRootPath: root, checkoutRootPath: root });
}

/** Neutral realization only: SCM owns Git effects and Sync owns copying/links. */
export async function materializeProjectCheckout(input: MaterializeProjectCheckoutInput): Promise<MaterializedProjectCheckout> {
  input.signal?.throwIfAborted();
  const choice = input.materialization;
  if (choice.kind === 'clone') {
    if (!input.selector) return refused('source_unavailable');
    const { runScmRepositoryCloneRoute } = await import('@/scm/rpc/repositoryProvisioningDispatch');
    const parent = await existingDirectory(choice.destinationParentPath);
    input.signal?.throwIfAborted();
    const clone = await runScmRepositoryCloneRoute({
      request: ScmRepositoryCloneInputSchema.parse({ ...input.selector, destinationParentPath: parent, destinationDirectoryName: choice.destinationDirectoryName,
        confirmed: true, authorizationToken: 'clone-repository' }),
      workingDirectory: parent, registry: input.registry, signal: input.signal,
    }).catch(error => { input.onEffectsIssued?.(); throw error; });
    if (!clone.success) {
      if (!clone.outcome || clone.outcome.kind === 'outcome_unknown' || clone.outcome.kind === 'effect_applied_with_warning') input.onEffectsIssued?.();
      return refused(clone.errorCode ?? 'checkout_failed', clone.error);
    }
    input.onEffectsIssued?.();
    const rootPath = await existingDirectory(clone.destinationPath);
    if (input.ref) {
      const { runScmRoute, notRepositoryResponse } = await import('@/scm/rpc/dispatch');
      const checkout = await runScmRoute({
        request: { cwd: rootPath, name: input.ref, strategy: 'bring_changes' as const },
        workingDirectory: rootPath, registry: input.registry, signal: input.signal,
        onNonRepository: () => notRepositoryResponse(),
        runWithBackend: ({ context, selection }) => selection.backend.branchCheckout({
          context, request: { cwd: rootPath, name: input.ref!, strategy: 'bring_changes' },
        }),
      });
      if (!checkout.success) return refused(checkout.errorCode ?? 'ref_unavailable', checkout.error);
    }
    const directory = input.subdir ? await explicitSubdirectory(rootPath, input.subdir) : rootPath;
    const repositoryIdentity = readScmHostingRepositoryIdentity({
      ...clone.repository.provider, nameWithOwner: clone.repository.nameWithOwner,
    });
    return { rootPath, directory: await containedDirectory(rootPath, directory), created: true,
      ...(repositoryIdentity ? { repositoryIdentity } : {}) };
  }

  if (choice.kind === 'sync') {
    if (!input.sync) return refused('workspace_sync_unavailable');
    const request: PrepareWorkspaceSyncHandoffInput = {
      ...input.sync.request, action: choice.workspaceAction, targetRootPath: choice.targetPath, signal: input.signal,
    };
    const { materializeWorkspaceSyncForOpen } = await import('@/workspaces/sync/workspaceSyncHandoffAdapter');
    input.onEffectsIssued?.();
    await materializeWorkspaceSyncForOpen(input.sync.adapter, request, input.sync.context);
    const rootPath = await existingDirectory(choice.targetPath);
    const sourceDirectory = input.sourceDirectory ?? request.sourceRootPath;
    const mapped = await resolveDirectoryInCheckout({ sourceDirectory, sourceRootPath: request.sourceRootPath, checkoutRootPath: rootPath });
    return { rootPath, directory: await containedDirectory(rootPath, input.subdir ? await explicitSubdirectory(rootPath, input.subdir) : mapped) };
  }

  const sourceRoot = await existingDirectory(input.sourceRootPath ?? input.sourceDirectory);
  const sourceDirectory = await containedDirectory(sourceRoot, input.sourceDirectory ?? sourceRoot);
  if (choice.kind === 'attach') {
    const directory = input.subdir ? await explicitSubdirectory(sourceRoot, input.subdir) : sourceDirectory;
    return { rootPath: sourceRoot, directory: await containedDirectory(sourceRoot, directory), created: false };
  }

  const { realizeWorkspaceCheckoutWithScmWorkspaceSource } = await import('@/scm/workspace/workspaceCheckoutOperations');
  input.signal?.throwIfAborted();
  input.onEffectsIssued?.();
  const checkout = await realizeWorkspaceCheckoutWithScmWorkspaceSource({
    sourcePath: sourceDirectory, targetPath: choice.targetPath, registry: input.registry,
    checkoutCreation: { ...choice.checkout, baseRef: input.ref ?? choice.checkout.baseRef, branchMode: choice.checkout.branchMode ?? 'new' },
  });
  if (!checkout) return refused('checkout_unavailable');
  const rootPath = await existingDirectory(checkout.realization.targetPath);
  const mapped = await resolveDirectoryInCheckout({
    sourceDirectory, sourceRootPath: checkout.sourceRootPath, checkoutRootPath: rootPath,
  });
  return {
    rootPath, directory: await containedDirectory(rootPath, input.subdir ? await explicitSubdirectory(rootPath, input.subdir) : mapped),
    created: checkout.realization.created,
  };
}
