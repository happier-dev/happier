/**
 * The sole Sentry deployment-route authority (`SENTRY.md` §2.3, §2.4).
 *
 * A Sentry Action never decides where to send a request from display text, a
 * response body, a neutral origin, a regional fan-out, or a default. The only
 * routing input is the host-owned, credential-free `connectedAccountOrigins`
 * projection carried by the exact account returned from the bounded
 * `ConnectedAccountsService.listAccounts` metadata listing: for Cloud it is the
 * declared canonical region origin, for self-hosted the normalized configured
 * Account origin. This module classifies exactly that one value.
 */

import {
  SENTRY_CLOUD_REGION_ORIGINS,
  SENTRY_FAILURE_CODES,
  type SentryCloudRegionV1,
  type SentryFailureV1,
} from '../sentryContracts.js';

import {
  normalizeSentryOrigin,
  resolveSentryCloudDeployment,
  resolveSentrySelfHostedDeployment,
  type SentryDeploymentV1,
} from './sentryOrigin.js';

export type SentryAccountRouteResultV1 =
  | Readonly<{ ok: true; deployment: SentryDeploymentV1 }>
  | Readonly<{ ok: false; failure: SentryFailureV1 }>;

const UNDECLARED: SentryAccountRouteResultV1 = Object.freeze({
  ok: false as const,
  failure: Object.freeze({
    class: 'unsupportedContract' as const,
    code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
  }),
});

function cloudRegionOf(origin: string): SentryCloudRegionV1 | null {
  for (const [region, cloudOrigin] of Object.entries(SENTRY_CLOUD_REGION_ORIGINS)) {
    if (cloudOrigin === origin) return region as SentryCloudRegionV1;
  }
  return null;
}

/**
 * Classifies the exact account's projected configured origins into one routable
 * deployment.
 *
 * Zero projected origins means the host could not publish this account's
 * configured route, and more than one means the account declares no single
 * route. Both are the same honest refusal: this source has no second authority
 * to consult and will not pick, probe, or default one.
 */
export function resolveSentryAccountRoute(
  connectedAccountOrigins: readonly string[],
): SentryAccountRouteResultV1 {
  if (connectedAccountOrigins.length !== 1) return UNDECLARED;
  const [configured = ''] = connectedAccountOrigins;
  const normalized = normalizeSentryOrigin(configured);
  if (!normalized.ok || normalized.origin !== configured) return UNDECLARED;

  const region = cloudRegionOf(normalized.origin);
  const resolved = region === null
    ? resolveSentrySelfHostedDeployment(normalized.origin)
    : resolveSentryCloudDeployment(region);
  return resolved.ok
    ? Object.freeze({ ok: true as const, deployment: resolved.deployment })
    : UNDECLARED;
}
