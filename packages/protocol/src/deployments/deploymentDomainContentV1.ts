import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AccessProviderSelectionV1Schema } from '../plugins/contributions/accessProviders.js';
import { DeploymentDomainHealthCheckV1Schema } from './deploymentDomainHealthCheckV1.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';
import { DeploymentDomainProviderResultV1Schema, DeploymentDomainProviderZoneV1Schema } from './deploymentDomainProviderResultV1.js';
export { DeploymentDomainProviderResultV1Schema, type DeploymentDomainProviderResultV1 } from './deploymentDomainProviderResultV1.js';

const path = z.string().check(z.startsWith('/'));

/** Private desired routing input; native custody remains on the Domain owner. */
export const DeploymentDomainContentV1Schema = lazyZodSchema(() => z.strictObject({
    hostname: text,
    target: z.union([z.strictObject({ service: text, kind: z.optional(z.literal('native')),
        containerPort: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
        path: z.optional(path), redirectTo: z.optional(text) }),
    z.strictObject({ kind: z.literal('provider'), zone: z.optional(DeploymentDomainProviderZoneV1Schema), service: z.optional(z.never()), containerPort: z.optional(z.never()),
        path: z.optional(z.never()), redirectTo: z.optional(z.never()) })]),
    providerObservation: z.optional(DeploymentDomainProviderResultV1Schema),
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
}));
export type DeploymentDomainContentV1 = z.infer<typeof DeploymentDomainContentV1Schema>;

/** The configured ingress address remains the address even when that route redirects. */
export function readDeploymentDomainServingUrlV1(content: unknown): string | null {
    const parsed = DeploymentDomainContentV1Schema.safeParse(content);
    if (!parsed.success) return null;
    try {
        const hostname = parsed.data.hostname.trim();
        if (/[\s/%\\?#@:]/u.test(hostname) || hostname.includes('*')) return null;
        const address = new URL(`https://${hostname}`);
        if (address.port || address.username || address.password || address.pathname !== '/' || address.search || address.hash) return null;
        address.pathname = parsed.data.target.path ?? '/';
        return address.href;
    } catch { return null; }
}
