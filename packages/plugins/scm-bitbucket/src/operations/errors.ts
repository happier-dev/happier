import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
  type ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';

export class BitbucketApiAdapterError extends Error {
  readonly errorCode: ScmOperationErrorCode;
  readonly pullRequest?: ScmPullRequestSummary;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;

  constructor(
    message: string,
    errorCode: ScmOperationErrorCode,
    details?: Readonly<{
      pullRequest?: ScmPullRequestSummary;
      pullRequestNumber?: number;
      pullRequestUrl?: string;
    }>,
  ) {
    super(message);
    this.name = 'BitbucketApiAdapterError';
    this.errorCode = errorCode;
    if (details?.pullRequest) this.pullRequest = details.pullRequest;
    if (details?.pullRequestNumber !== undefined) this.pullRequestNumber = details.pullRequestNumber;
    if (details?.pullRequestUrl !== undefined) this.pullRequestUrl = details.pullRequestUrl;
  }
}

export function createBitbucketInvalidRequestError(message: string): BitbucketApiAdapterError {
  return new BitbucketApiAdapterError(message, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
}

export function createBitbucketAuthRequiredError(
  message = 'Bitbucket API authentication is required',
): BitbucketApiAdapterError {
  return new BitbucketApiAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
}

export function createBitbucketNotFoundError(
  message = 'Bitbucket API resource was not found',
): BitbucketApiAdapterError {
  return new BitbucketApiAdapterError(message, SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
}

export function createBitbucketCommandFailedError(
  message = 'Bitbucket API operation failed',
): BitbucketApiAdapterError {
  return new BitbucketApiAdapterError(message, SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

export function createBitbucketAlreadyExistsError(input?: Readonly<{
  message?: string;
  pullRequest?: ScmPullRequestSummary;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}>): BitbucketApiAdapterError {
  return new BitbucketApiAdapterError(
    input?.message ?? 'Bitbucket pull request already exists',
    SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
    {
      ...(input?.pullRequest ? { pullRequest: input.pullRequest } : {}),
      ...(input?.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
      ...(input?.pullRequestUrl !== undefined ? { pullRequestUrl: input.pullRequestUrl } : {}),
    },
  );
}

export function isBitbucketNotFoundError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
}

export function isBitbucketAlreadyExistsError(error: unknown): boolean {
  return Boolean(error)
    && typeof error === 'object'
    && (error as { errorCode?: unknown }).errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS;
}
