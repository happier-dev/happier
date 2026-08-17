/**
 * Organization-listing parsing (`SENTRY.md` §2.4).
 *
 * **`access` and `features` are optional, and their absence is never a denial.**
 * The published schema lists both, but `[SOURCE]`
 * `serializers/models/organization.py` populates `features` only when
 * `include_feature_flags` is true and `access` only when an access object is
 * supplied, and `[SOURCE]` `organization_index.py` serializes this listing with
 * feature flags disabled and no access argument on both silo branches. A strict
 * parser therefore rejects current OSS and self-hosted responses outright, and a
 * parser that defaults the fields to `[]` concludes that every organization lacks
 * `event:read`. Absent decodes as **unknown**, and the permission answer comes
 * from the first real call.
 *
 * The array is an untrusted provider batch, not one all-or-nothing DTO: each row
 * is parsed independently and malformed siblings are skipped rather than
 * rejecting valid ones.
 */

import { SENTRY_FAILURE_CODES, type SentryFailureV1 } from '../sentryContracts.js';
import { checkSentryRegionUrlConsistency, type SentryDeploymentV1 } from '../auth/sentryOrigin.js';

import { isSentryNumericId } from './sentryCollisionScope.js';

export type SentryOrganizationV1 = Readonly<{
  organizationId: string;
  slug: string | null;
  name: string | null;
  statusId: string | null;
  /** null means the deployment did not emit `access`, never "no scopes". */
  grantedScopes: readonly string[] | null;
  /** null means the deployment did not emit `features`, never "no features". */
  features: readonly string[] | null;
}>;

export type SentryOrganizationsPageV1 = Readonly<{
  organizations: readonly SentryOrganizationV1[];
  malformedRowCount: number;
  failure: SentryFailureV1 | null;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return Object.freeze(value.filter((entry): entry is string => typeof entry === 'string'));
}

export function parseSentryOrganizationsPage(input: Readonly<{
  deployment: SentryDeploymentV1;
  body: unknown;
}>): SentryOrganizationsPageV1 {
  if (!Array.isArray(input.body)) {
    return Object.freeze({
      organizations: Object.freeze([]),
      malformedRowCount: 0,
      failure: Object.freeze({
        class: 'unsupportedContract' as const,
        code: SENTRY_FAILURE_CODES.responseUnparseable,
      }),
    });
  }

  const organizations: SentryOrganizationV1[] = [];
  let malformedRowCount = 0;
  let regionMismatch = false;

  for (const row of input.body) {
    if (!isRecord(row)) {
      malformedRowCount += 1;
      continue;
    }
    const organizationId = readString(row.id);
    if (organizationId === null || !isSentryNumericId(organizationId)) {
      malformedRowCount += 1;
      continue;
    }
    const links = isRecord(row.links) ? row.links : null;
    const consistency = checkSentryRegionUrlConsistency(
      input.deployment,
      links === null ? undefined : links.regionUrl,
    );
    if (!consistency.ok) {
      regionMismatch = true;
      continue;
    }
    const status = isRecord(row.status) ? readString(row.status.id) : null;
    organizations.push(Object.freeze({
      organizationId,
      slug: readString(row.slug),
      name: readString(row.name),
      statusId: status,
      grantedScopes: readStringArray(row.access),
      features: readStringArray(row.features),
    }));
  }

  const failure: SentryFailureV1 | null = regionMismatch
    ? Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
    })
    : malformedRowCount > 0
      ? Object.freeze({
        class: 'unsupportedContract' as const,
        code: SENTRY_FAILURE_CODES.malformedOrganizationRow,
      })
      : null;

  return Object.freeze({
    organizations: Object.freeze(organizations),
    malformedRowCount,
    failure,
  });
}
