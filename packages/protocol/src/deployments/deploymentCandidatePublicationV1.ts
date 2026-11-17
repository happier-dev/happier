import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentConfigurationDefaultsForV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { hasDeploymentEnvironmentContentPatchV1, omitDeploymentEnvironmentPrivateContentPatchV1 } from './deploymentEnvironmentContentPatchV1.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../crypto/canonicalDigest.js';
import { isDeploymentDomainChildActionIdV1, isDeploymentBackupActionIdV1, DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1,
  DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, isDeploymentPromoteActionIdV1 } from './deploymentActionIdsV1.js';
import { DeploymentBackupConfigureInputV1Schema, DeploymentBackupConfigureIntentV1Schema } from './deploymentBackupConfigureV1.js';
import { DeploymentEnvironmentTelemetrySetInputV1Schema } from './deploymentTelemetryV1.js';
import { DeploymentBackupHistoryInputV1Schema, DeploymentBackupTestInputV1Schema, DeploymentBackupInventoryInputV1Schema, DeploymentBackupRunInputV1Schema, DeploymentBackupVerifyInputV1Schema,
  DeploymentBackupPruneInputV1Schema, DeploymentBackupActionInputSchemasV1 } from './deploymentBackupActionsV1.js';
import { DeploymentDomainAddInputV1Schema, DeploymentDomainRemoveInputV1Schema,
  DeploymentDomainAttachedVerifyInputV1Schema, DeploymentDomainPreviewInputV1Schema } from './deploymentDomainV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestorePrepareInputV1Schema,
  DeploymentBackupRestoreConfirmInputV1Schema, DeploymentBackupRestoreRecoverInputV1Schema } from './deploymentBackupRestoreV1.js';
import { DeploymentRestartInputV1Schema } from './deploymentRestartV1.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';

/** Home needs only this non-content Environment fact from an encrypted native root. */
export const DeploymentDomainNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('domain'), actionId: z.enum(['deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify']),
  environmentId: id, domainId: id, inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  authoredMetadataDigest: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u))),
}));
export type DeploymentDomainNativeAdmissionV1 = z.infer<typeof DeploymentDomainNativeAdmissionV1Schema>;
export const DeploymentDomainDnsNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('domainDns'), actionId: z.literal('deployments.domains.verify'),
  ...z.omit(DeploymentDomainPreviewInputV1Schema, { serverId: true, mode: true, content: true }).shape,
}));
export type DeploymentDomainDnsNativeAdmissionV1 = z.infer<typeof DeploymentDomainDnsNativeAdmissionV1Schema>;
export const DeploymentRestartNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('restart'), actionId: z.literal('deployments.restart'), environmentId: id,
  deploymentId: id, targetLinkId: id, machineId: id, installationId: id,
}));
export type DeploymentRestartNativeAdmissionV1 = z.infer<typeof DeploymentRestartNativeAdmissionV1Schema>;
const restoreAdmission = () => ({ kind: z.literal('restore'), actionId: z.literal('deployments.backups.restore'),
  inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)) });
export const DeploymentRestoreNativeAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.extend(z.omit(DeploymentBackupRestorePrepareInputV1Schema, { serverId: true }), restoreAdmission()),
  z.extend(z.omit(DeploymentBackupRestoreConfirmInputV1Schema, { serverId: true, snapshotReview: true }), restoreAdmission()),
  z.extend(z.omit(DeploymentBackupRestoreRecoverInputV1Schema, { serverId: true }), restoreAdmission()),
]));
export type DeploymentRestoreNativeAdmissionV1 = z.infer<typeof DeploymentRestoreNativeAdmissionV1Schema>;
const backupAdmission = () => ({ kind: z.literal('backup'), inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)) });
export const DeploymentBackupNativeAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.extend(z.omit(DeploymentBackupHistoryInputV1Schema, { serverId: true }),
    { ...backupAdmission(), actionId: z.literal('deployments.backups.history') }),
  z.extend(z.omit(DeploymentBackupTestInputV1Schema, { serverId: true }),
    { ...backupAdmission(), actionId: z.literal('deployments.backups.test') }),
  z.extend(z.omit(DeploymentBackupInventoryInputV1Schema, { serverId: true }),
    { ...backupAdmission(), actionId: z.literal('deployments.backups.inventory') }),
  z.extend(z.omit(DeploymentBackupRunInputV1Schema, { serverId: true }),
    { ...backupAdmission(), actionId: z.literal('deployments.backups.run') }),
  z.extend(z.omit(DeploymentBackupVerifyInputV1Schema, { serverId: true }),
    { ...backupAdmission(), actionId: z.literal('deployments.backups.verify') }),
  z.extend(z.omit(DeploymentBackupPruneInputV1Schema, { serverId: true }),
    { ...backupAdmission(), actionId: z.literal('deployments.backups.prune') }),
]));
export type DeploymentBackupNativeAdmissionV1 = z.infer<typeof DeploymentBackupNativeAdmissionV1Schema>;
/** Configure executes before target selection; authored configuration stays sealed. */
export const DeploymentBackupConfigureNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('backupConfigure'), actionId: z.literal(DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1),
  environmentId: id, expectedRevision: revision, intent: DeploymentBackupConfigureIntentV1Schema,
  receiverMachineId: z.optional(id),
  inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export type DeploymentBackupConfigureNativeAdmissionV1 = z.infer<typeof DeploymentBackupConfigureNativeAdmissionV1Schema>;
/** Telemetry's closed public intent contains only placement and reviewed mutation facts. */
export const DeploymentTelemetryNativeAdmissionV1Schema = lazyZodSchema(() => z.extend(
  z.omit(DeploymentEnvironmentTelemetrySetInputV1Schema, { serverId: true, capabilities: true }), {
    kind: z.literal('telemetry'), actionId: z.literal(DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1),
    inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  }));
export type DeploymentTelemetryNativeAdmissionV1 = z.infer<typeof DeploymentTelemetryNativeAdmissionV1Schema>;
export const DeploymentEnvironmentUpdateNativeAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.optional(z.literal('preview')),
  defaultsFor: z.optional(DeploymentConfigurationDefaultsForV1Schema),
  previewPlacement: z.optional(z.strictObject({ runtimeTargetLinkId: z.optional(id), buildMachineId: z.optional(id) })),
  environmentId: id, inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  authoredMetadataDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));
