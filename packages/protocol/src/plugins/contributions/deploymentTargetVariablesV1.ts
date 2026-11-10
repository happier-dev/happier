import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from '../../deployments/deploymentIdentifiersV1.js';
import { projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';

/** Scope is the containing exact TargetLink and its recorded provider environment. */
export const DeploymentTargetOwnedVariableV1Schema = lazyZodSchema(() => z.strictObject({
    key: id, providerId: id, desiredRevision: revision, providerRevision: z.optional(id),
}));
export type DeploymentTargetOwnedVariableV1 = z.infer<typeof DeploymentTargetOwnedVariableV1Schema>;
/** Provider values never cross this projection, including plaintext variable values. */
export const DeploymentTargetVariableMetadataV1Schema = lazyZodSchema(() => z.strictObject({
    key: id, providerId: id, present: z.boolean(), secret: z.boolean(), owned: z.boolean(),
    drift: z.enum(['unknown', 'current', 'changed']), providerRevision: z.optional(id),
}));
export type DeploymentTargetVariableMetadataV1 = z.infer<typeof DeploymentTargetVariableMetadataV1Schema>;
export const DeploymentTargetVariablesReadResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), variables: z.array(DeploymentTargetVariableMetadataV1Schema),
}));
export type DeploymentTargetVariablesReadResultV1 = z.infer<typeof DeploymentTargetVariablesReadResultV1Schema>;
export const DeploymentTargetVariablesSyncResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), owned: z.array(DeploymentTargetOwnedVariableV1Schema),
    variables: z.array(DeploymentTargetVariableMetadataV1Schema),
    failures: z.array(z.strictObject({ key: id, code: z.enum(['deployment_conflict', 'deployment_content_unavailable',
        'provider_request_failed', 'provider_response_invalid', 'outcome_unknown', 'secret_use_client_required',
        'secret_missing', 'plugin_secret_custody_unavailable']) })),
}));
export type DeploymentTargetVariablesSyncResultV1 = z.infer<typeof DeploymentTargetVariablesSyncResultV1Schema>;
export const DeploymentTargetVariablesReadResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetVariablesReadResultV1Schema);
export const DeploymentTargetVariablesSyncResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentTargetVariablesSyncResultV1Schema);
