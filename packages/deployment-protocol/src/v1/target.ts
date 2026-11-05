import { z } from 'zod/mini';
import { DeploymentTargetLinkHeaderV1Schema, DeploymentTargetLinkMetadataV1Schema, DeploymentTargetLinkMemberV1Schema, DeploymentTargetSourceV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PluginActionIconV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PluginLocalizedStringV2Schema } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createDeploymentTargetRuntimeActionsV1Schema, createDeploymentTargetDataV1Schema, DeploymentTargetLinkProviderContentV1Schema,
    type DeploymentTargetContributionV1 } from '@happier-dev/protocol/plugins/contributions/v2';
export { DeploymentDataParentBranchRefV1Schema, type DeploymentDataParentBranchRefV1 } from '@happier-dev/protocol/plugins/contributions/v2';
export { DeploymentTargetCredentialPrincipalV1Schema, DeploymentTargetProviderIdentityV1Schema,
    DeploymentTargetProviderEnvironmentV1Schema, DeploymentTargetRepositoryAccessV1Schema,
    DeploymentTargetPreparedNativeV1Schema, DeploymentTargetPreparedNativeV1ProtocolSchema,
    DeploymentTargetRoleCommonInputV1Schema, DeploymentTargetLifecycleInputV1Schema,
    DeploymentTargetPreparationBaseV1Schema, DeploymentTargetPreparationBaseV1ProtocolSchema, hasDeploymentTargetPreparationCoordinatesV1,
    DeploymentTargetPriorDeploymentRefV1Schema, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema,
    DeploymentTargetInspectInputV1Schema, DeploymentTargetLinkRoleInputV1Schema, DeploymentTargetDeployInputV1Schema,
    DeploymentTargetUploadDeployInputV1Schema, DeploymentTargetObserveInputV1Schema, DeploymentTargetCancelInputV1Schema,
    DeploymentTargetRollbackInputV1Schema, DeploymentTargetPromoteInputV1Schema, DeploymentTargetTeardownInputV1Schema,
    DeploymentTargetRoleInputSchemasV1, DeploymentTargetRoleResultV1Schema, DeploymentTargetRoleFailureV1Schema,
    DeploymentTargetFailureTransitionV1Schema, DeploymentTargetFailureTransitionV1ProtocolSchema,
    type DeploymentTargetCredentialPrincipalV1, type DeploymentTargetProviderIdentityV1,
    type DeploymentTargetProviderEnvironmentV1, type DeploymentTargetRepositoryAccessV1,
    type DeploymentTargetPreparedNativeV1,
    type DeploymentTargetRoleCommonInputV1, type DeploymentTargetLifecycleInputV1,
    type DeploymentTargetPreparationBaseV1, type DeploymentTargetPriorDeploymentRefV1,
    type DeploymentTargetInspectInputV1, type DeploymentTargetLinkRoleInputV1,
    type DeploymentTargetDeployInputV1, type DeploymentTargetUploadDeployInputV1,
    type DeploymentTargetObserveInputV1, type DeploymentTargetCancelInputV1,
    type DeploymentTargetRollbackInputV1, type DeploymentTargetPromoteInputV1, type DeploymentTargetTeardownInputV1,
    type DeploymentTargetRuntimeRoleV1, type DeploymentTargetRoleInputV1,
    type DeploymentTargetRoleResultV1, type DeploymentTargetRoleFailureV1,
    type DeploymentTargetFailureTransitionV1 } from '@happier-dev/protocol/plugins/contributions/v2';

import { deploymentStoredContentV1Schema } from './storedContent.js';
import { DeploymentIdentifierV1Schema as id } from './ids.js';

export const DeploymentActionRefV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('host'), actionId: ActionIdSchema }),
    z.strictObject({ kind: z.literal('plugin'), actionId: z.string().check(z.refine(value => parseQualifiedPluginActionId(value) !== null)) }),
]);
export type DeploymentActionRefV1 = z.infer<typeof DeploymentActionRefV1Schema>;

export const DeploymentResourceRefV1Schema = z.strictObject({ kind: z.literal('plugin'),
    resourceId: z.string().check(z.refine(value => parseQualifiedPluginContributionKey(value) !== null)),
});
export type DeploymentResourceRefV1 = z.infer<typeof DeploymentResourceRefV1Schema>;

type NormalizedTargetBase = {
    v: 1;
    source: z.infer<typeof DeploymentTargetSourceV1Schema>;
};
export type DeploymentRuntimeTargetV1 = Omit<Extract<DeploymentTargetContributionV1, { role: 'runtime' }>, 'actions'> & NormalizedTargetBase & {
    actions: z.infer<ReturnType<typeof createDeploymentTargetRuntimeActionsV1Schema<typeof DeploymentActionRefV1Schema>>>;
};
export type DeploymentDataTargetV1 = Omit<Extract<DeploymentTargetContributionV1, { role: 'data' }>, 'dataV1'> & NormalizedTargetBase & {
    dataV1?: z.infer<ReturnType<typeof createDeploymentTargetDataV1Schema<typeof DeploymentActionRefV1Schema, typeof DeploymentResourceRefV1Schema>>> | undefined;
};
export type DeploymentTargetV1 = DeploymentRuntimeTargetV1 | DeploymentDataTargetV1;

const normalizedFields = () => ({
    v: z.literal(1), id, source: DeploymentTargetSourceV1Schema, targetKind: id,
    title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema), icon: PluginActionIconV2Schema,
    targetSchema: PluginJsonSchemaV2Schema, linkSchema: PluginJsonSchemaV2Schema,
});

