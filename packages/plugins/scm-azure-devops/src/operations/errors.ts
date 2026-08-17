import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';

export class AzureDevopsAdapterError extends Error {
  readonly errorCode: ScmOperationErrorCode;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;

  constructor(
    message: string,
    errorCode: ScmOperationErrorCode,
    details?: Readonly<{
      pullRequestNumber?: number;
      pullRequestUrl?: string;
    }>,
  ) {
    super(message);
    this.name = 'AzureDevopsAdapterError';
    this.errorCode = errorCode;
    if (details?.pullRequestNumber !== undefined) this.pullRequestNumber = details.pullRequestNumber;
    if (details?.pullRequestUrl !== undefined) this.pullRequestUrl = details.pullRequestUrl;
  }
}

export function createAzureInvalidRequestError(message: string): AzureDevopsAdapterError {
  return new AzureDevopsAdapterError(message, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
}

export function createAzureAuthRequiredError(message = 'Azure DevOps authentication is required'): AzureDevopsAdapterError {
  return new AzureDevopsAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
}

export function createAzureNotFoundError(message = 'Azure DevOps resource was not found'): AzureDevopsAdapterError {
  return new AzureDevopsAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
}

export function createAzureCommandFailedError(message = 'Azure DevOps operation failed'): AzureDevopsAdapterError {
  return new AzureDevopsAdapterError(message, SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

export function createAzureUnsupportedError(message = 'Azure CLI is unavailable'): AzureDevopsAdapterError {
  return new AzureDevopsAdapterError(message, SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

export function createAzureDuplicatePullRequestError(input: Readonly<{
  message?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}>): AzureDevopsAdapterError {
  return new AzureDevopsAdapterError(
    input.message ?? 'Azure DevOps pull request already exists',
    SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
    {
      ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
      ...(input.pullRequestUrl !== undefined ? { pullRequestUrl: input.pullRequestUrl } : {}),
    },
  );
}
