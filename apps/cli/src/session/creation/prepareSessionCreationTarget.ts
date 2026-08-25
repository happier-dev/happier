import {
  SCM_OPERATION_ERROR_CODES,
  SessionCreationTargetPreparationRequestV1Schema,
  SessionCreationTargetPreparationResultV1Schema,
  type ScmWorktreeCreateRequest,
  type ScmWorktreeCreateResponse,
  type SessionCreationTargetPreparationRequestV1,
  type SessionCreationTargetPreparationResultV1,
} from '@happier-dev/protocol';

import { notRepositoryResponse, runScmRoute } from '@/scm/rpc/dispatch';
import { realizeWorkspaceCheckoutWithScmWorkspace } from '@/scm/workspace';
import { ensureSessionDirectory } from '@/daemon/startup/ensureSessionDirectory';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';

type CreateSessionCheckout = (input: Readonly<{
  sourceDirectory: string;
  displayName: string;
  baseRef: string | null;
  branchMode: 'new' | 'existing';
  signal?: AbortSignal;
}>) => Promise<ScmWorktreeCreateResponse>;

async function createSessionCheckoutWithScm(input: Parameters<CreateSessionCheckout>[0]): Promise<ScmWorktreeCreateResponse> {
  if (input.branchMode === 'new') {
    const realized = await realizeWorkspaceCheckoutWithScmWorkspace({
      sourcePath: input.sourceDirectory,
      checkoutCreation: {
        kind: 'git_worktree',
        displayName: input.displayName,
        baseRef: input.baseRef,
        branchMode: input.branchMode,
      },
    });
    return realized
      ? {
          success: true,
          worktreePath: realized.targetPath,
          branchName: input.displayName,
        }
      : {
          success: false,
          worktreePath: '',
          branchName: '',
          errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        };
  }
  const request: ScmWorktreeCreateRequest = {
    cwd: input.sourceDirectory,
    displayName: input.displayName,
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    branchMode: input.branchMode,
  };
  return await runScmRoute<ScmWorktreeCreateRequest, ScmWorktreeCreateResponse>({
    request,
    workingDirectory: input.sourceDirectory,
    ...(input.signal ? { signal: input.signal } : {}),
    onNonRepository: async () => notRepositoryResponse<ScmWorktreeCreateResponse>(),
    runWithBackend: async ({ context, selection }) =>
      await selection.backend.worktreeCreate({ context, request }),
  });
}

function isCheckoutUnavailable(errorCode: string | undefined): boolean {
  return errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY
    || errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
    || errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE;
}

/**
 * Target-daemon owner for the immutable execution directory. Callers never
 * interpret another machine's home directory or synthesize worktree paths.
 */
export async function prepareSessionCreationTarget(input: Readonly<{
  request: SessionCreationTargetPreparationRequestV1;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Test seam; production always delegates through the canonical SCM owner. */
  createCheckout?: CreateSessionCheckout;
}>): Promise<SessionCreationTargetPreparationResultV1> {
  const request = SessionCreationTargetPreparationRequestV1Schema.parse(input.request);
  const canonicalSource = resolveCanonicalAbsolutePath(request.directory, {
    env: input.env,
    platform: input.platform,
  });
  if (!canonicalSource) {
    return { ok: false, code: 'invalid_directory' };
  }

  const draft = request.checkoutCreationDraft;
  if (!draft) {
    input.signal?.throwIfAborted();
    const directoryReadiness = await ensureSessionDirectory({
      directory: canonicalSource.path,
      approvedNewDirectoryCreation: false,
    });
    input.signal?.throwIfAborted();
    return SessionCreationTargetPreparationResultV1Schema.parse({
      ok: true,
      directory: canonicalSource.path,
      directoryCreationRequired: !directoryReadiness.ok,
      checkout: null,
    });
  }

  input.signal?.throwIfAborted();
  let checkoutResult: ScmWorktreeCreateResponse;
  try {
    checkoutResult = await (input.createCheckout ?? createSessionCheckoutWithScm)({
      sourceDirectory: canonicalSource.path,
      displayName: draft.displayName,
      baseRef: draft.baseRef ?? null,
      branchMode: draft.branchMode ?? 'new',
      signal: input.signal,
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    return { ok: false, code: 'checkout_failed' };
  }
  if (!checkoutResult.success) {
    return {
      ok: false,
      code: isCheckoutUnavailable(checkoutResult.errorCode)
        ? 'checkout_unavailable'
        : 'checkout_failed',
    };
  }

  const canonicalFinal = resolveCanonicalAbsolutePath(checkoutResult.worktreePath, {
    env: input.env,
    platform: input.platform,
  });
  if (!canonicalFinal) {
    return { ok: false, code: 'checkout_failed' };
  }
  return SessionCreationTargetPreparationResultV1Schema.parse({
    ok: true,
    directory: canonicalFinal.path,
    // SCM owns worktree materialization. A worktree request never delegates a
    // raw directory mkdir to the Session-spawn authorization path.
    directoryCreationRequired: false,
    checkout: {
      kind: 'git_worktree',
      finalDirectory: canonicalFinal.path,
      baseRef: draft.baseRef ?? null,
      branchMode: draft.branchMode ?? 'new',
    },
  });
}
