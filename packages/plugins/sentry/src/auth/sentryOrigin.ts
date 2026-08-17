/**
 * Deployment-origin resolution (`SENTRY.md` §2.3).
 *
 * A Cloud connection's non-secret `region` selects exactly one documented API
 * deployment; a self-hosted connection carries its own canonical origin. The
 * source never calls neutral `https://sentry.io`, never fans out across regions,
 * and never promotes a response URL into routing authority: `links.regionUrl` is
 * a consistency check only, and its absence never replaces configuration.
 */

import {
  SENTRY_CLOUD_REGION_ORIGINS,
  SENTRY_FAILURE_CODES,
  type SentryCloudRegionV1,
  type SentryFailureV1,
} from '../sentryContracts.js';

export type SentryDeploymentV1 =
  | Readonly<{ kind: 'cloud'; region: SentryCloudRegionV1; origin: string }>
  | Readonly<{ kind: 'selfHosted'; origin: string }>;

export type SentryOriginRejectionReasonV1 =
  | 'region-unsupported'
  | 'origin-not-canonical'
  | 'origin-scheme-unsupported'
  | 'origin-carries-credentials';

export type SentryDeploymentResultV1 =
  | Readonly<{ ok: true; deployment: SentryDeploymentV1 }>
  | Readonly<{ ok: false; reason: SentryOriginRejectionReasonV1 }>;

export type SentryRegionUrlCheckV1 =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; failure: SentryFailureV1 }>;

function isSupportedRegion(value: string): value is SentryCloudRegionV1 {
  return Object.hasOwn(SENTRY_CLOUD_REGION_ORIGINS, value);
}

export function resolveSentryCloudDeployment(region: string): SentryDeploymentResultV1 {
  if (!isSupportedRegion(region)) {
    return Object.freeze({ ok: false as const, reason: 'region-unsupported' as const });
  }
  return Object.freeze({
    ok: true as const,
    deployment: Object.freeze({
      kind: 'cloud' as const,
      region,
      origin: SENTRY_CLOUD_REGION_ORIGINS[region],
    }),
  });
}

/**
 * Mirrors the host's `CanonicalHttpOriginSchema`: an http/https origin with no
 * credentials, no path, no query and no fragment. A pasted trailing slash is
 * normalized away; anything else is refused rather than silently reinterpreted.
 */
export function normalizeSentryOrigin(
  rawOrigin: string,
): Readonly<{ ok: true; origin: string }> | Readonly<{ ok: false; reason: SentryOriginRejectionReasonV1 }> {
  const trimmed = rawOrigin.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return Object.freeze({ ok: false as const, reason: 'origin-not-canonical' as const });
  }
  if (url.username !== '' || url.password !== '') {
    return Object.freeze({ ok: false as const, reason: 'origin-carries-credentials' as const });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return Object.freeze({ ok: false as const, reason: 'origin-scheme-unsupported' as const });
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return Object.freeze({ ok: false as const, reason: 'origin-not-canonical' as const });
  }
  if (url.origin === 'null') {
    return Object.freeze({ ok: false as const, reason: 'origin-not-canonical' as const });
  }
  return Object.freeze({ ok: true as const, origin: url.origin });
}

export function resolveSentrySelfHostedDeployment(rawOrigin: string): SentryDeploymentResultV1 {
  const normalized = normalizeSentryOrigin(rawOrigin);
  if (!normalized.ok) {
    return Object.freeze({ ok: false as const, reason: normalized.reason });
  }
  return Object.freeze({
    ok: true as const,
    deployment: Object.freeze({ kind: 'selfHosted' as const, origin: normalized.origin }),
  });
}

/**
 * A present `links.regionUrl` must equal the configured deployment origin. An
 * absent value is accepted; a different or unparseable one is a per-instance
 * `unsupportedContract` failure and is never followed.
 */
export function checkSentryRegionUrlConsistency(
  deployment: SentryDeploymentV1,
  regionUrl: unknown,
): SentryRegionUrlCheckV1 {
  if (regionUrl === undefined || regionUrl === null) {
    return Object.freeze({ ok: true as const });
  }
  const undeclared = Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
    }),
  });
  if (typeof regionUrl !== 'string') return undeclared;
  const normalized = normalizeSentryOrigin(regionUrl);
  if (!normalized.ok || normalized.origin !== deployment.origin) return undeclared;
  return Object.freeze({ ok: true as const });
}
