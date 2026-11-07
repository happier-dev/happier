import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentBackupRetentionV1Schema } from './deploymentBackupActionsV1.js';
import { DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentIngressV1Schema, OwnServerEnvironmentReleasePolicyV1Schema } from './storedAppInputV1.js';
import { DeploymentPreviewTemplateV1Schema } from './deploymentPreviewTemplateV1.js';

/** Content authoring operands share one schema and classification across admission and preparation. */
export const DeploymentEnvironmentContentPatchV1Schema = lazyZodSchema(() => z.strictObject({
    ingress: z.optional(z.nullable(DeploymentIngressV1Schema)),
    backupRetention: z.optional(z.strictObject({ configRevision: DeploymentRevisionV1Schema,
        retention: DeploymentBackupRetentionV1Schema })),
    ownServer: z.optional(z.partial(OwnServerEnvironmentReleasePolicyV1Schema)),
    retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
    previewTemplate: z.optional(z.nullable(DeploymentPreviewTemplateV1Schema)),
}));

export function hasDeploymentEnvironmentContentPatchV1(patch: unknown): boolean {
    const value = readRecord(patch);
    return Object.keys(DeploymentEnvironmentContentPatchV1Schema.shape).some(key => value[key] !== undefined);
}
