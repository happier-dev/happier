/**
 * The sole owner of the Sentry collision scope (`SENTRY.md` §2.4a).
 *
 * `collisionScope = <normalized canonical deploymentOrigin> U+001F <immutable
 * organization numeric id>`. A Group id alone can collide across deployments,
 * and the public contract establishes no cross-organization uniqueness, so both
 * components are required. Mutable locator fields — organization/project slugs,
 * `shortId`, `permalink`, display names — are excluded by construction, as is
 * the exact Connected Account, which is observation authority rather than
 * identity.
 *
 * The scope is derived from the exact invoked instance and validated against the
 * route actually invoked; it is never caller-supplied or recomputed from a
 * response body.
 */

import {
  SENTRY_FAILURE_CODES,
  SENTRY_SCOPE_SEPARATOR,
  type SentryFailureV1,
} from '../sentryContracts.js';

import { normalizeSentryOrigin } from '../auth/sentryOrigin.js';

export type SentryInvokedInstanceV1 = Readonly<{
  deploymentOrigin: string;
  organizationId: string;
}>;

export type SentryInvokedScopeResultV1 =
  | Readonly<{ ok: true; collisionScope: string }>
  | Readonly<{ ok: false; failure: SentryFailureV1 }>;

/** `[SCHEMA]` the organization `id` is the numeric primary key, not the slug. */
export const SENTRY_NUMERIC_ID_PATTERN = /^[1-9]\d{0,18}$/u;

export function isSentryNumericId(value: string): boolean {
  return SENTRY_NUMERIC_ID_PATTERN.test(value);
}

export function deriveSentryCollisionScope(instance: SentryInvokedInstanceV1): string {
  const normalized = normalizeSentryOrigin(instance.deploymentOrigin);
  if (!normalized.ok || normalized.origin !== instance.deploymentOrigin) {
    throw new Error('A Sentry collision scope requires an already-normalized canonical origin.');
  }
  if (!isSentryNumericId(instance.organizationId)) {
    throw new Error('A Sentry collision scope requires the immutable numeric organization id.');
  }
  return `${normalized.origin}${SENTRY_SCOPE_SEPARATOR}${instance.organizationId}`;
}

const ORGANIZATION_ROUTE_PATTERN = /^\/api\/0\/organizations\/([^/]+)(?:\/|$)/u;

/**
 * Validates that the route about to be, or just, invoked belongs to the exact
 * configured instance. If invocation A's configuration binds origin/organization
 * A and the route names B, mapping fails closed before an observation exists.
 */
export function resolveSentryInvokedScope(input: Readonly<{
  configured: SentryInvokedInstanceV1;
  requestUrl: string;
}>): SentryInvokedScopeResultV1 {
  const originMismatch = Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.invokedOriginMismatch,
    }),
  });
  const organizationMismatch = Object.freeze({
    ok: false as const,
    failure: Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.invokedOrganizationMismatch,
    }),
  });

  let url: URL;
  try {
    url = new URL(input.requestUrl);
  } catch {
    return originMismatch;
  }
  if (url.origin !== input.configured.deploymentOrigin) return originMismatch;

  const routed = ORGANIZATION_ROUTE_PATTERN.exec(url.pathname)?.[1];
  if (routed === undefined || routed !== input.configured.organizationId) {
    return organizationMismatch;
  }

  return Object.freeze({
    ok: true as const,
    collisionScope: deriveSentryCollisionScope(input.configured),
  });
}
