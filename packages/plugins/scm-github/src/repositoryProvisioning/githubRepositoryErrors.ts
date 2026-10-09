import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
  type ScmRepositoryCloneOutput,
} from '@happier-dev/plugin-sdk/scm';

import { describeGithubRateLimitFailure } from '../observations/githubResponseFailure.js';

type ProvisioningFailure = Extract<ScmRepositoryCloneOutput, { success: false }>;

export class GithubRepositoryProvisioningError extends Error {
  readonly errorCode: ScmOperationErrorCode;
  readonly retryNotBeforeMs?: number;
  readonly remediation?: ProvisioningFailure['remediation'];

  constructor(message: string, errorCode: ScmOperationErrorCode,
    details?: Pick<ProvisioningFailure, 'retryNotBeforeMs' | 'remediation'>) {
    super(message);
    this.name = 'GithubRepositoryProvisioningError';
    this.errorCode = errorCode;
    this.retryNotBeforeMs = details?.retryNotBeforeMs;
    this.remediation = details?.remediation;
  }
}

export function createGithubRepositoryAuthRequiredError(
  message = 'GitHub repository authentication is required',
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(message, SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
}

export function createGithubRepositoryNotFoundError(
  message = 'GitHub repository was not found',
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(message, SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
}

export function createGithubRepositoryCommandFailedError(
  message = 'GitHub repository operation failed',
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(message, SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

export function createGithubRepositoryRemoteRejectedError(
  message = 'GitHub repository operation was rejected',
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(message, SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED);
}

export function createGithubRepositoryAlreadyExistsError(
  message = 'GitHub repository already exists',
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(message, SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS);
}

/**
 * Keep the forge's retry hint distinct from backend availability and auth failure.
 */
export function createGithubRepositoryRateLimitedError(
  retryNotBeforeMs: number | undefined,
  anonymous = false,
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(
    describeGithubRateLimitFailure(retryNotBeforeMs),
    SCM_OPERATION_ERROR_CODES.REMOTE_RATE_LIMITED,
    { ...(retryNotBeforeMs !== undefined ? { retryNotBeforeMs } : {}),
      remediation: { kind: 'retry', ...(anonymous ? { action: 'connect_github' } : {}) } },
  );
}

export function createGithubRepositoryUnsupportedError(
  message = 'GitHub repository operation is unsupported',
): GithubRepositoryProvisioningError {
  return new GithubRepositoryProvisioningError(message, SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

export function isGithubRepositoryAuthRequiredError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
}

export function isGithubRepositoryNotFoundError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
}
