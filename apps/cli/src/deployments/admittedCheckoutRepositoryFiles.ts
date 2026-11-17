import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { RepositoryFilesPullRequestHost } from '@/scm/actions/repositoryFilesPullRequest';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';

export type ResolveRepositoryCheckoutRemovalRuntime = (context: ActionExecutorContext) => Promise<Readonly<{
  runtime: ProjectFiniteActionRuntime; ingress: RpcHandlerContext;
}> | null>;

/** Another Account's live repository work needs its receiving identity, which this host does not provide. */
export const ADMITTED_CHECKOUT_OWNER_REQUIRED = 'checkout_owner_required';

/**
 * The one scope for a reviewed repository composition (Move, Template) on its
 * placed Machine. Home admitted the root once; the Account rows then resolved
 * this checkout. Every SCM read, write, commit, push and file effect runs here
 * through the Machine's own SCM and filesystem owners, narrowed to that root
 * after the Machine filesystem policy. Those owners resolve real paths, so `..`,
 * symlinks and sibling checkouts outside the root are refused.
 */
export function createAdmittedCheckoutRepositoryFiles(
  input: Readonly<{
    root: string;
    context: ActionExecutorContext;
    /** The Machine's SCM backends; absent uses the installed runtime, as the SCM RPC handler does. */
    registry?: ScmBackendRegistry;
    /** Original admitted requester and containing operation, retained by the native host. */
    resolveRemovalRuntime?: ResolveRepositoryCheckoutRemovalRuntime;
  }>,
): RepositoryFilesPullRequestHost {
  const { context } = input;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const admission = (context as RpcActionExecutorContext).machineAdmission;
  const custodian = binding
    ? binding.accountId === binding.custodianAccountId
    : !admission || admission.actorAccountId === admission.custodianAccountId;
  if (!custodian)
    throw createActionExecuteFailureError({ ok: false, errorCode: ADMITTED_CHECKOUT_OWNER_REQUIRED, error: ADMITTED_CHECKOUT_OWNER_REQUIRED });
  type Scope = Readonly<{ root: string; accessPolicy: FilesystemAccessPolicy }>;
  let scope: Promise<Scope> | undefined;
  const admitted = () =>
    (scope ??= (async (): Promise<Scope> => {
      const [{ resolveCwd }, { resolveFilesystemAccessPolicy }] =
        await Promise.all([
          import('@/scm/runtime'),
          import('@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy'),
        ]);
      const scoped = resolveCwd(
        input.root,
        input.root,
        resolveFilesystemAccessPolicy(),
      );
      // An unadmitted root narrows to nothing; each owner then refuses its path.
      return scoped.ok
        ? {
            root: scoped.cwd,
            accessPolicy: { kind: 'restrictedRoots', roots: [scoped.cwd] },
          }
        : {
            root: input.root,
            accessPolicy: { kind: 'restrictedRoots', roots: [] },
          };
    })());
  const filesystem = async () => {
    context.signal?.throwIfAborted();
    const { root, accessPolicy } = await admitted();
    return {
      workingDirectory: root,
      accessPolicy,
      getAdditionalAllowedReadDirs: () => [],
      getAdditionalAllowedWriteDirs: () => [],
    };
  };
  const signal = context.signal ? { signal: context.signal } : {};
  return {
    executeScm: async (actionId, request) => {
      const [{ root, accessPolicy }, { executeScmActionOperation }] =
        await Promise.all([
          admitted(),
          import('@/scm/actions/executeScmActionOperation'),
        ]);
      context.signal?.throwIfAborted();
      return executeScmActionOperation({
        actionId,
        input: { cwd: root, ...Object(request) },
        workingDirectory: root,
        accessPolicy,
        ...(input.registry ? { registry: input.registry } : {}),
        removeWorktree: async removal => {
          const admittedRuntime = await input.resolveRemovalRuntime?.(context);
          if (!admittedRuntime) throw Object.assign(new Error('project_setup_operation_unavailable'), { code: 'project_setup_operation_unavailable' });
          const { prepareProjectCheckoutRemoval, requireProjectCheckoutRemovalOperation } = await import('@/workspaces/projectSetup/projectCheckoutRemoval');
          const { runtime, ingress } = admittedRuntime;
          const operation = requireProjectCheckoutRemovalOperation(context);
          let preparation: ReturnType<typeof prepareProjectCheckoutRemoval> | undefined;
          const removed = await removal.remove(async () => {
            preparation ??= prepareProjectCheckoutRemoval({ runtime, ingress, context, operation,
              worktreePath: removal.worktreePath, skipCleanup: removal.request.skipCleanup === true });
            await preparation;
          });
          if (removed.success && preparation) (await preparation).settle('deleted');
          return removed;
        },
        ...signal,
      });
    },
    writeFile: async (request) => {
      const [scoped, { writeFileForRpc }] = await Promise.all([
        filesystem(),
        import('@/rpc/handlers/fileSystem/writeFileForRpc'),
      ]);
      return writeFileForRpc(request, scoped);
    },
    deleteFile: async (request) => {
      const [scoped, { executeFilesystemMutationAction }] = await Promise.all([
        filesystem(),
        import('@/rpc/handlers/fileSystem/pathMutationHandlers'),
      ]);
      return executeFilesystemMutationAction({
        ...scoped,
        ...signal,
        actionId: 'daemon.filesystem.delete',
        input: request,
      });
    },
  };
}
