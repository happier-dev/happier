import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const DeployOutputV1Schema = lazyZodSchema(() => z.enum(['static', 'server', 'container', 'compose', 'workers', 'native']));
export const DeployVariableNameV1Schema = lazyZodSchema(() => z.strictObject({
    key: z.string().check(z.minLength(1)), secret: z.boolean(), purpose: z.optional(z.string()),
}));
export const DeployShapeV1Schema = lazyZodSchema(() => z.strictObject({
    framework: z.string().check(z.minLength(1)), output: DeployOutputV1Schema,
    data: z.optional(z.array(z.string())), variables: z.optional(z.array(DeployVariableNameV1Schema)),
}));
export type DeployShapeV1 = z.infer<typeof DeployShapeV1Schema>;

/** Declaration and host projection share these facts; absence means unknown support. */
export function deploymentTargetFitFieldsV1() {
    return {
        accepts: z.optional(z.array(DeployOutputV1Schema)),
        needs: z.optional(z.array(z.enum(['repository', 'stateless', 'volumes']))),
        sources: z.optional(z.strictObject({
            gitIntegration: z.array(z.string().check(z.minLength(1))),
            upload: z.boolean(),
        })),
    };
}
