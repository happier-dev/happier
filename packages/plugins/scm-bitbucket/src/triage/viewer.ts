import { BITBUCKET_CLOUD_API_BASE_URL, type BitbucketTriageApiClient } from './apiClient.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from './failures.js';
import { readBitbucketBracedUuid } from './identity.js';

/**
 * The current-user route. Atlassian's API-token contract publishes no scope census, so this read
 * establishes exactly one fact: the provider-native identity of the credential in hand.
 */
export function buildBitbucketViewerUrl(): string {
  return `${BITBUCKET_CLOUD_API_BASE_URL}/user`;
}

export type BitbucketViewer = Readonly<{
  accountUuid: string;
  nickname: string | null;
  displayName: string | null;
}>;

export type BitbucketViewerOutcome =
  | Readonly<{ ok: true; viewer: BitbucketViewer }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolves the viewer from the credential rather than from stored configuration.
 *
 * Both involvement lanes filter on a workspace-member UUID (§5.5), and that UUID belongs to the
 * credential, not to the configured workspace. Reading it per invocation keeps one identity carrier
 * and makes a reconnected or replaced credential correct without a configuration migration.
 */
export async function getBitbucketViewer(
  input: Readonly<{ client: BitbucketTriageApiClient; signal?: AbortSignal }>,
): Promise<BitbucketViewerOutcome> {
  const response = await input.client.requestJson({
    url: buildBitbucketViewerUrl(),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) return { ok: false, failure: response.failure };

  const body = response.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      failure: createBitbucketFailure('unsupportedContract', 'viewer-not-an-object'),
    };
  }
  const record = body as Record<string, unknown>;
  const accountUuid = readBitbucketBracedUuid(record.uuid);
  if (accountUuid === null) {
    return {
      ok: false,
      failure: createBitbucketFailure('unsupportedContract', 'viewer-identity-invalid'),
    };
  }
  return {
    ok: true,
    viewer: {
      accountUuid,
      nickname: readOptionalString(record.nickname),
      displayName: readOptionalString(record.display_name),
    },
  };
}