export const DeploymentNativeAdmissionV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ environmentId: id }),
  z.strictObject({ kind: z.literal('promote'), environmentId: id, sourceEnvironmentId: id, sourceDeploymentId: id }),
  DeploymentEnvironmentUpdateNativeAdmissionV1Schema,
  DeploymentDomainNativeAdmissionV1Schema, DeploymentDomainDnsNativeAdmissionV1Schema, DeploymentRestartNativeAdmissionV1Schema, DeploymentRestoreNativeAdmissionV1Schema,
  DeploymentBackupNativeAdmissionV1Schema, DeploymentBackupConfigureNativeAdmissionV1Schema, DeploymentTelemetryNativeAdmissionV1Schema,
]));
// Signed authority stays closed in stored approvals. A tolerant Environment-only
// arm would consume typed native facts and change the original envelope digest.
defineStoredReadProjection(DeploymentNativeAdmissionV1Schema, () => DeploymentNativeAdmissionV1Schema);
type NativeAdmissionWithKind<T> = T extends { kind: string } ? T : T & Readonly<{ kind?: never }>;
export type DeploymentNativeAdmissionV1 = NativeAdmissionWithKind<z.infer<typeof DeploymentNativeAdmissionV1Schema>>;
export function isDeploymentEnvironmentUpdateNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined):
  value is Extract<DeploymentNativeAdmissionV1, { authoredMetadataDigest: string }> {
  return value !== undefined && !('kind' in value) && 'authoredMetadataDigest' in value;
}
export function isDeploymentDomainNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined): value is DeploymentDomainNativeAdmissionV1 {
  return value !== undefined && 'kind' in value && value.kind === 'domain';
}
export function isDeploymentDomainDnsNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined): value is DeploymentDomainDnsNativeAdmissionV1 {
  return value !== undefined && 'kind' in value && value.kind === 'domainDns';
}
export function isDeploymentBackupNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined): value is DeploymentBackupNativeAdmissionV1 {
  return value !== undefined && 'kind' in value && value.kind === 'backup';
}
export function isDeploymentBackupConfigureNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined): value is DeploymentBackupConfigureNativeAdmissionV1 {
  return value !== undefined && 'kind' in value && value.kind === 'backupConfigure';
}
export function isDeploymentTelemetryNativeAdmissionV1(value: DeploymentNativeAdmissionV1 | undefined): value is DeploymentTelemetryNativeAdmissionV1 {
  return value !== undefined && 'kind' in value && value.kind === 'telemetry';
}
export function projectDeploymentNativeAdmissionV1(actionId: string, input: unknown): DeploymentNativeAdmissionV1 | undefined {
  if (actionId === DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1) {
    const value = DeploymentEnvironmentTelemetrySetInputV1Schema.parse(input);
    const { serverId: _serverId, capabilities: _capabilities, ...admitted } = value;
    return DeploymentTelemetryNativeAdmissionV1Schema.parse({ ...admitted, kind: 'telemetry', actionId,
      inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-telemetry-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
  if (actionId === DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1) {
    const value = DeploymentBackupConfigureInputV1Schema.parse(input);
    return DeploymentBackupConfigureNativeAdmissionV1Schema.parse({ kind: 'backupConfigure', actionId,
      environmentId: value.environmentId, expectedRevision: value.expectedRevision, intent: value.intent,
      ...('destinationSetup' in value && value.destinationSetup ? { receiverMachineId: value.destinationSetup.machineId } : {}),
      inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-backup-configure-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
  if (actionId === 'deployments.environments.update') {
    const value = readRecord(input);
    const patch = readRecord(value.patch);
    const previewTemplate = readRecord(patch.previewTemplate);
    if (value.mode !== 'preview' && !hasDeploymentEnvironmentContentPatchV1(value.patch) && patch.buildMachineId === undefined) return undefined;
    return DeploymentNativeAdmissionV1Schema.parse({ environmentId: value.environmentId,
      ...(value.mode === 'preview' ? { mode: 'preview' } : {}),
      ...(value.defaultsFor === undefined ? {} : { defaultsFor: DeploymentConfigurationDefaultsForV1Schema.parse(value.defaultsFor) }),
      ...(previewTemplate.runtimeTargetLinkId === undefined && patch.buildMachineId === undefined ? {} : {
        previewPlacement: {
          ...(previewTemplate.runtimeTargetLinkId === undefined ? {} : { runtimeTargetLinkId: previewTemplate.runtimeTargetLinkId }),
          ...(patch.buildMachineId === undefined ? {} : { buildMachineId: patch.buildMachineId }),
        } }),
      inputDigest: computeDeploymentEnvironmentUpdateInputDigestV1(value),
      authoredMetadataDigest: computeDeploymentEnvironmentUpdateMetadataDigestV1(value) });
  }
  if (isDeploymentBackupActionIdV1(actionId)) {
    const value = DeploymentBackupActionInputSchemasV1[actionId].parse(input);
    const { serverId: _serverId, ...admitted } = value;
    return DeploymentBackupNativeAdmissionV1Schema.parse({ ...admitted, kind: 'backup', actionId,
      inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-backup-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
  if (actionId === 'deployments.backups.restore') {
    const value = DeploymentBackupRestoreInputV1Schema.parse(input);
    const { serverId: _serverId, ...admitted } = value;
    const routing = admitted.mode === 'confirm' ? (({ snapshotReview: _review, ...routing }) => routing)(admitted) : admitted;
    return DeploymentRestoreNativeAdmissionV1Schema.parse({ ...routing, kind: 'restore', actionId,
      inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-restore-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
  if (actionId === 'deployments.restart') {
    const value = DeploymentRestartInputV1Schema.parse(input);
    return DeploymentRestartNativeAdmissionV1Schema.parse({ kind: 'restart', actionId,
      environmentId: value.environmentId, deploymentId: value.deploymentId, targetLinkId: value.targetLinkId,
      machineId: value.machineId, installationId: value.installationId });
  }
  if (actionId === 'deployments.domains.verify' && readRecord(input).mode === 'preview') {
    const { serverId: _serverId, mode: _mode, content: _content, ...references } = DeploymentDomainPreviewInputV1Schema.parse(input);
    return DeploymentDomainDnsNativeAdmissionV1Schema.parse({ kind: 'domainDns', actionId, ...references });
  }
  if (isDeploymentDomainChildActionIdV1(actionId)) {
    const schema = actionId === 'deployments.domains.add' ? DeploymentDomainAddInputV1Schema
      : actionId === 'deployments.domains.remove' ? DeploymentDomainRemoveInputV1Schema : DeploymentDomainAttachedVerifyInputV1Schema;
    const value = schema.parse(input);
    return DeploymentDomainNativeAdmissionV1Schema.parse({ kind: 'domain', actionId, environmentId: value.environmentId,
      domainId: value.domainId, ...('content' in value ? { authoredMetadataDigest: computeDeploymentDomainAuthoredMetadataDigestV1(value) } : {}),
      inputDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-domain-input-v1',
        [createCanonicalJsonSigningInput(value)]) });
  }
  if (actionId === 'action.operations.get') return readRecord(input).environmentId === undefined
    ? undefined : DeploymentNativeAdmissionV1Schema.parse({ environmentId: readRecord(input).environmentId });
  if (isDeploymentPromoteActionIdV1(actionId)) {
    const value = readRecord(input);
    return DeploymentNativeAdmissionV1Schema.parse({ kind: 'promote', environmentId: value.environmentId,
      sourceEnvironmentId: value.sourceEnvironmentId, sourceDeploymentId: value.sourceDeploymentId });
  }
  if (actionId !== 'deployments.deploy' && actionId !== 'deployments.rollback'
    && actionId !== 'deployments.teardown') return undefined;
  return DeploymentNativeAdmissionV1Schema.parse({ environmentId: readRecord(input).environmentId });
}

/** Issued by the shared root mint, never supplied as Artifact ownership evidence. */
export const DeploymentCandidatePublicationV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: id, source: z.strictObject({ id, revision }), contentArtifactId: id, environmentContentArtifactId: z.optional(id),
}));

function publicationArtifactId(digest: string): string {
  // Variant b avoids the reserved version-8/variant-a Account-scoped namespace.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-b${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Ingress preparation retains the reviewed CAS and patch while replacing private references. */
export function computeDeploymentEnvironmentUpdateMetadataDigestV1(input: Readonly<Record<string, unknown>>): string {
  const { contentArtifactId: _artifact, contentHeaderVersion: _header, contentBodyVersion: _body,
    authoredInputDigest: _digest, preparedBindings: _bindings, ...metadata } = input;
  let reviewedMetadata = metadata;
  // The full input digest binds this private operand. Home receives only the
  // prepared Artifact reference; every remaining reviewed patch leaf stays bound.
  if (metadata.patch !== undefined) {
    const patch = omitDeploymentEnvironmentPrivateContentPatchV1(readRecord(metadata.patch));
    reviewedMetadata = { ...metadata, patch };
  }
  return computeCanonicalDomainSeparatedDigest('happier-deployment-environment-update-metadata-v1',
    [createCanonicalJsonSigningInput(reviewedMetadata)]);
}
export function computeDeploymentEnvironmentUpdateInputDigestV1(input: Readonly<Record<string, unknown>>): string {
  const { authoredInputDigest: _digest, preparedBindings: _bindings, ...reviewed } = input;
  return computeCanonicalDomainSeparatedDigest('happier-deployment-environment-update-input-v1',
    [createCanonicalJsonSigningInput(reviewed)]);
}
/** The original signed invocation owns one create-only Environment candidate. */
export function createDeploymentEnvironmentContentArtifactIdV1(input: Readonly<{
  accountId: string; serverIdentityId: string; requestId: string; requestEnvelopeDigest: string;
} & ({ actionId: string; environmentId: string }
  | { actionId: typeof DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1; environmentId?: never })>): string {
  return publicationArtifactId(computeCanonicalDomainSeparatedHexDigest('happier-deployment-environment-publication-v1',
    [input.serverIdentityId, input.accountId, input.actionId, input.requestId, input.requestEnvelopeDigest,
      ...(input.environmentId === undefined ? [] : [input.environmentId])]));
}

/** Preserve the admitted routing metadata when private content becomes an Artifact reference. */
export function computeDeploymentDomainAuthoredMetadataDigestV1(input: Readonly<Record<string, unknown>>): string {
  const { content: _content, contentArtifactId: _artifact, contentHeaderVersion: _header,
    contentBodyVersion: _body, authoredInputDigest: _digest, ...metadata } = input;
  return computeCanonicalDomainSeparatedDigest('happier-deployment-domain-authored-metadata-v1',
    [createCanonicalJsonSigningInput(metadata)]);
}

/** One create-only private Domain candidate belongs to the admitted invocation. */
export function createDeploymentDomainContentArtifactIdV1(input: Readonly<{
  accountId: string; serverIdentityId: string; actionId: string; requestId: string;
  requestEnvelopeDigest: string; deploymentNativeAdmission: DeploymentDomainNativeAdmissionV1;
  reviewedChild?: Readonly<{ inputDigest: string }>;
}>): string {
  return publicationArtifactId(computeCanonicalDomainSeparatedHexDigest('happier-deployment-domain-publication-v1',
    [input.serverIdentityId, input.accountId, input.actionId, input.requestId, input.requestEnvelopeDigest,
      input.deploymentNativeAdmission.inputDigest, ...(input.reviewedChild ? [input.reviewedChild.inputDigest] : [])]));
}

/** The private rewrite preserves the issuer's exact Domain operand and routing metadata. */
export function matchesDeploymentDomainPreparedInputV1(input: Readonly<Record<string, unknown>>,
  publication: Parameters<typeof createDeploymentDomainContentArtifactIdV1>[0]): boolean {
  const native = publication.deploymentNativeAdmission;
  if (native.authoredMetadataDigest === undefined || input.serverId !== publication.serverIdentityId
    || input.environmentId !== native.environmentId || input.domainId !== native.domainId
    || input.contentArtifactId !== createDeploymentDomainContentArtifactIdV1(publication)
    || input.contentHeaderVersion !== 1 || input.contentBodyVersion !== 1) return false;
  const { actionOperationId: _operation, requestId: _request, telemetryMachineId: _selectedCollector, ...original } = input;
  if (computeDeploymentDomainAuthoredMetadataDigestV1(original) === native.authoredMetadataDigest) return true;
  if (!('placements' in original)) return false;
  const { placements: _derivedPlacements, provider: _derivedProvider, ...withoutPlacements } = original;
  return computeDeploymentDomainAuthoredMetadataDigestV1(withoutPlacements) === native.authoredMetadataDigest;
}

/** One create-only Artifact belongs to this admitted Link invocation. */
export function createDeploymentLinkContentArtifactIdV1(input: Readonly<{
  accountId: string; serverIdentityId: string; actionId: string; requestId: string;
  requestEnvelopeDigest: string; deploymentLinkAdmission: Readonly<{ environmentId: string }>;
}>): string {
  return publicationArtifactId(computeCanonicalDomainSeparatedHexDigest('happier-deployment-target-link-publication-v1',
    [input.serverIdentityId, input.accountId, input.actionId, input.requestId, input.requestEnvelopeDigest,
      input.deploymentLinkAdmission.environmentId]));
}

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
    return publicationArtifactId(digest);
  };
  return DeploymentCandidatePublicationV1Schema.parse({ environmentId: input.environmentId, source: input.source,
    contentArtifactId: artifactId('receipt'),
    ...(input.actionId === 'deployments.promote' ? { environmentContentArtifactId: artifactId('environment') } : {}),
  });
}
