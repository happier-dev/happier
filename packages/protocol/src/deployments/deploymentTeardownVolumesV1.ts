import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';

/** Deliberate data deletion is confirmed once at the Action input boundary. */
export const DeploymentTeardownVolumesV1Schema = lazyZodSchema(() => z.array(z.discriminatedUnion('disposition', [
    z.strictObject({ name: DeploymentIdentifierV1Schema, disposition: z.literal('keep') }),
    z.strictObject({ name: DeploymentIdentifierV1Schema, disposition: z.literal('delete'), confirmation: z.string() })
        .check(z.refine(value => value.confirmation === value.name, { message: 'Type the exact volume name to delete it.' })),
])).check(z.refine(values => new Set(values.map(value => value.name)).size === values.length,
    { message: 'Choose each volume once.' })));
export type DeploymentTeardownVolumesV1 = z.infer<typeof DeploymentTeardownVolumesV1Schema>;
/** Native preview provision retains only its observed database volume identities. */
export const DeploymentPreviewCleanupV1Schema = lazyZodSchema(() => z.strictObject({
    machines: z.array(DeploymentIdentifierV1Schema).check(z.minLength(1),
        z.refine(values => new Set(values).size === values.length)),
    volumes: DeploymentTeardownVolumesV1Schema.check(z.refine(values => values.every(value => value.disposition === 'delete'))),
}));
export type DeploymentPreviewCleanupV1 = z.infer<typeof DeploymentPreviewCleanupV1Schema>;
export const DeploymentTeardownPreviewV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(true), kind: z.literal('preview'),
    volumes: z.array(z.strictObject({ name: DeploymentIdentifierV1Schema, machineId: DeploymentIdentifierV1Schema })),
}));
export type DeploymentTeardownPreviewV1 = z.infer<typeof DeploymentTeardownPreviewV1Schema>;
