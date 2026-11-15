import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/**
 * The explicit HTTP probe shared by authored templates and private Domain content. Without `expectStatus` any answer
 * below 500 counts as reachable (the default check); with it, only that exact status does.
 */
export const DeploymentDomainHealthCheckV1Schema = lazyZodSchema(() => z.strictObject({
    path: z.string().check(z.startsWith('/')),
    expectStatus: z.optional(z.number().check(z.int(), z.minimum(100), z.maximum(599))),
}));
export type DeploymentDomainHealthCheckV1 = z.infer<typeof DeploymentDomainHealthCheckV1Schema>;

/** Whether an observed HTTP status satisfies a check: the exact expected status, or any answer below 500. */
export function deploymentDomainHealthStatusMatchesV1(status: number, expectStatus: number | undefined): boolean {
    return expectStatus === undefined ? status < 500 : status === expectStatus;
}

/**
 * The outside check a native Domain gets when its author names none: the root path, any answer below 500. Provider
 * Domains route at the platform and keep no check of ours; an authored check is kept as written.
 */
export function withDeploymentDomainHealthCheckDefaultV1<T extends Readonly<{
    target: Readonly<{ kind?: string }>;
    healthCheck?: DeploymentDomainHealthCheckV1;
}>>(content: T): T {
    if (content.healthCheck || content.target.kind === 'provider') return content;
    return { ...content, healthCheck: { path: '/' } };
}
