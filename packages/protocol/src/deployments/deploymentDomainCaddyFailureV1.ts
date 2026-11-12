import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

export const deploymentDomainCaddyRequiredFactsV1 = [
    'caddyContainer', 'caddyMountedSeed', 'caddyAdminSocket', 'caddyAdminConfig',
    'caddyPublishedBindings', 'caddyListeners', 'caddyRoutedNetworks',
] as const;
export type DeploymentDomainCaddyRequiredFactV1 = typeof deploymentDomainCaddyRequiredFactsV1[number];
/** Safe native diagnostics only: command output and container error text stay private. */
export const DeploymentDomainCaddyFailureV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.enum(['native_observation_unavailable', 'native_effect_failed']),
    reason: z.enum(['required_fact_unavailable', 'native_effect_failed', 'port_in_use']),
    requiredFact: z.enum(deploymentDomainCaddyRequiredFactsV1),
    errorCode: z.optional(z.string().check(z.regex(/^(?:E[A-Z]+|HTTP_\d{3})$/))),
    stepId: z.optional(z.enum(['caddy-public-port', 'caddy-container-create', 'caddy-container-start',
        'caddy-container-stop', 'caddy-container-rm', 'caddy-container-wait', 'caddy-container-network-connect'])),
    nativeCommand: z.optional(z.strictObject({ command: z.literal('docker'),
        phase: z.enum(['create', 'start', 'stop', 'rm', 'wait', 'network-connect']),
        exitCode: z.nullable(z.number().check(z.int())) })),
    containerExitCode: z.optional(z.number().check(z.int())),
    containerError: z.optional(z.enum(['port_in_use', 'container_start_failed'])),
    port: z.optional(z.number().check(z.int(), z.gte(1), z.lte(65535))),
}));
export type DeploymentDomainCaddyFailureV1 = z.infer<typeof DeploymentDomainCaddyFailureV1Schema>;
/** The native Caddy owner supplies only classified facts and an operator remedy. */
export const DeploymentDomainCaddyFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    requiredFact: z.optional(DeploymentDomainCaddyFailureV1Schema.shape.requiredFact),
    failure: DeploymentDomainCaddyFailureV1Schema, remedy: id,
}));
export type DeploymentDomainCaddyFailureDetailsV1 = z.infer<typeof DeploymentDomainCaddyFailureDetailsV1Schema>;
