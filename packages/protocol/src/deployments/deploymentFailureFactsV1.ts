import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const DeploymentImageResolutionFailureV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('deploymentImageResolutionFailure'),
    service: z.string().check(z.regex(/^[a-z0-9_.-]+$/iu)),
    reference: z.optional(z.string().check(z.regex(/^(?!.*:\/\/)[a-z0-9._:/@\[\]-]+$/iu))),
    reason: z.enum([
        'deployment_image_not_found',
        'deployment_image_pull_denied',
        'deployment_image_rate_limited',
        'deployment_network_unavailable',
        'native_compose_command_failed',
    ]),
}));

/** Native Compose failures disclose the command token and a masked diagnostic excerpt, never arguments. */
export const DeploymentNativeComposeFailureV1Schema = lazyZodSchema(() => z.strictObject({
    subcommand: z.string().check(z.regex(/^[a-z][a-z-]*$/u)),
    exitStatus: z.number().check(z.int()),
    stderrTail: z.optional(z.string()),
}));
export type DeploymentNativeComposeFailureV1 = z.infer<typeof DeploymentNativeComposeFailureV1Schema>;

/** Existing activation evidence publishes names and exit status, never runnable environment values or raw logs. */
export const DeploymentNativeActivationFailureV1Schema = lazyZodSchema(() => z.strictObject({
    service: DeploymentImageResolutionFailureV1Schema.shape.service,
    exitStatus: z.number().check(z.int(), z.positive()),
    missingVariable: z.optional(z.string().check(z.regex(/^[A-Z_][A-Z0-9_]*$/u))),
}));
export type DeploymentNativeActivationFailureV1 = z.infer<typeof DeploymentNativeActivationFailureV1Schema>;

/** The fallback names the unavailable result, never an invented provider prerequisite. */
export const DeploymentFailureRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
    requiredFact: z.literal('deploymentActionResult'),
    nativeCompose: z.optional(DeploymentNativeComposeFailureV1Schema),
    nativeActivation: z.optional(DeploymentNativeActivationFailureV1Schema),
    statefulService: z.optional(DeploymentImageResolutionFailureV1Schema.shape.service),
    remedy: z.string().check(z.trim(), z.minLength(1)),
}));
