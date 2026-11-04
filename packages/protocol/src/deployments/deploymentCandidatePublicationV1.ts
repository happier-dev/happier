import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';
import { isDeploymentDomainChildActionIdV1 } from './deploymentActionIdsV1.js';
import { DeploymentDomainAddInputV1Schema, DeploymentDomainRemoveInputV1Schema,
  DeploymentDomainVerifyInputV1Schema } from './deploymentDomainV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestorePrepareInputV1Schema,
  DeploymentBackupRestoreConfirmInputV1Schema } from './deploymentBackupRestoreV1.js';
import { DeploymentRestartInputV1Schema } from './deploymentRestartV1.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';

/** Home needs only this non-content Environment fact from an encrypted native root. */
export const DeploymentDomainNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('domain'), actionId: z.enum(['deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify']),
  environmentId: id, domainId: id, inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type DeploymentDomainNativeAdmissionV1 = z.infer<typeof DeploymentDomainNativeAdmissionV1Schema>;
export const DeploymentRestartNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('restart'), actionId: z.literal('deployments.restart'), environmentId: id,
  deploymentId: id, targetLinkId: id, machineId: id, installationId: id,
}));
export type DeploymentRestartNativeAdmissionV1 = z.infer<typeof DeploymentRestartNativeAdmissionV1Schema>;
const restoreAdmission = () => ({ kind: z.literal('restore'), actionId: z.literal('deployments.backups.restore'),
  inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)) });
export const DeploymentRestoreNativeAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.extend(z.omit(DeploymentBackupRestorePrepareInputV1Schema, { serverId: true }), restoreAdmission()),
  z.extend(z.omit(DeploymentBackupRestoreConfirmInputV1Schema, { serverId: true }), restoreAdmission()),
]));
export type DeploymentRestoreNativeAdmissionV1 = z.infer<typeof DeploymentRestoreNativeAdmissionV1Schema>;
export const DeploymentNativeAdmissionV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ environmentId: id }), DeploymentDomainNativeAdmissionV1Schema, DeploymentRestartNativeAdmissionV1Schema, DeploymentRestoreNativeAdmissionV1Schema,
]));
// Signed authority stays closed in stored approvals. A tolerant Environment-only
// arm would consume typed native facts and change the original envelope digest.
defineStoredReadProjection(DeploymentNativeAdmissionV1Schema, () => DeploymentNativeAdmissionV1Schema);
export type DeploymentNativeAdmissionV1 = z.infer<typeof DeploymentNativeAdmissionV1Schema>;
export function isDeploymentDomainNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined): value is DeploymentDomainNativeAdmissionV1 {
  return value !== undefined && 'kind' in value && value.kind === 'domain';
}
export function projectDeploymentNativeAdmissionV1(actionId: string, input: unknown) {
  if (actionId === 'deployments.backups.restore') {
    const value = DeploymentBackupRestoreInputV1Schema.parse(input);
    const { serverId: _serverId, ...admitted } = value;
    return DeploymentRestoreNativeAdmissionV1Schema.parse({ ...admitted, kind: 'restore', actionId,
      inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-restore-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
  if (actionId === 'deployments.restart') {
    const value = DeploymentRestartInputV1Schema.parse(input);
    return DeploymentRestartNativeAdmissionV1Schema.parse({ kind: 'restart', actionId,
      environmentId: value.environmentId, deploymentId: value.deploymentId, targetLinkId: value.targetLinkId,
      machineId: value.machineId, installationId: value.installationId });
  }
  if (isDeploymentDomainChildActionIdV1(actionId)) {
    const schema = actionId === 'deployments.domains.add' ? DeploymentDomainAddInputV1Schema
      : actionId === 'deployments.domains.remove' ? DeploymentDomainRemoveInputV1Schema : DeploymentDomainVerifyInputV1Schema;
    const value = schema.parse(input);
    return DeploymentDomainNativeAdmissionV1Schema.parse({ kind: 'domain', actionId, environmentId: value.environmentId,
      domainId: value.domainId, inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-domain-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
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
