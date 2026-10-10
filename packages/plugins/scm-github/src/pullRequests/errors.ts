import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';

import { describeGithubRateLimitFailure } from '../observations/githubResponseFailure.js';

export class GithubPullRequestAdapterError extends Error {
  readonly errorCode: ScmOperationErrorCode;
  readonly retryNotBeforeMs?: number;

  constructor(message: string, errorCode: ScmOperationErrorCode, retryNotBeforeMs?: number) {
    super(message);
    this.name = 'GithubPullRequestAdapterError';
    this.errorCode = errorCode;
    this.retryNotBeforeMs = retryNotBeforeMs;
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

/**
 * A GitHub throttle is a typed remote limit, never a credential the
 * owner must repair. `isGithubAuthRequiredError` drives reconnect affordances, so
 * classifying a throttle as authentication sends the owner to fix an account that
 * works and hides the retry instruction GitHub actually supplied.
 */
export function createGithubRateLimitedError(
  retryNotBeforeMs: number | undefined,
): GithubPullRequestAdapterError {
  return new GithubPullRequestAdapterError(
    describeGithubRateLimitFailure(retryNotBeforeMs),
    SCM_OPERATION_ERROR_CODES.REMOTE_RATE_LIMITED,
    retryNotBeforeMs,
  );
}

export function createGithubUnsupportedError(message = 'GitHub pull request operation is unsupported'): GithubPullRequestAdapterError {
  return new GithubPullRequestAdapterError(message, SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

export function isGithubAuthRequiredError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
}
