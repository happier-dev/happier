import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';

export class GithubRepositoryProvisioningError extends Error {
  readonly errorCode: ScmOperationErrorCode;

  constructor(message: string, errorCode: ScmOperationErrorCode) {
    super(message);
    this.name = 'GithubRepositoryProvisioningError';
    this.errorCode = errorCode;
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
