import { computeCanonicalDomainSeparatedDigest, computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';

/** Private Account Artifact kinds, independent of content and executable Action schemas. */
export const USAGE_NOTICE_ARTIFACT_KIND_V1 = 'usage_notice.v1';
export const ACCOUNT_NOTICE_ARTIFACT_KIND_V1 = 'account_notice.v1';

export const DEPLOYMENT_NOTICE_INDEXED_KIND_PREFIX_V1 = `${ACCOUNT_NOTICE_ARTIFACT_KIND_V1}#deployment-environment:`;
const receiptSeparator = '#deployment-receipt:';

/** The existing private Environment/receipt page association, as a non-content query hint. */
export function deploymentNoticeIndexedKindV1(environmentId: string, deploymentId?: string): string {
  const environment = DEPLOYMENT_NOTICE_INDEXED_KIND_PREFIX_V1
    + computeCanonicalDomainSeparatedHexDigest('happier.account-notice.deployment-environment.v1', [environmentId]);
  return deploymentId === undefined ? environment : environment + receiptSeparator
    + computeCanonicalDomainSeparatedDigest('happier.account-notice.deployment-receipt.v1', [deploymentId]);
}

export function deploymentNoticeEnvironmentIndexedKindV1(kind: string): string | null {
  if (!kind.startsWith(DEPLOYMENT_NOTICE_INDEXED_KIND_PREFIX_V1)) return null;
  const [environment, receipt, ...extra] = kind.slice(DEPLOYMENT_NOTICE_INDEXED_KIND_PREFIX_V1.length).split(receiptSeparator);
  return environment !== undefined && /^[a-f0-9]{64}$/.test(environment)
    && (receipt === undefined || /^[A-Za-z0-9_-]{43}$/.test(receipt)) && extra.length === 0
    ? DEPLOYMENT_NOTICE_INDEXED_KIND_PREFIX_V1 + environment : null;
}

/** This derives only query membership. Full notice and page admission remain private. */
export function readDeploymentNoticeIndexedKindV1(header: Readonly<Record<string, unknown>>): string | null {
  if (header.kind !== ACCOUNT_NOTICE_ARTIFACT_KIND_V1) return null;
  const page = header.page;
  if (page === null || typeof page !== 'object' || !('kind' in page) || page.kind !== 'host'
    || !('page' in page) || (page.page !== 'environment' && page.page !== 'machine_service')) return null;
  const environment = 'environment' in page ? page.environment : null;
  const environmentId = environment && typeof environment === 'object' && 'environmentId' in environment
    ? environment.environmentId : null;
  if (typeof environmentId !== 'string' || !environmentId) return null;
  const deploymentId = page.page === 'environment' && 'deploymentId' in page ? page.deploymentId : undefined;
  return deploymentNoticeIndexedKindV1(environmentId, typeof deploymentId === 'string' && deploymentId ? deploymentId : undefined);
}
