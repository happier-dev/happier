import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import { buildGithubRepositoryKey } from './locator.js';
import type { GithubTriageFailureV1 } from './types.js';

/**
 * The GitHub source-private configured-instance token.
 *
 * The target bounds, copies and returns these bytes without parsing them, so this
 * module is the ONLY decoder: a malformed, foreign or truncated token is an
 * `unsupportedContract` failure rather than a guessed scope. It carries no
 * credential, no origin, no account ref and no filesystem path — the Connected
 * Account binding is a separate member of the configured instance, and re-encoding
 * it here would create a second account-identity carrier.
 */

/**
 * GitHub's only admitted deployment today is `github.com`, so a configured GitHub
 * instance is either the account's whole reachable surface or one repository inside
 * it. The repository arm holds the mutable locator half (`owner/name`) because that
 * is what a lane query and a `get` route need; it is never an identity component.
 */
export type GithubTriageInstanceScopeV1 =
  | Readonly<{ kind: 'account' }>
  | Readonly<{ kind: 'repository'; repositoryKey: string }>;

export type GithubTriageConfigurationV1 = Readonly<{
  v: 1;
  scope: GithubTriageInstanceScopeV1;
}>;

export type GithubTriageConfigurationDecodeV1 =
  | Readonly<{ ok: true; configuration: GithubTriageConfigurationV1 }>
  | Readonly<{ ok: false; failure: GithubTriageFailureV1 }>;

/**
 * The source-native instance/scope key. GitHub's deployment host is the whole
 * source-native scope of a candidate: the repository selection is a later explicit
 * Settings reconfiguration, not a discovery fact. It never re-encodes the purpose or
 * the account ref, so two accounts observing github.com stay two configured
 * instances that share one canonical entry identity.
 */
export const GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1 = 'github.com';

/**
 * The forge DEPLOYMENT an entry from this source belongs to.
 *
 * Derived from the admitted deployment above rather than written twice: if
 * GitHub Enterprise is ever admitted, this constant is one of the two places
 * that must move together, and a per-instance deployment becomes a configured
 * fact instead of a constant. It is the same string a project's resolved
 * `ScmHostingProviderRef.baseUrl` canonicalizes to, which is what makes the two
 * halves of launch placement comparable by equality.
 */
export const GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1 = `https://${GITHUB_TRIAGE_LOCAL_INSTANCE_KEY_V1}`;

const CONFIGURATION_DECODE_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_configuration_invalid',
});

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The account-wide GitHub scope every discovery candidate proposes. */
export const GITHUB_TRIAGE_ACCOUNT_SCOPE_V1: GithubTriageConfigurationV1 = Object.freeze({
  v: 1,
  scope: Object.freeze({ kind: 'account' }),
});

export function encodeGithubTriageConfiguration(
  configuration: GithubTriageConfigurationV1,
): string | null {
  const token = JSON.stringify(
    configuration.scope.kind === 'account'
      ? { v: 1, scope: { kind: 'account' } }
      : { v: 1, scope: { kind: 'repository', repositoryKey: configuration.scope.repositoryKey } },
  );
  return utf8ByteLength(token) <= MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 ? token : null;
}

export function decodeGithubTriageConfiguration(token: unknown): GithubTriageConfigurationDecodeV1 {
  const failure = Object.freeze({ ok: false as const, failure: CONFIGURATION_DECODE_FAILURE });
  if (typeof token !== 'string' || utf8ByteLength(token) > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return failure;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return failure;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.scope)) return failure;
  const scope = parsed.scope;
  if (scope.kind === 'account') {
    return Object.freeze({ ok: true as const, configuration: GITHUB_TRIAGE_ACCOUNT_SCOPE_V1 });
  }
  if (scope.kind !== 'repository' || typeof scope.repositoryKey !== 'string') return failure;
  const segments = scope.repositoryKey.split('/');
  const repositoryKey = segments.length === 2
    ? buildGithubRepositoryKey({ owner: segments[0], name: segments[1] })
    : null;
  if (repositoryKey === null) return failure;
  return Object.freeze({
    ok: true as const,
    configuration: Object.freeze({
      v: 1 as const,
      scope: Object.freeze({ kind: 'repository' as const, repositoryKey }),
    }),
  });
}

/** The lane-query scope: `owner/name` for a repository instance, `null` account-wide. */
export function readGithubScanRepositoryKey(
  configuration: GithubTriageConfigurationV1,
): string | null {
  return configuration.scope.kind === 'repository' ? configuration.scope.repositoryKey : null;
}
