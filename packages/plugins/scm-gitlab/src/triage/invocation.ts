/**
 * The bridge between one host invocation and the GitLab client seams.
 *
 * The host HTTP service is a genuine system boundary and is the only transport
 * this source uses. Nothing here holds material past the invocation: the fetcher
 * closes over the host service, never over a credential, and the authorized
 * headers stay inside the operation that requested them.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import {
  buildGitlabApiUrl,
  requestGitlabJson,
  type GitlabAuthorizedInvocation,
  type GitlabConnectedAccounts,
  type GitlabHttpFetcher,
} from './http/gitlabClient.js';
import { createGitlabResponseHeaders } from './http/gitlabHeaders.js';
import type { GitlabFailure } from './types.js';

const HTTP_TEXT_DECODER = new TextDecoder();

/** Adapts the host HTTP service to the client's narrow fetcher seam. */
export function createGitlabHttpFetcher(context: PluginInvocationContext): GitlabHttpFetcher {
  return async (url, init) => {
    const response = await context.services.http.request({
      url,
      method: 'GET',
      headers: init.headers,
      redirect: init.redirect,
    }, { signal: init.signal });
    return {
      status: response.status,
      statusText: '',
      headers: createGitlabResponseHeaders(response.headers),
      text: async () => HTTP_TEXT_DECODER.decode(response.body),
    };
  };
}

export function readGitlabConnectedAccounts(
  context: PluginInvocationContext,
): GitlabConnectedAccounts {
  return context.services.connectedAccounts;
}

/**
 * The authenticated account's own GitLab identity.
 *
 * `id` is required by the documented `approved_by_ids[]` lane and `username` is
 * how an item's author/assignee/reviewer arrays name the same person, so both
 * are read once per invocation from the one endpoint that returns them.
 */
export type GitlabViewerIdentity = Readonly<{
  userId: number;
  username: string;
}>;

export type GitlabViewerIdentityResult =
  | Readonly<{ kind: 'identified'; viewer: GitlabViewerIdentity }>
  | Readonly<{ kind: 'failed'; failure: GitlabFailure }>;

export async function readGitlabViewerIdentity(input: Readonly<{
  invocation: GitlabAuthorizedInvocation;
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  nowMs: number;
}>): Promise<GitlabViewerIdentityResult> {
  const result = await requestGitlabJson({
    invocation: input.invocation,
    url: buildGitlabApiUrl(input.invocation.origin, '/user'),
    fetcher: input.fetcher,
    signal: input.signal,
    nowMs: input.nowMs,
  });
  if (result.kind === 'failed') return { kind: 'failed', failure: result.failure };

  const body = result.response.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'unexpected-viewer-shape' },
    };
  }
  const record = body as Readonly<Record<string, unknown>>;
  const userId = record.id;
  const username = record.username;
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0
    || typeof username !== 'string' || username.trim() === '') {
    return {
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'unexpected-viewer-shape' },
    };
  }
  return { kind: 'identified', viewer: { userId, username: username.trim() } };
}
