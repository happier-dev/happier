import { z } from 'zod';

import { computeCanonicalDomainSeparatedDigest } from '../../../crypto/canonicalDigest.js';
import { buildQualifiedPluginContributionKey } from '../../contributionIdentity.js';
import {
  formatUiSurfaceActionRequestV1,
  type NormalizedUiSurfaceCapabilityRequestV1,
} from './hostedHtmlCapabilitiesV1.js';
import { PluginHostedHtmlSourceV1Schema, type PluginHostedHtmlSourceV1 } from './hostedHtmlSourceV1.js';

/**
 * Approval identity for an executable by-value surface.
 *
 * Approval answers one question: *may these exact bytes run here with this
 * exact authority?* So it is keyed by the stable source identity, what will
 * execute, the isolation profile it will execute under, its approved egress,
 * and the authority it requested — and by nothing else. Record revision,
 * placement, widget id, tab, title and plugin generation govern currentness at
 * their own owners; keying approval by any of them would either re-prompt for a
 * title edit or let a changed document inherit a decision made about different
 * bytes.
 */

/**
 * The version of the host-owned isolation profile a mount executes under
 * (shell, CSP, sandbox and permission defaults). Tightening or loosening that
 * profile changes what an approval means, so it invalidates prior approvals.
 */
export const UI_SURFACE_ISOLATION_PROFILE_VERSION_V1 = 1;

const FINGERPRINT_DOMAIN_V1 = 'happier:ui-surface:executable-security-fingerprint:v1';
const CAPABILITY_DIGEST_DOMAIN_V1 = 'happier:ui-surface:requested-capabilities-digest:v1';
const APPROVAL_KEY_DOMAIN_V1 = 'happier:ui-surface:executable-approval-key:v1';

const MAX_UI_SURFACE_APPROVAL_SUBJECT_LENGTH_V1 = 512;
const MAX_UI_SURFACE_APPROVAL_IDENTIFIER_LENGTH_V1 = 256;

/**
 * The stable opaque source identity supplied by the outer approval owner: the
 * exact server-qualified record address for a Session-authored document, or the
 * exact installed contribution identity for a plugin one. It is private
 * approval scoping, never renderer, frame or authority identity, so this owner
 * validates only that it is a bounded non-empty string.
 */
export const UiSurfaceExecutableApprovalSubjectV1Schema = z.string()
  .min(1)
  .max(MAX_UI_SURFACE_APPROVAL_SUBJECT_LENGTH_V1);
export type UiSurfaceExecutableApprovalSubjectV1 =
  z.infer<typeof UiSurfaceExecutableApprovalSubjectV1Schema>;

const ApprovalIdentifierV1Schema = z.string().min(1).max(MAX_UI_SURFACE_APPROVAL_IDENTIFIER_LENGTH_V1);

export const UiSurfaceExecutableApprovalKeyV1Schema = z.object({
  serverIdentityId: ApprovalIdentifierV1Schema,
  accountId: ApprovalIdentifierV1Schema,
  approvalSubject: UiSurfaceExecutableApprovalSubjectV1Schema,
  executableSecurityFingerprint: ApprovalIdentifierV1Schema,
  requestedCapabilitiesDigest: ApprovalIdentifierV1Schema,
}).strict();
export type UiSurfaceExecutableApprovalKeyV1 =
  z.infer<typeof UiSurfaceExecutableApprovalKeyV1Schema>;

/**
 * Digests exactly what will execute and the boundary it executes behind.
 *
 * Origins are included here as well as in the capability digest so that neither
 * value alone can be reused across a changed egress boundary.
 */
export function createUiSurfaceExecutableSecurityFingerprintV1(
  input: Readonly<{
    source: PluginHostedHtmlSourceV1;
    isolationProfileVersion: number;
    networkOrigins: readonly string[];
  }>,
): string {
  const source = PluginHostedHtmlSourceV1Schema.parse(input.source);
  return computeCanonicalDomainSeparatedDigest(FINGERPRINT_DOMAIN_V1, [
    String(source.v),
    source.entrypoint,
    ...Object.keys(source.files).sort().flatMap((path) => [
      path,
      source.files[path].mime,
      source.files[path].contentBase64,
    ]),
    String(input.isolationProfileVersion),
    ...[...input.networkOrigins].sort(),
  ]);
}

/**
 * Digests the normalized requested authority. Because the request is already
 * deduplicated and sorted, semantically equal requests digest equally and a
 * widened one never does. Each list is domain-tagged so an identity cannot move
 * between Resources and Actions without changing the digest.
 */
export function createUiSurfaceRequestedCapabilitiesDigestV1(
  capabilities: NormalizedUiSurfaceCapabilityRequestV1,
): string {
  return computeCanonicalDomainSeparatedDigest(CAPABILITY_DIGEST_DOMAIN_V1, [
    'hostMethods',
    ...capabilities.hostMethods,
    'resources',
    ...capabilities.resources.map(buildQualifiedPluginContributionKey),
    'actions',
    ...capabilities.actions.map(formatUiSurfaceActionRequestV1),
    'networkOrigins',
    ...capabilities.networkOrigins,
  ]);
}

/**
 * The one local settings key for a remembered approval.
 *
 * Every part is length-delimited by the canonical digest owner, so identical
 * bytes in another Session record, contribution, Home or Account cannot collide
 * with — and therefore cannot inherit — this approval.
 */
export function buildUiSurfaceExecutableApprovalKeyStringV1(
  key: UiSurfaceExecutableApprovalKeyV1,
): string {
  const parsed = UiSurfaceExecutableApprovalKeyV1Schema.parse(key);
  return computeCanonicalDomainSeparatedDigest(APPROVAL_KEY_DOMAIN_V1, [
    parsed.serverIdentityId,
    parsed.accountId,
    parsed.approvalSubject,
    parsed.executableSecurityFingerprint,
    parsed.requestedCapabilitiesDigest,
  ]);
}
