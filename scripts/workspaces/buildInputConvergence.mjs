/** A successful phase consumed inputs that moved before its commit fence. */
export class BuildInputDriftError extends Error {
  /** @param {string} message @param {{ cause?: unknown, trailingPassExhausted?: boolean }} [options] */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'BuildInputDriftError';
    this.code = 'BUILD_INPUTS_CHANGED';
    this.trailingPassExhausted = options.trailingPassExhausted ?? false;
  }
}

/** A failed compiler/projection command is not evidence of input drift. */
export class WorkspacePackageBuildError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkspacePackageBuildError';
    // Preserve the process owner's existing timeout/exit diagnostic contract.
    this.code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
      ? cause.code : 'WORKSPACE_PACKAGE_BUILD_FAILED';
  }
}

/** @param {unknown} error @returns {error is BuildInputDriftError | WorkspacePackageBuildError} */
export function isTerminalBuildFailure(error) {
  return error instanceof WorkspacePackageBuildError
    || (error instanceof BuildInputDriftError && error.trailingPassExhausted);
}

/** Preserve terminal phase failures through the generator's existing IPC. */
/** @param {unknown} error */
export function serializeTerminalBuildFailure(error) {
  if (!isTerminalBuildFailure(error)) return null;
  return { buildFailure: {
    code: error instanceof BuildInputDriftError ? 'BUILD_INPUTS_CHANGED' : 'WORKSPACE_PACKAGE_BUILD_FAILED',
    message: error.message,
    ...(error instanceof BuildInputDriftError ? { trailingPassExhausted: true } : {}),
  } };
}

/** @param {unknown} value */
export function readTerminalBuildFailure(value) {
  if (!value || typeof value !== 'object' || !('buildFailure' in value)) return null;
  const failure = value.buildFailure;
  if (!failure || typeof failure !== 'object' || !('message' in failure) || typeof failure.message !== 'string'
    || !('code' in failure)) throw new Error('Invalid private build failure result');
  if (failure.code === 'WORKSPACE_PACKAGE_BUILD_FAILED') return new WorkspacePackageBuildError(new Error(failure.message));
  if (failure.code === 'BUILD_INPUTS_CHANGED' && 'trailingPassExhausted' in failure && failure.trailingPassExhausted === true) {
    return new BuildInputDriftError(failure.message, { trailingPassExhausted: true });
  }
  throw new Error('Invalid private build failure result');
}

/**
 * One initial pass and one trailing pass, shared by workspace preparation and
 * generator publication. An exhausted nested phase cannot restart this bound.
 * @template T
 * @param {{ run: (trailing: boolean) => Promise<T>, onTrailingPass?: (error: BuildInputDriftError) => void }} input
 * @returns {Promise<T>}
 */
export async function withSingleTrailingBuildPass(input) {
  for (const trailing of [false, true]) {
    try {
      return await input.run(trailing);
    } catch (error) {
      if (!(error instanceof BuildInputDriftError) || error.trailingPassExhausted) throw error;
      if (trailing) {
        throw new BuildInputDriftError(error.message, { cause: error, trailingPassExhausted: true });
      }
      input.onTrailingPass?.(error);
    }
  }
  throw new Error('Unreachable build convergence state');
}
