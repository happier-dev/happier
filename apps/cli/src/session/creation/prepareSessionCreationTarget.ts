import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol/scm/worktrees';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { ScmWorktreeCreateResponse, ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse, SessionCreationPreparedCheckoutV1, SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';

import { notRepositoryResponse, runScmRoute } from '@/scm/rpc/dispatch';
import { realizeWorkspaceCheckoutWithScmWorkspaceSource } from '@/scm/workspace';
import { ensureSessionDirectory } from '@/daemon/startup/ensureSessionDirectory';
import { createManagedSessionDirectories } from './managedSessionDirectories';
import {
  isCanonicalAbsolutePathInsideRoot,
  resolveCanonicalAbsolutePath,
} from '@/utils/path/expandHomeDirPath';

type SessionCheckoutCreationResult = ScmWorktreeCreateResponse & Readonly<{
  created?: boolean;
}>;

type CreateSessionCheckout = (input: Readonly<{
  sourceDirectory: string;
  displayName: string;
  baseRef: string | null;
  branchMode: 'new' | 'existing';
  signal?: AbortSignal;
}>) => Promise<SessionCheckoutCreationResult>;

async function createSessionCheckoutWithScm(input: Parameters<CreateSessionCheckout>[0]): Promise<SessionCheckoutCreationResult> {
  const resolved = await realizeWorkspaceCheckoutWithScmWorkspaceSource({
    sourcePath: input.sourceDirectory,
    checkoutCreation: {
      kind: 'git_worktree',
      displayName: input.displayName,
      baseRef: input.baseRef,
      branchMode: input.branchMode,
    },
  });
  const result = resolved
    ? {
        success: true as const,
        worktreePath: resolved.realization.targetPath,
        branchName: resolved.realization.branchName,
        sourceRootPath: resolved.sourceRootPath,
        created: resolved.realization.created,
      }
    : {
        success: false as const,
        worktreePath: '',
        branchName: '',
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
      };
  return result;
}

function isCheckoutUnavailable(errorCode: string | undefined): boolean {
  return errorCode === SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY
    || errorCode === SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED
    || errorCode === SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE;
}

export async function resolveSessionDirectoryInCheckout(input: Readonly<{
  sourceDirectory: string;
  sourceRootPath: string | undefined;
  checkoutRootPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>): Promise<string> {
  const platform = input.platform ?? process.platform;
  const sourceRoot = input.sourceRootPath
    ? resolveCanonicalAbsolutePath(input.sourceRootPath, {
        env: input.env,
        platform,
      })
    : null;
  const sourceDirectory = resolveCanonicalAbsolutePath(input.sourceDirectory, {
    env: input.env,
    platform,
  });
  const checkoutRoot = resolveCanonicalAbsolutePath(input.checkoutRootPath, {
    env: input.env,
    platform,
  });
  if (
    !sourceRoot
    || !sourceDirectory
    || !checkoutRoot
  ) {
    return checkoutRoot?.path ?? input.checkoutRootPath;
  }

  const resolveExistingPath = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  };
  const [existingSourceRoot, existingSourceDirectory] = await Promise.all([
    resolveExistingPath(sourceRoot.path),
    resolveExistingPath(sourceDirectory.path),
  ]);
  if (!isCanonicalAbsolutePathInsideRoot(existingSourceRoot, existingSourceDirectory, { platform })) {
    return checkoutRoot.path;
  }

  const pathApi = platform === 'win32' ? win32 : posix;
  const relativeSourcePath = pathApi.relative(existingSourceRoot, existingSourceDirectory);
  if (!relativeSourcePath) {
    return checkoutRoot.path;
  }
  const candidate = resolveCanonicalAbsolutePath(
    pathApi.resolve(checkoutRoot.path, relativeSourcePath),
    { env: input.env, platform },
  );
  return candidate
    && isCanonicalAbsolutePathInsideRoot(checkoutRoot.path, candidate.path, { platform })
    ? candidate.path
    : checkoutRoot.path;
}

/**
 * Compensates only a checkout this exact preparation proved it created. The
 * canonical SCM remove operation retains confirmation and path validation;
 * missing, reused, or older receipts are deliberate no-ops.
 */
export async function rollbackSessionCreationTargetCheckout(
  checkout: SessionCreationPreparedCheckoutV1,
): Promise<void> {
  if (checkout.created !== true) return;
  const request: ScmWorktreeRemoveRequest = {
    cwd: checkout.finalDirectory,
    worktreePath: checkout.finalDirectory,
    confirmed: true,
    authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
  };
  const response = await runScmRoute<ScmWorktreeRemoveRequest, ScmWorktreeRemoveResponse>({
    request,
    workingDirectory: checkout.finalDirectory,
    onNonRepository: async () => notRepositoryResponse<ScmWorktreeRemoveResponse>(),
    runWithBackend: async ({ context, selection }) =>
      await selection.backend.worktreeRemove({ context, request }),
  });
  if (!response.success) {
    throw new Error(response.error || 'Failed to roll back prepared Session checkout');
  }
}

/**
 * Target-daemon owner for the immutable execution directory. Callers never
 * interpret another machine's home directory or synthesize worktree paths.
 */
export async function prepareSessionCreationTarget(input: Readonly<{
  request: SessionCreationTargetPreparationRequestV1;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Target-daemon configuration boundary; absent uses the active server namespace. */
  activeServerDir?: string;
  signal?: AbortSignal;
  /** Test seam; production always delegates through the canonical SCM owner. */
  createCheckout?: CreateSessionCheckout;
}>): Promise<SessionCreationTargetPreparationResultV1> {
  const request = SessionCreationTargetPreparationRequestV1Schema.parse(input.request);
  if (request.directory.kind === 'managed') {
    if (!request.sessionCreationTag) return { ok: false, code: 'invalid_directory' };
    const target = createManagedSessionDirectories({ activeServerDir: input.activeServerDir, platform: input.platform }).prepareForCreation({
      sessionCreationTag: request.sessionCreationTag,
    });
    return SessionCreationTargetPreparationResultV1Schema.parse({
      ok: true, directory: target.directory, directoryKind: 'managed', directoryCreationRequired: false, checkout: null,
    });
  }
  const canonicalSource = resolveCanonicalAbsolutePath(request.directory.path, {
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
      directoryKind: 'path',
      directoryCreationRequired: !directoryReadiness.ok,
      checkout: null,
    });
  }

  input.signal?.throwIfAborted();
  let checkoutResult: SessionCheckoutCreationResult;
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
    directoryKind: 'path',
    directory: await resolveSessionDirectoryInCheckout({
      sourceDirectory: canonicalSource.path,
      sourceRootPath: checkoutResult.sourceRootPath,
      checkoutRootPath: canonicalFinal.path,
      env: input.env,
      platform: input.platform,
    }),
    // SCM owns worktree materialization. A worktree request never delegates a
    // raw directory mkdir to the Session-spawn authorization path.
    directoryCreationRequired: false,
    checkout: {
      kind: 'git_worktree',
      finalDirectory: canonicalFinal.path,
      baseRef: draft.baseRef ?? null,
      branchMode: draft.branchMode ?? 'new',
      ...(typeof checkoutResult.created === 'boolean'
        ? { created: checkoutResult.created }
        : {}),
    },
  });
}
