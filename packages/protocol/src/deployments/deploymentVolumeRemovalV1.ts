import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

const removed = z.strictObject({ kind: z.literal('removed') });
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
export const DeploymentTargetTeardownVolumePreviewV1Schema = lazyZodSchema(() => z.strictObject({
    volumeRemoval: z.optional(DeploymentVolumeRemovalPreviewV1Schema),
}));
export const DeploymentTargetTeardownVolumePreviewV1ProtocolSchema =
    projectZodProtocolSchema(DeploymentTargetTeardownVolumePreviewV1Schema);
