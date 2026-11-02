import { z } from 'zod/mini';
import { ScmHostingRepositoryIdentityV1Schema } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { DeploymentTemplateRefV1Schema, EnvironmentVariableBindingV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentDataParentBranchRefV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';

import { DeploymentIdentifierV1Schema as id, DeploymentTextV1Schema as text } from './ids.js';

/** Private selections reuse P45's exact template and managed-data references. */
export const DeploymentPreviewDataSelectionV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('template'), templateRef: DeploymentTemplateRefV1Schema,
        dataExportNames: z.array(text), connectTo: z.optional(z.strictObject({ service: text })) }),
    z.strictObject({ kind: z.literal('managed'), dataTargetLinkId: id,
        ownership: z.enum(['happierManaged', 'providerNative']), parentBranchRef: DeploymentDataParentBranchRefV1Schema }),
]);
export type DeploymentPreviewDataSelectionV1 = z.infer<typeof DeploymentPreviewDataSelectionV1Schema>;

/** Template intent only: child admission owns runtime identity and binding authority. */
export const DeploymentPreviewTemplateV1Schema = z.strictObject({
    v: z.literal(1), enabled: z.boolean(), forkPreviews: z.enum(['off', 'approveEachCommit']),
    repository: ScmHostingRepositoryIdentityV1Schema, runtimeTargetLinkId: id,
    domain: z.nullable(z.strictObject({ domainId: id, templateSlug: text, hostnamePattern: text })),
    bindingBlueprints: z.array(EnvironmentVariableBindingV1Schema), data: z.array(DeploymentPreviewDataSelectionV1Schema),
});
export type DeploymentPreviewTemplateV1 = z.infer<typeof DeploymentPreviewTemplateV1Schema>;

// The public parser and the private Environment body use the same dependency-only schema.
export { DeploymentPreviewProvenanceV1Schema, DeploymentPreviewProvenanceV1ProtocolSchema,
    type DeploymentPreviewProvenanceV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
