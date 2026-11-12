import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

/** Shared reviewed DNS-record role. Values are semantic DNS values, before provider wire encoding. */
export const DeploymentDomainDnsRecordInputV1Schema = lazyZodSchema(() => z.strictObject({
    credentialRef: asProtocolZod(QualifiedConnectedAccountRefSchema),
    zoneId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)),
    type: z.string().check(z.minLength(1)),
    // RFC2181 section 8: the high bit is zero. The person supplies the TTL.
    ttl: z.number().check(z.int(), z.minimum(0), z.maximum(2147483647)),
    values: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
    changeId: z.optional(z.string().check(z.minLength(1))),
}));
export type DeploymentDomainDnsRecordInputV1 = z.infer<typeof DeploymentDomainDnsRecordInputV1Schema>;
export const DeploymentDomainDnsRecordInputV1ProtocolSchema = projectZodProtocolSchema(DeploymentDomainDnsRecordInputV1Schema);

/** The person selects DNS placement and TTL for this operation; no second DNS registry is retained. */
export const DeploymentDomainDnsInputV1Schema = lazyZodSchema(() => z.strictObject({
    serverId: id, environmentId: id, domainId: id, requestKey: id,
    expectedRevision: z.number().check(z.int(), z.nonnegative()),
    expectedDomainRevision: z.number().check(z.int(), z.nonnegative()),
    dns: z.extend(z.pick(DeploymentDomainDnsRecordInputV1Schema, { credentialRef: true, zoneId: true, ttl: true }),
        { action: asProtocolZod(PluginContributionIdentityV1Schema) }),
}));
export type DeploymentDomainDnsInputV1 = z.infer<typeof DeploymentDomainDnsInputV1Schema>;

/** Exact provider configuration is distinct from public DNS reachability and application health. */
export const DeploymentDomainDnsRecordResultV1Schema = lazyZodSchema(() => z.union([
    z.strictObject({ kind: z.enum(['pending', 'configured']), changeId: z.optional(z.string()) }),
    z.strictObject({ kind: z.enum(['refused', 'unknown']), code: z.string() }),
]));
export type DeploymentDomainDnsRecordResultV1 = z.infer<typeof DeploymentDomainDnsRecordResultV1Schema>;
export const DeploymentDomainDnsRecordResultV1ProtocolSchema = projectZodProtocolSchema(DeploymentDomainDnsRecordResultV1Schema);
export const DeploymentDomainDnsResultV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(true), domainId: id, records: z.array(z.strictObject({ name: z.string(), type: z.string(),
        result: DeploymentDomainDnsRecordResultV1Schema })),
}));
