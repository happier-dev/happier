import { z } from 'zod/mini';

import { DeploymentEnvironmentContentStoredReadV1Schema, DeploymentEnvironmentHeaderV1Schema } from './environment.js';
import { DeploymentTargetLinkContentV1Schema, DeploymentTargetLinkHeaderV1Schema } from './target.js';
import { DeploymentContentV1Schema, DeploymentReceiptFailureV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentStepV1Schema } from './deployment.js';
import { DeploymentIdentifierV1Schema } from './ids.js';
import { DeploymentEnvironmentHealthAggregateV1Schema } from './health.js';
import { DeploymentReviewRevisionV1Schema } from './review.js';
import { DeploymentCancellationConsequenceV1Schema, type DeploymentCancellationConsequenceV1 } from '@happier-dev/protocol/deployments/deploymentStateV1';
import { DeploymentControllerAvailabilityV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBindingSavedSecretRevisionsV1Schema, DeploymentEnvironmentSecretScopeV1Schema } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';

import { DeploymentPendingDeployIntentV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentPendingAdmissionV1Schema } from '@happier-dev/protocol/deployments/deploymentPendingAdmissionV1';

const collectionCoverage = z.optional(z.enum(['complete', 'partial']));

/** Private Environment configuration facts stay with the opened page, never public metadata. */
export const DeploymentEnvironmentCollectionV1Schema = z.strictObject({
    items: z.array(z.strictObject({ environment: DeploymentEnvironmentHeaderV1Schema, title: z.string(),
        projectSourceName: z.optional(z.nullable(z.string())),
        /** Saved configuration, independent of backup runs; omitted by older readers or unreadable content. */
        backupConfigured: z.optional(z.boolean()),
        /** Actual opened template configuration; omitted when the private Artifact is unavailable. */
        previewTemplateConfigured: z.optional(z.boolean()),
        /** Unknown unless the carried receipt is the runtime link's actual active deployment. */
        liveVersionTitle: z.optional(z.nullable(z.string())),
        /** Opened serving address; null means none resolved, omission means unknown. */
        liveAddress: z.optional(z.nullable(z.string())),
        runtimeTargetLink: z.optional(z.nullable(DeploymentTargetLinkHeaderV1Schema)),
        currentDeployment: z.optional(z.nullable(z.extend(DeploymentReceiptHeaderV1Schema, {
            title: z.optional(z.string()),
            steps: z.optional(z.nullable(z.array(DeploymentStepV1Schema))),
        }))) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    coverage: collectionCoverage,
});
export type DeploymentEnvironmentCollectionV1 = z.infer<typeof DeploymentEnvironmentCollectionV1Schema>;

/** Visible history facts projected from the page's opened contents; older transports may omit them. */
export const DeploymentReceiptHistoryV1Schema = z.strictObject({
    ok: z.literal(true), items: z.array(z.extend(DeploymentReceiptHeaderV1Schema, { title: z.optional(z.string()),
        /** Historical execution placement from this receipt's opened content, never today's target link. */
        machineIds: z.optional(z.array(DeploymentIdentifierV1Schema)),
        /** Opened receipt progress, including member steps; timing remains the execution owner's fact. */
        steps: z.optional(z.array(z.extend(DeploymentStepV1Schema, { machineId: z.optional(DeploymentIdentifierV1Schema) }))),
        source: z.optional(z.nullable(DeploymentReviewRevisionV1Schema)),
        failure: z.optional(z.nullable(DeploymentReceiptFailureV1Schema)) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    coverage: collectionCoverage,
});
export type DeploymentReceiptHistoryV1 = z.infer<typeof DeploymentReceiptHistoryV1Schema>;

/** Artifact bodies serialize ContentV1 directly. The Artifact owner opens its mode-aware envelope. */
export const DeploymentEnvironmentDetailV1Schema = z.strictObject({
    environment: DeploymentEnvironmentHeaderV1Schema,
    savedSecretRevisions: z.optional(DeploymentBindingSavedSecretRevisionsV1Schema),
    secretScope: z.optional(DeploymentEnvironmentSecretScopeV1Schema),
    controller: z.optional(DeploymentControllerAvailabilityV1Schema),
    content: DeploymentEnvironmentContentStoredReadV1Schema,
    targetLinks: z.array(z.strictObject({
        targetLink: DeploymentTargetLinkHeaderV1Schema,
        // Custody headers remain available without demanding private link bodies.
        content: z.optional(DeploymentTargetLinkContentV1Schema),
    })),
    /** Opened protected pending intent, scoped to the Environment detail demand. */
    pendingDeployment: z.optional(z.discriminatedUnion('status', [
        z.strictObject({ status: z.literal('ready'), intent: DeploymentPendingDeployIntentV1Schema,
            admission: DeploymentPendingAdmissionV1Schema }),
        z.strictObject({ status: z.literal('unavailable'), reason: z.string() }),
    ])),
    healthAggregate: z.optional(DeploymentEnvironmentHealthAggregateV1Schema),
});
export type DeploymentEnvironmentDetailV1 = z.infer<typeof DeploymentEnvironmentDetailV1Schema>;

export const DeploymentReceiptDetailV1Schema = z.strictObject({
    deployment: DeploymentReceiptHeaderV1Schema,
    content: DeploymentContentV1Schema,
    /** Supplied by the admitted receipt read, not private Artifact content or a client-side permission check. */
    cancellable: z.optional(z.boolean()),
    cancellationConsequence: z.optional(DeploymentCancellationConsequenceV1Schema),
});
export type DeploymentReceiptDetailV1 = z.infer<typeof DeploymentReceiptDetailV1Schema>;

/** One private-content projection for UI and agent reads; it grants no cancellation authority. */
export function projectDeploymentCancellationConsequenceV1(receipt: Pick<DeploymentReceiptDetailV1, 'deployment' | 'content'>): DeploymentCancellationConsequenceV1 | undefined {
    if (receipt.deployment.operation === 'teardown' || receipt.content.platform !== undefined) return undefined;
    if (receipt.content.machineResults.some(result => result.incumbentStopped === true)) {
        return { kind: 'service-down-until-rollback' };
    }
    if (!receipt.deployment.predecessorDeploymentId || receipt.deployment.state === 'queued'
        || receipt.deployment.state === 'succeeded' || receipt.deployment.state === 'running_unverified') return undefined;
    const ownServer = 'ownServer' in receipt.content ? receipt.content.ownServer : undefined;
    if (ownServer?.approvedInputBasis.ownServer?.rollout === 'startFirst') return undefined;
    const activating = receipt.content.steps.some(step => step.id === 'activate' && step.state === 'running')
        || ownServer?.stageLogs?.some(log => log.steps?.some(step => step.ref === 'activate' && step.range.end === null));
    return activating ? { kind: 'may-leave-service-down-until-rollback' } : undefined;
}
