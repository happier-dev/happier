import { z } from '../zodRuntimePolicy.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentTemplateV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { DeploymentReviewServiceV1Schema } from '../local/services/nativeRuntimeFactsV1.js';
import { DeploymentIngressV1Schema, DeploymentOnFailureV1Schema, EnvironmentVariableBindingV1Schema, type DeploymentSourceIntentV1 } from './storedAppInputV1.js';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { EnvVarRequirementSchema } from '../profiles/environmentVariables.js';
import { DeploymentReferenceAddressV1Schema } from './deploymentReadsV1.js';
import { DeploymentFolderReviewRevisionV1Schema } from './deploymentFolderReviewRevisionV1.js';
export { DeploymentReviewServiceV1Schema, type DeploymentReviewServiceV1 } from '../local/services/nativeRuntimeFactsV1.js';
export { deploymentRevisionShortLabelV1 } from './storedAppInputV1.js';

import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentDigestV1Schema as digest, OwnServerEnvironmentConfigurationV1Schema } from './storedAppInputV1.js';

/** Value-free refusal from the host secret owner when a native review cannot be rendered. */
export const DeploymentMissingRequiredSecretsV1Schema = z.strictObject({
  deployable: z.literal(false),
  missingRequiredSecretNames: z.array(EnvVarRequirementSchema.shape.name),
});
export type DeploymentMissingRequiredSecretsV1 = z.infer<typeof DeploymentMissingRequiredSecretsV1Schema>;

/** Build requirements and observed engine failures; neither a CPU nor an advertised platform proves emulation. */
export const DeploymentBuildSupportV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('notObserved'), requestedPlatforms: z.array(z.string()) }),
  z.strictObject({ status: z.literal('built'), requestedPlatforms: z.array(z.string()), builtPlatforms: z.array(z.string()) }),
  z.strictObject({ status: z.literal('failed'), requestedPlatforms: z.array(z.string()), builtPlatforms: z.array(z.string()),
    cause: z.enum(['runtime_platform_unsupported', 'execution_format_error', 'build_failed']), exitCode: z.number() }),
]);
export type DeploymentBuildSupportV1 = z.infer<typeof DeploymentBuildSupportV1Schema>;

/** Display identity only; stored Compose documents and private binding sources never enter review. */
export const DeploymentReviewRevisionV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('repository'), sha: ScmCommitOidSchema, subject: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('stored'), contentRevision: revision, composeDigest: digest }),
  DeploymentFolderReviewRevisionV1Schema,
]);
export type DeploymentReviewRevisionV1 = z.infer<typeof DeploymentReviewRevisionV1Schema>;

export function projectDeploymentReviewRevisionV1(source: DeploymentSourceIntentV1, subject?: string): DeploymentReviewRevisionV1 {
  if (source.kind === 'folder') {
    const { kind, manifestFingerprint, fileCount, totalBytes, excludedPaths } = source;
    return { kind, manifestFingerprint, fileCount, totalBytes, excludedPaths };
  }
  return source.kind === 'repository' ? { kind: source.kind, sha: source.sha, ...(subject === undefined ? {} : { subject }) }
    : { kind: source.kind, contentRevision: source.contentRevision, composeDigest: source.composeDigest };
}

/** Only the existing recreate path establishes this downtime class; not a duration or start-first guarantee. */
export function projectDeploymentDowntimeClassV1(rollout: 'recreate' | 'startFirst' | undefined,
  hasServingReceipt: boolean): 'stopThenStart' | undefined {
  return hasServingReceipt && rollout === 'recreate' ? 'stopThenStart' : undefined;
}

export const DeploymentReviewRiskKindV1Schema = z.enum([
  'privileged',
  'host_network',
  'host_pid',
  'host_ipc',
  'additional_capabilities',
  'devices',
  'host_bind',
  'docker_socket',
  'in_release_bind',
  'non_loopback_publish',
  'missing_reboot_restart_policy',
  'inspection_unknown',
]);
export type DeploymentReviewRiskKindV1 = z.infer<
  typeof DeploymentReviewRiskKindV1Schema
>;

/**
 * The reviewed effect an installed host returns for a deploy, rollback or promotion
 * approval (`request.preview.deploymentReview`). The host renders it from the target's
 * native Compose model with its secrets already redacted; this is the reader's contract
 * for that DTO. It carries names and structural facts only, never secret values.
 */
