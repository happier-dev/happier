import { z } from '@happier-dev/protocol/zodRuntimePolicy';

import { DeploymentEnvironmentContentStoredReadV1Schema, DeploymentEnvironmentHeaderV1Schema } from '../artifacts/deploymentEnvironmentContent.js';
import { DeploymentTargetLinkContentV1Schema, DeploymentTargetLinkHeaderV1Schema } from '../targets/deploymentTargetContracts.js';
import { DeploymentContentV1Schema, DeploymentReceiptFailureV1Schema, DeploymentReceiptHeaderV1Schema, DeploymentStepV1Schema } from '../artifacts/deploymentReceiptRecord.js';
import { DeploymentIdentifierV1Schema } from '../artifacts/deploymentIdentity.js';
import { DeploymentEnvironmentHealthAggregateV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { DeploymentReviewRevisionV1Schema } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { DeploymentCancellationConsequenceV1Schema, type DeploymentCancellationConsequenceV1 } from '@happier-dev/protocol/deployments/deploymentStateV1';
import { DeploymentControllerAvailabilityV1Schema, hasDeploymentReceiptContentV1, type DeploymentReceiptGetInputV1, type DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { projectDeploymentReceiptInvestigationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
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
        /** Dedicated PostgreSQL on a native data target; omission is unknown, not eligible. */
        databaseMoveCandidate: z.optional(z.boolean()),
        /** Actual opened template configuration; omitted when the private Artifact is unavailable. */
        previewTemplateConfigured: z.optional(z.boolean()),
        /** The catalog listing an App was installed from (its pointer only), opened from the private template provenance. */
        catalogTemplate: z.optional(z.strictObject({ sourceId: z.string(), itemId: z.string(), version: z.string() })),
        /** Unknown unless the carried receipt is the runtime link's actual active deployment. */
        liveVersionTitle: z.optional(z.nullable(z.string())),
        /** Opened serving address; null means none resolved, omission means unknown. */
        liveAddress: z.optional(z.nullable(z.string())),
        runtimeTargetLink: z.optional(z.nullable(DeploymentTargetLinkHeaderV1Schema)),
        /** Current live health borrowed from the selected Environment read; omission means it is not observed. */
        healthAggregate: z.optional(DeploymentEnvironmentHealthAggregateV1Schema),
        currentDeployment: z.optional(z.nullable(z.extend(DeploymentReceiptHeaderV1Schema, {
            title: z.optional(z.string()),
            /** Latest-attempt source facts; omission means unreadable, null means not captured. */
            commitSubject: z.optional(z.nullable(z.string())),
            source: z.optional(z.nullable(DeploymentReviewRevisionV1Schema)),
            steps: z.optional(z.nullable(z.array(DeploymentStepV1Schema))),
        }))) })),
    nextCursor: z.nullable(DeploymentIdentifierV1Schema),
    /** Canonical collection total when explicitly requested and available. */
    totalCount: z.optional(z.number().check(z.int(), z.nonnegative())),
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
    /** The same dedicated native destination decision as the collection; backup admission settles separately. */
    databaseMoveCandidate: z.optional(z.boolean()),
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
    deployment: z.safeExtend(DeploymentReceiptHeaderV1Schema, { contentArtifactId: DeploymentIdentifierV1Schema }),
    content: DeploymentContentV1Schema,
    /** Supplied by the admitted receipt read, not private Artifact content or a client-side permission check. */
    cancellable: z.optional(z.boolean()),
    cancellationConsequence: z.optional(DeploymentCancellationConsequenceV1Schema),
});
export type DeploymentReceiptDetailV1 = z.infer<typeof DeploymentReceiptDetailV1Schema>;

export const DeploymentReceiptPresentationV1Schema = z.union([
    DeploymentReceiptDetailV1Schema,
    z.strictObject({
        deployment: z.safeExtend(DeploymentReceiptHeaderV1Schema, { contentArtifactId: z.null() }),
        content: z.null(),
    }),
]);
export type DeploymentReceiptPresentationV1 = z.infer<typeof DeploymentReceiptPresentationV1Schema>;

type DeploymentReceiptActionSuccessV1 = Extract<z.infer<typeof DeploymentReceiptGetResultV1Schema>, { ok: true }>;

/** Open private Action facts for the exact receipt selected by the admitted Home read. */
export async function readDeploymentReceiptActionFactsV1(
    receipt: DeploymentReceiptActionSuccessV1,
    address: Pick<DeploymentReceiptGetInputV1, 'deploymentId' | 'environmentId' | 'projection'>,
    open: (deployment: DeploymentReceiptDetailV1['deployment']) => Promise<DeploymentReceiptDetailV1 | ActionExecuteFailure>,
): Promise<DeploymentReceiptActionSuccessV1 | ActionExecuteFailure> {
    const { deployment } = receipt;
    if (deployment.id !== address.deploymentId || address.environmentId !== undefined
        && deployment.environmentId !== address.environmentId) {
        return { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' };
    }
    if (!hasDeploymentReceiptContentV1(deployment)) return receipt;
    const opened = await open(deployment);
    if ('errorCode' in opened) return opened;
    const { sourceIntent, failure: recorded, platform } = opened.content;
    const projected = { ...receipt,
        ...(address.projection === 'investigation' ? {
            investigation: projectDeploymentReceiptInvestigationV1({
                ...(sourceIntent === undefined ? {} : { sourceIntent }),
                ...(recorded === undefined ? {} : { failure: recorded }),
                ...(platform === undefined ? {} : { platform }),
            }),
        } : {}),
        ...(opened.cancellationConsequence ? { cancellationConsequence: opened.cancellationConsequence } : {}) };
    if (deployment.state !== 'failed') return projected;
    if (!recorded) return { ...projected, failureSummary: null };
    const { requiredFact, remedy } = projectDeploymentFailureRecoveryV1(recorded);
    return { ...projected, failureSummary: { phase: recorded.phase, code: recorded.code, requiredFact, remedy } };
}

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
