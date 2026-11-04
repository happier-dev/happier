import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** The explicit HTTP probe shared by authored templates and private Domain content. */
export const DeploymentDomainHealthCheckV1Schema = lazyZodSchema(() => z.strictObject({
    path: z.string().check(z.startsWith('/')),
    expectStatus: z.number().check(z.int(), z.minimum(100), z.maximum(599)),
}));
export type DeploymentDomainHealthCheckV1 = z.infer<typeof DeploymentDomainHealthCheckV1Schema>;
