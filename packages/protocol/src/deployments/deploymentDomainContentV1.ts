import { z } from 'zod/mini';
import { AccessProviderSelectionV1Schema } from '../plugins/contributions/accessProviders.js';
import { DeploymentDomainHealthCheckV1Schema } from './deploymentDomainHealthCheckV1.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';

const path = z.string().check(z.startsWith('/'));

/** Private desired routing input; native custody remains on the Domain owner. */
export const DeploymentDomainContentV1Schema = z.strictObject({
    hostname: text,
    target: z.strictObject({ service: text,
        containerPort: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
        path: z.optional(path), redirectTo: z.optional(text) }),
    healthCheck: z.optional(DeploymentDomainHealthCheckV1Schema),
    ingress: z.optional(AccessProviderSelectionV1Schema),
    cloudflarePreparation: z.optional(z.strictObject({
        tunnelId: text,
        owned: z.array(z.strictObject({ hostname: text, path: z.optional(path), expectedService: text })),
        dnsOwnership: z.array(z.strictObject({ hostname: text, recordId: text })),
        connectors: z.optional(z.array(z.strictObject({ machineId: text, installationId: text,
            imageRef: text, version: text, networkName: text, grantRef: text }))),
    })),
    tls: z.optional(z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('managed') }),
        z.strictObject({ kind: z.literal('custom') }),
    ])),
    basicAuth: z.optional(z.strictObject({ username: text })),
});
export type DeploymentDomainContentV1 = z.infer<typeof DeploymentDomainContentV1Schema>;
