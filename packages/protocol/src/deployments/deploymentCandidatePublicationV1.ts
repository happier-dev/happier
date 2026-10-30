import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';

/** Home needs only this non-content Environment fact from an encrypted native root. */
export const DeploymentNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({ environmentId: id }));
export function projectDeploymentNativeAdmissionV1(actionId: string, input: unknown) {
  if (actionId === 'action.operations.get') return readRecord(input).environmentId === undefined
    ? undefined : DeploymentNativeAdmissionV1Schema.parse({ environmentId: readRecord(input).environmentId });
  if (actionId !== 'deployments.deploy' && actionId !== 'deployments.rollback' && actionId !== 'deployments.promote'
    && actionId !== 'deployments.teardown') return undefined;
  return DeploymentNativeAdmissionV1Schema.parse({ environmentId: readRecord(input).environmentId });
}

/** Issued by the shared root mint, never supplied as Artifact ownership evidence. */
export const DeploymentCandidatePublicationV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: id, source: z.strictObject({ id, revision }), contentArtifactId: id, environmentContentArtifactId: z.optional(id),
}));

/** Reminting the same invocation retains its pre-receipt candidate, including pending wake. */
export function createDeploymentCandidatePublicationV1(input: Readonly<{
  accountId: string; serverIdentityId: string; actionId: string; requestId: string;
  requestEnvelopeDigest: string; environmentId: string;
  source: Readonly<{ id: string; revision: number }>;
}>) {
  const artifactId = (purpose: string) => {
    const digest = computeCanonicalDomainSeparatedHexDigest(
    'happier-deployment-candidate-v1', [input.serverIdentityId, input.accountId, input.actionId,
      input.requestId, input.requestEnvelopeDigest, input.environmentId, input.source.id, String(input.source.revision), purpose]);
    // Artifact transport requires UUIDs. Variant b deliberately avoids the
    // incumbent version-8/variant-a Account-scoped create namespace.
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-b${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  };
  return DeploymentCandidatePublicationV1Schema.parse({ environmentId: input.environmentId, source: input.source,
    contentArtifactId: artifactId('receipt'),
    ...(input.actionId === 'deployments.promote' ? { environmentContentArtifactId: artifactId('environment') } : {}),
  });
}