/** Both normalized roles consume the declaration owner's closed role grammar. */
export const DeploymentTargetV1Schema: z.ZodMiniType<DeploymentTargetV1> = z.discriminatedUnion('role', [
    z.strictObject({ ...normalizedFields(), role: z.literal('runtime'),
        actions: createDeploymentTargetRuntimeActionsV1Schema(DeploymentActionRefV1Schema),
        failureTransitionEvent: z.optional(z.string().check(z.refine(value => parseQualifiedPluginContributionKey(value) !== null))) }),
    z.strictObject({ ...normalizedFields(), role: z.literal('data'),
        dataV1: z.optional(createDeploymentTargetDataV1Schema(DeploymentActionRefV1Schema, DeploymentResourceRefV1Schema)) }),
]).check(z.refine(target => {
    if (target.role === 'data') {
        if (target.source.kind !== 'plugin') return true;
        const pluginId = target.source.contribution.pluginId;
        return Object.values(target.dataV1 ?? {}).every(group => !group || Object.values(group).every(ref => !ref
            || ref.kind === 'plugin' && ('actionId' in ref
                ? parseQualifiedPluginActionId(ref.actionId)?.pluginId === pluginId
                : parseQualifiedPluginContributionKey(ref.resourceId)?.pluginId === pluginId)));
    }
    if (target.failureTransitionEvent !== undefined && (target.source.kind !== 'plugin'
        || parseQualifiedPluginContributionKey(target.failureTransitionEvent)?.pluginId !== target.source.contribution.pluginId)) return false;
    const upload = target.actions.uploadDeploy;
    if (!upload) return true;
    return target.source.kind === 'plugin' && upload.kind === 'plugin'
        && parseQualifiedPluginActionId(upload.actionId)?.pluginId === target.source.contribution.pluginId;
}, { message: 'Contributed role references must belong to the target plugin.' }));
export { DeploymentTargetLinkHeaderV1Schema, DeploymentTargetLinkMemberV1Schema, DeploymentTargetSourceV1Schema };
/** Replacements preserve workload identity only along their admitted Environment lineage. */
export function getDeploymentTargetLinkLineageV1(link: Readonly<{ id: string; environmentId: string; predecessorTargetLinkId?: string | undefined }>,
    retainedLinks: readonly Readonly<{ id: string; environmentId: string; predecessorTargetLinkId?: string | undefined }>[],
): ReadonlySet<string> {
    const links = new Map(retainedLinks.filter(value => value.environmentId === link.environmentId).map(value => [value.id, value]));
    const lineage = new Set([link.id]);
    let predecessor = link.predecessorTargetLinkId;
    while (predecessor && !lineage.has(predecessor)) {
        lineage.add(predecessor);
        predecessor = links.get(predecessor)?.predecessorTargetLinkId;
    }
    return lineage;
}
export { DeploymentTargetScopeV1Schema, DeploymentTargetLinksListInputV1Schema, DeploymentTargetLinksListResultV1Schema, DeploymentTargetLinkAlreadyLinkedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export type { DeploymentTargetLinkHeaderV1, DeploymentTargetScopeV1, DeploymentTargetLinksListInputV1, DeploymentTargetLinksListResultV1,
    DeploymentTargetLinkAlreadyLinkedResultV1 } from '@happier-dev/protocol';
/** Target-host capture only; Machine and installation identity stay on link membership. */
export const DeploymentNativeComposeOriginV1Schema = z.strictObject({
    projectName: z.string().check(z.minLength(1)),
    dockerEndpoint: z.string().check(z.minLength(1)),
    workingDirectory: z.string().check(z.minLength(1)),
    capture: z.optional(z.strictObject({ installationId: id,
    })),
});
export type DeploymentNativeComposeOriginV1 = z.infer<typeof DeploymentNativeComposeOriginV1Schema>;
export const DeploymentOwnServerTargetLinkContentV1Schema = z.strictObject({
    nativeOrigin: z.optional(DeploymentNativeComposeOriginV1Schema),
});
export type DeploymentOwnServerTargetLinkContentV1 = z.infer<typeof DeploymentOwnServerTargetLinkContentV1Schema>;
export const DeploymentTargetLinkContentV1Schema = z.extend(DeploymentOwnServerTargetLinkContentV1Schema,
    z.partial(DeploymentTargetLinkProviderContentV1Schema).shape,
).check(z.refine(content => content.credentialPrincipal === undefined && content.providerEnvironment === undefined
    && content.repositoryAccess === undefined || content.credentialPrincipal !== undefined
        && content.providerEnvironment !== undefined && content.providerIdentity !== undefined,
{ message: 'Operational platform links require the complete recorded principal, identity and native scope.' }));
export type DeploymentTargetLinkContentV1 = z.infer<typeof DeploymentTargetLinkContentV1Schema>;
export const DeploymentTargetLinkStoredContentV1Schema = deploymentStoredContentV1Schema(DeploymentTargetLinkContentV1Schema);
export type DeploymentTargetLinkStoredContentV1 = z.infer<typeof DeploymentTargetLinkStoredContentV1Schema>;
export const DeploymentTargetLinkV1Schema = z.extend(DeploymentTargetLinkMetadataV1Schema, {
    content: DeploymentTargetLinkStoredContentV1Schema,
});
export type DeploymentTargetLinkV1 = z.infer<typeof DeploymentTargetLinkV1Schema>;
