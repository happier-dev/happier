import { SCM_OPERATION_ERROR_CODES, type ScmOperationErrorCode } from '@happier-dev/plugin-sdk/scm';
import type { HostingProviderRepositoryGetInput } from '@happier-dev/plugin-sdk/scm/hosting';
import { normalizeGitlabConfiguredBaseUrl } from './triage/origin.js';
import { requestGitlabJson, type GitlabRequestInput } from './triage/http/gitlabClient.js';

export class GitlabHostingError extends Error {
  constructor(message: string, readonly errorCode: ScmOperationErrorCode, readonly effectNotApplied = false) {
    super(message);
    this.name = 'GitlabHostingError';
  }
}

export async function authorizeGitlabHosting(input: Pick<HostingProviderRepositoryGetInput, 'provider' | 'runtimeServices' | 'signal'>) {
  const origin = normalizeGitlabConfiguredBaseUrl(input.provider.baseUrl);
  if (!origin) {
    throw new GitlabHostingError('GitLab deployment or repository identity is unavailable.', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, true);
  }
  const signal = input.signal ?? new AbortController().signal;
  const resolveToken = input.runtimeServices?.resolveScmHostingTokenMaterialization;
  if (!resolveToken) throw new GitlabHostingError('Connect a GitLab account for this deployment.', SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED, true);
  const auth = await resolveToken({
    kind: 'scm_hosting_token', providerId: input.provider.id, host: origin.forgeHostId, provider: input.provider,
  }, { signal });
  if (auth.kind !== 'available' || !auth.token.trim()) {
    throw new GitlabHostingError('Connect a GitLab account for this deployment.', SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED, true);
  }
  return {
    origin, signal,
    invocation: { origin, headers: { Accept: 'application/json', Authorization: `Bearer ${auth.token}` } },
  };
}

export async function requestGitlabHosting(input: Omit<GitlabRequestInput, 'fetcher' | 'nowMs'>) {
  const result = await requestGitlabJson({ ...input, fetcher: (url, init) => fetch(url, init), nowMs: Date.now() });
  if (result.kind === 'ok') return result.response;
  const errorCode = result.failure.class === 'authentication' || result.failure.class === 'permission'
    ? SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED
    : result.failure.code === 'not-found' ? SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND
    : result.failure.class === 'rateLimit' || result.failure.class === 'transient' ? SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE
    : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED;
  // A provider's definite client rejection proves no creation occurred. A lost
  // transport, server error, cancellation, or unreadable success does not.
  const effectNotApplied = result.status !== undefined && result.status >= 400 && result.status < 500 && result.status !== 408;
  throw new GitlabHostingError('GitLab hosting operation did not return a usable result.', errorCode, effectNotApplied);
}
