import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';

export class GithubPullRequestAdapterError extends Error {
  readonly errorCode: ScmOperationErrorCode;

  constructor(message: string, errorCode: ScmOperationErrorCode) {
    super(message);
    this.name = 'GithubPullRequestAdapterError';
    this.errorCode = errorCode;
  }
}

export function createGithubAuthRequiredError(message = 'GitHub pull request authentication is required'): GithubPullRequestAdapterError {
  return new GithubPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
}

export function createGithubNotFoundError(message = 'GitHub pull request resource was not found'): GithubPullRequestAdapterError {
  return new GithubPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
}

export function createGithubCommandFailedError(message = 'GitHub pull request operation failed'): GithubPullRequestAdapterError {
  return new GithubPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

export function createGithubUnsupportedError(message = 'GitHub pull request operation is unsupported'): GithubPullRequestAdapterError {
  return new GithubPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

export function isGithubAuthRequiredError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
}
