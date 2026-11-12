import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { RepositoryFilesPullRequestHost } from '@/scm/actions/repositoryFilesPullRequest';
import type { ScmBackendRegistry } from '@/scm/registry';

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
  }>,
): RepositoryFilesPullRequestHost {
  const { context } = input;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const admission = (context as RpcActionExecutorContext).machineAdmission;
  const custodian = binding
    ? binding.accountId === binding.custodianAccountId
    : !admission || admission.actorAccountId === admission.custodianAccountId;
  if (!custodian)
    throw Object.assign(new Error(ADMITTED_CHECKOUT_OWNER_REQUIRED), {
      code: ADMITTED_CHECKOUT_OWNER_REQUIRED,
    });
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
