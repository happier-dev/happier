import { z } from 'zod/mini';
import { AccessProviderSelectionV1Schema } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { DeploymentTextV1Schema as text } from './ids.js';

const path = z.string().check(z.startsWith('/'));

/** Private desired routing input. Credential references remain Environment bindings;
 * native observations and installation custody live on their existing owners. */
export const DeploymentDomainContentV1Schema = z.strictObject({
    hostname: text,
    target: z.strictObject({ service: text,
        containerPort: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
        path: z.optional(path), redirectTo: z.optional(text) }),
    healthCheck: z.strictObject({ path,
        expectStatus: z.number().check(z.int(), z.minimum(100), z.maximum(599)) }),
    ingress: z.optional(AccessProviderSelectionV1Schema),
    /** Vendor acknowledgements and every captured native target stay in
     * this private Artifact, never the public Domain header or ingress config. */
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