const environmentReview = z.strictObject({ id, name: z.string(), ingress: z.optional(DeploymentIngressV1Schema) });
const replacedDeployment = z.nullable(z.strictObject({ deploymentId: id, revision: DeploymentReviewRevisionV1Schema }));
const machineReview = {
  health: DeploymentTemplateV1Schema.shape.health,
  machineId: z.optional(id),
  environment: z.optional(environmentReview),
  revision: z.optional(DeploymentReviewRevisionV1Schema),
  /** Null means the selected link has no serving receipt; absent means an older review did not report it. */
  replaces: z.optional(replacedDeployment),
  secretBindingNames: z.optional(z.array(z.string())),
  buildSupport: z.optional(DeploymentBuildSupportV1Schema),
  /** Syntactic use in the native Compose source; no inferred effective values or secret contents. Nonblocking. */
  variableUseWarnings: z.optional(z.array(z.strictObject({ kind: z.enum(['unusedBinding', 'unboundVariable']), name: z.string() }))),
  /** Resolved review inputs that differ from exact serving launch evidence. Values stay host-private. */
  /** `route` is the resolver's observed Happier network path for the reviewed address, when it has one. */
  referenceChanges: z.optional(z.array(z.strictObject({ name: z.string(), phase: EnvironmentVariableBindingV1Schema.shape.phase,
    route: DeploymentReferenceAddressV1Schema.shape.route }))),
  onFailure: z.optional(DeploymentOnFailureV1Schema),
  /** A recreate replaces an existing serving generation; no estimated duration. */
  downtime: z.optional(z.literal('stopThenStart')),
  /** Configured retention policy, not an observed kept count or disk measurement. */
  rollbackStorage: z.optional(z.strictObject({ keepPreviousDeployments: DeploymentRetainPreviousDeploymentsV1Schema })),
  inspection: z.enum(['complete', 'unknown']),
  services: z.array(DeploymentReviewServiceV1Schema),
  risks: z.array(
    z.strictObject({
      kind: DeploymentReviewRiskKindV1Schema,
      service: z.string(),
    }),
  ),
  storage: z.optional(
    z.strictObject({
      warnings: z.array(
        z.strictObject({
          kind: z.enum(['writable_source', 'concurrent_writers']),
          service: z.string(),
          target: z.string(),
          replicas: z.optional(z.number()),
        }),
      ),
    }),
  ),
  ownServer: z.optional(OwnServerEnvironmentConfigurationV1Schema),
  target: z.strictObject({
    engine: z.enum(['native', 'dockerDesktop', 'unknown']),
    requiresAwakeComputerAndDockerDesktop: z.boolean(),
    domains: z.enum(['unavailableDockerDesktop', 'notDetermined']),
  }),
};
/** One Machine's own review; a controller's aggregate repeats the first Machine's at its top level. */
export const DeploymentMachineReviewV1Schema = z.strictObject(machineReview);
export type DeploymentMachineReviewV1 = z.infer<
  typeof DeploymentMachineReviewV1Schema
>;
export const DeploymentReviewV1Schema = z.strictObject({
  ...machineReview,
  rollbackData: z.optional(z.enum(['keep', 'restoreBackup'])),
  runtimeMachines: z.optional(
    z.array(
      z.strictObject({
        machineId: id,
        review: DeploymentMachineReviewV1Schema,
      }),
    ),
  ),
});
export type DeploymentReviewV1 = z.infer<typeof DeploymentReviewV1Schema>;

/** A promotion wraps the destination's deploy review with the Compose document change it applies. */
export const DeploymentPromotionReviewV1Schema = z.strictObject({
  artifact: z.literal('image'),
  previousDocument: z.string(),
  candidateDocument: z.string(),
  sourceRevision: z.optional(DeploymentReviewRevisionV1Schema),
});
const platformReview = {
  environment: environmentReview,
  revision: DeploymentReviewRevisionV1Schema,
  platformName: z.string(),
  providerResourceId: id,
  providerEnvironment: id,
};

export const DeploymentApprovalReviewV1Schema = z.union([
  DeploymentReviewV1Schema,
  z.strictObject({
    deployment: DeploymentReviewV1Schema,
    promotion: DeploymentPromotionReviewV1Schema,
  }),
  z.strictObject({
    summary: z.optional(z.string()),
    platformRollback: z.strictObject({
      ...platformReview,
      replaces: replacedDeployment,
      data: z.literal('keep'),
    }),
    providerReview: StrictJsonValueSchema,
  }),
  z.strictObject({
    summary: z.optional(z.string()),
    platformPromotion: z.strictObject(platformReview),
    providerReview: StrictJsonValueSchema,
  }),
]);
export type DeploymentApprovalReviewV1 = z.infer<
  typeof DeploymentApprovalReviewV1Schema
>;

export { readDeploymentFailureRecoveryV1 } from './deploymentFailureRecoveryV1.js';
