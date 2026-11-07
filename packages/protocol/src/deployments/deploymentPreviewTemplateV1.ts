import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { DeploymentDataParentBranchRefV1Schema } from '../plugins/contributions/deploymentTargets.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { DeploymentTextV1Schema as text, DeploymentTemplateRefV1Schema,
    EnvironmentVariableBindingV1Schema } from './storedAppInputV1.js';

/** Private selections reuse the exact template and managed-data references. */
export const DeploymentPreviewDataSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('template'), templateRef: DeploymentTemplateRefV1Schema,
        dataExportNames: z.array(text), connectTo: z.optional(z.strictObject({ service: text })) }),
    z.strictObject({ kind: z.literal('managed'), dataTargetLinkId: id,
        ownership: z.enum(['happierManaged', 'providerNative']), parentBranchRef: DeploymentDataParentBranchRefV1Schema }),
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
