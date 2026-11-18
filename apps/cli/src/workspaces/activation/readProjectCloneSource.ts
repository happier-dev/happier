import { projectScmRepositoryCloneSourceV1, type ScmRepositoryCloneSourceV1 } from '@happier-dev/protocol/scm/repositoryClone';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { runScmRoute } from '@/scm/rpc/dispatch';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';

/** Project Open has admitted this source; SCM owns remote/upstream selection and branch facts. */
export async function readProjectCloneSource(input: Readonly<{
  directory: string; registry?: ScmBackendRegistry; signal: AbortSignal;
}>): Promise<ScmRepositoryCloneSourceV1> {
  const request = { cwd: input.directory, detail: 'facts' as const };
  const status = await runScmRoute<typeof request, Awaited<ReturnType<ScmBackend['statusSnapshot']>>>({
    request, workingDirectory: input.directory, registry: input.registry, signal: input.signal,
    onNonRepository: () => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY }),
    runWithBackend: ({ context, selection }) => selection.backend.statusSnapshot({ context, request }),
  });
  input.signal.throwIfAborted();
  if (!status.success || !status.snapshot) return { source: null, branch: null };
  return projectScmRepositoryCloneSourceV1(status.snapshot);
}
