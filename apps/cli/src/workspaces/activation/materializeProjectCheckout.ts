import { privateProjectCheckoutRefusal } from './privateProjectCheckout';
import { isHostRequesterUnrestrictedOwner, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ScmRepositoryCloneInputSchema, ScmRepositoryContainedSubdirV1Schema } from '@happier-dev/protocol/scm/repositoryClone';
import { ScmCommitOidSchema } from '@happier-dev/protocol/scm/commitPublication';
import type { ScmBranchCheckoutResponse } from '@happier-dev/protocol/scm/branches';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError } from '@happier-dev/cli-common/plugins/errors';
import { readScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { OpenProjectResultV1, WorkspaceActivationRequestV1 } from '@happier-dev/protocol/projects/openProjectV1';
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
  requesterIdentity?: HostRequesterExecutionIdentity;
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

function refused(code: string, message = code,
  details?: Pick<Extract<OpenProjectResultV1, { kind: 'refused' }>, 'retryNotBeforeMs' | 'remediation' | 'failureCause'> & Readonly<{ destinationPath?: string }>): never {
  throw Object.assign(new Error(message), { code, ...details });
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

/** The physical parent when it exists. A missing one stays as chosen: the clone owner creates it when the clone runs. */
async function cloneParentDirectory(path: string): Promise<string> {
  const normalized = resolveCanonicalAbsolutePath(path);
  const missing = normalized && await stat(normalized.path).then(() => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  return normalized && missing ? normalized.path : existingDirectory(path);
}

async function containedDirectory(root: string, directory: string): Promise<string> {
  const physicalDirectory = await existingDirectory(directory);
  if (!isCanonicalAbsolutePathInsideRoot(root, physicalDirectory)) return refused('invalid_directory');
  return physicalDirectory;
}

async function explicitSubdirectory(root: string, subdir: string): Promise<string> {
  const parsed = ScmRepositoryContainedSubdirV1Schema.safeParse(subdir);
  if (!parsed.success) return refused('invalid_directory');
  const requested = resolve(root, parsed.data.replaceAll('\\', '/'));
  // The checkout is there and this folder isn't in it; a path that escapes the checkout stays invalid_directory.
  if (!await stat(requested).then(entry => entry.isDirectory(), () => false)) return refused('repository_subfolder_missing');
  const selected = await containedDirectory(root, requested);
  return resolveDirectoryInCheckout({ sourceDirectory: selected, sourceRootPath: root, checkoutRootPath: root });
}

/** Neutral realization only: SCM owns Git effects and Sync owns copying/links. */
export async function materializeProjectCheckout(input: MaterializeProjectCheckoutInput): Promise<MaterializedProjectCheckout> {
  input.signal?.throwIfAborted();
  // A daemon-side Account/Workspace reference is not permission to realize a
  // member checkout. The containing Open owner uses the selected native child.
  if (input.requesterIdentity && !isHostRequesterUnrestrictedOwner(input.requesterIdentity))
    throw privateProjectCheckoutRefusal();
  const choice = input.materialization;
  if (choice.kind === 'clone') {
    if (choice.initialCheckout && input.ref !== undefined && (!('commit' in choice.initialCheckout) || input.ref !== choice.initialCheckout.commit)) return refused('invalid_materialization');
    const commit = ScmCommitOidSchema.safeParse(input.ref);
    const initialCheckout = choice.initialCheckout ?? (commit.success ? { branch: null, commit: commit.data } : undefined);
    if (!input.selector) return refused('source_unavailable');
    const { runScmRepositoryCloneRoute } = await import('@/scm/rpc/repositoryProvisioningDispatch');
    const parent = await cloneParentDirectory(choice.destinationParentPath);
    input.signal?.throwIfAborted();
    // A folder already at the destination is never taken over, not even a checkout of this same repository: another
    // Open, lane or person may own it (COR4B 11-15: a new deploy adopted another lane's checkout and fetched in it).
    // The person picks another folder name, or opens that folder as it is (a folder Open with attach).
    const destination = join(parent, choice.destinationDirectoryName);
    if (await stat(destination).then(() => true, () => false)) return refused('destination_exists', `${destination} already exists`);
    const clone = await runScmRepositoryCloneRoute({
      request: ScmRepositoryCloneInputSchema.parse({ ...input.selector, destinationParentPath: parent, destinationDirectoryName: choice.destinationDirectoryName,
        ...(initialCheckout ? { initialCheckout } : {}),
        confirmed: true, authorizationToken: 'clone-repository' }),
      workingDirectory: parent, registry: input.registry, signal: input.signal,
    }).catch(error => { input.onEffectsIssued?.(); throw error; });
    if (!clone.success) {
      if (clone.destinationPath || !clone.outcome || clone.outcome.kind === 'outcome_unknown' || clone.outcome.kind === 'effect_applied_with_warning') input.onEffectsIssued?.();
      return refused(clone.errorCode ?? 'checkout_failed', clone.error,
        { ...(clone.destinationPath ? { destinationPath: clone.destinationPath } : {}),
          ...(clone.failureCause ? { failureCause: clone.failureCause } : {}),
          ...(clone.remediation ? { remediation: clone.remediation } : {}),
          ...(clone.errorCode === 'REMOTE_RATE_LIMITED' ? { retryNotBeforeMs: clone.retryNotBeforeMs } : {}) });
    }
    input.onEffectsIssued?.();
    const rootPath = await existingDirectory(clone.destinationPath);
    if (input.ref && !initialCheckout) {
      input.onEffectsIssued?.();
      const { runScmRoute, notRepositoryResponse } = await import('@/scm/rpc/dispatch');
      const checkout = await runScmRoute({
        request: { cwd: rootPath, name: input.ref, strategy: 'bring_changes' as const },
        workingDirectory: rootPath, registry: input.registry, signal: input.signal,
        onNonRepository: () => notRepositoryResponse<ScmBranchCheckoutResponse>(),
        runWithBackend: ({ context, selection }) => selection.backend.workspaceIntegration?.checkoutRef
          ? selection.backend.workspaceIntegration.checkoutRef({ context, ref: input.ref!,
            ...(input.signal ? { signal: input.signal } : {}) })
          : selection.backend.branchCheckout({
            context, request: { cwd: rootPath, name: input.ref!, strategy: 'bring_changes' },
          }),
      });
      if (!checkout.success) {
        const code = checkout.errorCode ?? 'ref_unavailable';
        // Only the SCM owner's terminal result establishes a known refusal.
        if (!('outcome' in checkout) || checkout.outcome?.kind !== 'failed') return refused(code, checkout.error);
        const failure = Object.assign(new Error(checkout.error ?? code), { code });
        throw new PluginError({ code, message: failure.message,
          failureCause: projectActionFailureCauseV1(failure, 'project_open.checkout_ref') });
      }
    }
    const directory = input.subdir ? await explicitSubdirectory(rootPath, input.subdir) : rootPath;
    const repositoryIdentity = readScmHostingRepositoryIdentity(
      { ...clone.repository.provider, nameWithOwner: clone.repository.nameWithOwner });
    return { rootPath, directory: await containedDirectory(rootPath, directory), created: true,
      ...(repositoryIdentity ? { repositoryIdentity } : {}) };
  }

  if (choice.kind === 'sync') {
    if (!input.sync) return refused('workspace_sync_unavailable');
    const request: PrepareWorkspaceSyncHandoffInput = {
      ...input.sync.request, action: choice.workspaceAction, targetRootPath: choice.targetPath, signal: input.signal,
      onEffectsIssued: input.onEffectsIssued,
    };
    const { materializeWorkspaceSyncForOpen } = await import('@/workspaces/sync/workspaceSyncHandoffAdapter');
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
  const checkout = await realizeWorkspaceCheckoutWithScmWorkspaceSource({
    sourcePath: sourceDirectory, targetPath: choice.targetPath, registry: input.registry,
    checkoutCreation: { ...choice.checkout, baseRef: input.ref ?? choice.checkout.baseRef, branchMode: choice.checkout.branchMode ?? 'new' },
  }).catch(error => {
    // The SCM materializer emits ref_unavailable only during its no-effect
    // admission. Every other exception remains conservatively uncertain.
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ref_unavailable') input.onEffectsIssued?.();
    throw error;
  });
  if (!checkout) return refused('checkout_unavailable');
  input.onEffectsIssued?.();
  const rootPath = await existingDirectory(checkout.realization.targetPath);
  const mapped = await resolveDirectoryInCheckout({
    sourceDirectory, sourceRootPath: checkout.sourceRootPath, checkoutRootPath: rootPath,
  });
  return {
    rootPath, directory: await containedDirectory(rootPath, input.subdir ? await explicitSubdirectory(rootPath, input.subdir) : mapped),
    created: checkout.realization.created,
  };
}
