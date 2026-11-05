import { z } from 'zod/mini';
import { DeploymentIngressV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTemplates';
import { ScmCommitOidSchema } from '@happier-dev/protocol/scm/commitPublication';
import { DeploymentReviewServiceV1Schema } from '@happier-dev/protocol/local/services/nativeRuntimeFactsV1';
import { type DeploymentSourceIntentV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
export { DeploymentReviewServiceV1Schema, type DeploymentReviewServiceV1 } from '@happier-dev/protocol/local/services/nativeRuntimeFactsV1';

import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision, DeploymentDigestV1Schema as digest } from './ids.js';
import { OwnServerEnvironmentConfigurationV1Schema } from './environment.js';

/** Display identity only; stored Compose documents and private binding sources never enter review. */
export const DeploymentReviewRevisionV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('repository'), sha: ScmCommitOidSchema, subject: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('stored'), contentRevision: revision, composeDigest: digest }),
]);
export type DeploymentReviewRevisionV1 = z.infer<typeof DeploymentReviewRevisionV1Schema>;

export function projectDeploymentReviewRevisionV1(source: DeploymentSourceIntentV1, subject?: string): DeploymentReviewRevisionV1 {
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
const machineReview = {
  health: DeploymentTemplateV1Schema.shape.health,
  machineId: z.optional(id),
  environment: z.optional(z.strictObject({ id, name: z.string(), ingress: z.optional(DeploymentIngressV1Schema) })),
  revision: z.optional(DeploymentReviewRevisionV1Schema),
  /** Null means the selected link has no serving receipt; absent means an older review did not report it. */
  replaces: z.optional(z.nullable(z.strictObject({ deploymentId: id, revision: DeploymentReviewRevisionV1Schema }))),
  secretBindingNames: z.optional(z.array(z.string())),
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
});
export const DeploymentApprovalReviewV1Schema = z.union([
  DeploymentReviewV1Schema,
  z.strictObject({
    deployment: DeploymentReviewV1Schema,
    promotion: DeploymentPromotionReviewV1Schema,
  }),
]);
export type DeploymentApprovalReviewV1 = z.infer<
  typeof DeploymentApprovalReviewV1Schema
>;
