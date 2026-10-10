import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { ScmWorktreeCreateResponse, SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol';

import { realizeWorkspaceCheckoutWithScmWorkspaceSource } from '@/scm/workspace';
import { ensureSessionDirectory } from '@/daemon/startup/ensureSessionDirectory';
import { createManagedSessionDirectories } from './managedSessionDirectories';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { DirectoryInCheckoutError, resolveDirectoryInCheckout } from '@/workspaces/activation/resolveDirectoryInCheckout';

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
  let directory: string;
  try {
    directory = await resolveDirectoryInCheckout({
      sourceDirectory: canonicalSource.path,
      sourceRootPath: checkoutResult.sourceRootPath,
      checkoutRootPath: canonicalFinal.path,
      env: input.env,
      platform: input.platform,
    });
  } catch (error) {
    if (error instanceof DirectoryInCheckoutError) return { ok: false, code: 'invalid_directory' };
    throw error;
  }
  return SessionCreationTargetPreparationResultV1Schema.parse({
    ok: true,
    directoryKind: 'path',
    directory,
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
