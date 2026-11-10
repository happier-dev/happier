import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { DeploymentDataParentBranchRefV1Schema } from '../plugins/contributions/deploymentTargets.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { DeploymentTextV1Schema as text, DeploymentTemplateRefV1Schema,
    EnvironmentVariableBindingV1Schema, EnvironmentBackupDestinationBindingInputV1Schema } from './storedAppInputV1.js';
import { DeploymentBackupRestorePrepareInputV1Schema, DeploymentBackupRestoreRepositorySourceV1Schema } from './deploymentBackupRestoreV1.js';
import { DeploymentBackupConfigurationV1Schema } from './deploymentBackupActionsV1.js';

/** Private selections reuse the exact template and managed-data references. */
export const DeploymentPreviewDataSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('template'), templateRef: DeploymentTemplateRefV1Schema,
        dataExportNames: z.array(text), connectTo: z.optional(z.strictObject({ service: text })),
        copyFrom: z.optional(z.extend(z.pick(DeploymentBackupRestorePrepareInputV1Schema, {
            environmentId: true, targetLinkId: true, deploymentId: true,
        }), z.pick(DeploymentBackupRestoreRepositorySourceV1Schema, { snapshotId: true, backupOperationId: true }).shape)),
        destinationBackup: z.optional(z.strictObject({
            configuration: z.omit(DeploymentBackupConfigurationV1Schema, { ownership: true }),
            prefix: z.string(), bindings: z.array(EnvironmentBackupDestinationBindingInputV1Schema),
        })),
    }),
    z.strictObject({ kind: z.literal('managed'), dataTargetLinkId: id,
        ownership: z.enum(['happierManaged', 'providerNative']),
        parentBranchRef: z.extend(DeploymentDataParentBranchRefV1Schema, { displayName: z.optional(text) }) }),
]));
export type DeploymentPreviewDataSelectionV1 = z.infer<typeof DeploymentPreviewDataSelectionV1Schema>;

/** Template intent only: child admission owns runtime identity and binding authority. */
export const DeploymentPreviewTemplateV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), enabled: z.boolean(), forkPreviews: z.enum(['off', 'approveEachCommit']),
    repository: ScmHostingRepositoryIdentityV1Schema, runtimeTargetLinkId: id,
    domain: z.nullable(z.strictObject({ domainId: id, templateSlug: text, hostnamePattern: text })),
    bindingBlueprints: z.array(EnvironmentVariableBindingV1Schema), data: z.array(DeploymentPreviewDataSelectionV1Schema),
}));
export type DeploymentPreviewTemplateV1 = z.infer<typeof DeploymentPreviewTemplateV1Schema>;

/** The host admits the actual builder/runtime placement from complete Machine inventory. */
export const DeploymentPreviewForkEligibilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('eligible') }),
    z.strictObject({ kind: z.literal('ineligible'), reason: z.enum(['production_workload', 'unsupported_target']) }),
    z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['inventory_unavailable', 'inventory_incomplete', 'placement_unavailable']) }),
]));
export type DeploymentPreviewForkEligibilityV1 = z.infer<typeof DeploymentPreviewForkEligibilityV1Schema>;
