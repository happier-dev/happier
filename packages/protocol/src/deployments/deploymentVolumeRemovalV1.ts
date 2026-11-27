import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

const removed = z.strictObject({
    kind: z.literal('removed'),
    volume: z.optional(z.strictObject({ name: z.string().check(z.minLength(1)), provider: z.string().check(z.minLength(1)) })),
});
const kept = z.strictObject({
    kind: z.literal('kept'),
    otherEnvironments: z.number().check(z.int(), z.minimum(1)),
    url: z.url({ protocol: /^https$/ }),
});

export const DeploymentVolumeRemovalPreviewV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    removed, kept, z.strictObject({ kind: z.literal('unchecked') }),
]));
export const DeploymentVolumeRemovalOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    removed, kept, z.strictObject({ kind: z.literal('kept-unchecked') }),
]));
/** Provider display names for the exact scope of a removal. */
export const DeploymentRemovalProviderScopeV1Schema = z.strictObject({
    projectName: z.string().check(z.minLength(1)),
    environmentName: z.string().check(z.minLength(1)),
});

export const DeploymentTargetTeardownVolumePreviewV1Schema = lazyZodSchema(() => z.strictObject({
    providerScope: z.optional(DeploymentRemovalProviderScopeV1Schema),
    volumeRemoval: z.optional(DeploymentVolumeRemovalPreviewV1Schema),
}));
export const DeploymentTargetTeardownVolumePreviewV1ProtocolSchema =
    projectZodProtocolSchema(DeploymentTargetTeardownVolumePreviewV1Schema);
