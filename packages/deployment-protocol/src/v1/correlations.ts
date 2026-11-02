import { z } from 'zod/mini';

const displayUrl = z.url({ protocol: /^https?$/u });

/** External display/deep-link facts only; never an approval or lifecycle gate. */
export const DeploymentCorrelationV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('forgeRun'), url: displayUrl }),
    z.strictObject({ kind: z.literal('forgeCheck'), url: displayUrl }),
    z.strictObject({ kind: z.literal('githubReview'), url: displayUrl }),
]);
export type DeploymentCorrelationV1 = z.infer<typeof DeploymentCorrelationV1Schema>;
