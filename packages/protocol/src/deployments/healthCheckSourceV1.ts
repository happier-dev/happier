import { z } from 'zod/mini';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';
import { AutomationEventSourceInstanceIdV1Schema } from '../automations/automationEventJsonBoundsV1.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { HealthCheckSubjectV1Schema } from './healthCheckSubjectV1.js';

const positive = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)));
const keyword = lazyZodSchema(() => z.string().check(z.minLength(1)));
const httpStatus = lazyZodSchema(() => z.number().check(z.int(), z.minimum(100), z.maximum(599)));
const httpEndpoint = lazyZodSchema(() => z.string().check(z.refine(value => {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
    } catch { return false; }
})));

/** Domain identity lives on the binding; its path/status are read from that Domain. */
export const HealthCheckDomainHttpConfigV1Schema = lazyZodSchema(() => z.strictObject({ keyword: z.optional(keyword) }));
export type HealthCheckDomainHttpConfigV1 = z.infer<typeof HealthCheckDomainHttpConfigV1Schema>;
/** URL syntax only. Current subject/observer/DNS/redirect admission precedes network I/O. */
export const HealthCheckServiceHttpConfigV1Schema = lazyZodSchema(() => z.strictObject({
    endpoint: httpEndpoint, expectStatus: httpStatus, keyword: z.optional(keyword),
}));
export type HealthCheckServiceHttpConfigV1 = z.infer<typeof HealthCheckServiceHttpConfigV1Schema>;

export const HealthCheckTcpConfigV1Schema = lazyZodSchema(() => z.strictObject({
    host: keyword, port: z.number().check(z.int(), z.minimum(1), z.maximum(65535)),
}));
export type HealthCheckTcpConfigV1 = z.infer<typeof HealthCheckTcpConfigV1Schema>;
export const HealthCheckTcpConfigV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckTcpConfigV1Schema));

/** Native resolver record types; expectedAnswer compares the record's answer,
 * not transport metadata such as TTL, priority or weight. */
export const HealthCheckDnsConfigV1Schema = lazyZodSchema(() => z.strictObject({
    hostname: keyword, recordType: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'PTR', 'SRV', 'SOA', 'NAPTR', 'CAA']),
    expectedAnswer: z.optional(keyword),
}));
export type HealthCheckDnsConfigV1 = z.infer<typeof HealthCheckDnsConfigV1Schema>;
export const HealthCheckDnsConfigV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckDnsConfigV1Schema));

/** The containing check owns periodMs; the endpoint owns accepted receipt time. */
export const HealthCheckHeartbeatConfigV1Schema = lazyZodSchema(() => z.strictObject({
    webhookEndpointId: id, graceMs: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type HealthCheckHeartbeatConfigV1 = z.infer<typeof HealthCheckHeartbeatConfigV1Schema>;
export const HealthCheckHeartbeatConfigV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckHeartbeatConfigV1Schema));

/** One existing C1 condition, or the P40 aggregate input; never both for a check. */
export const HealthCheckConditionBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('healthCheck') }),
    z.strictObject({ kind: z.literal('domain'), domainId: id, targetLinkId: id,
        condition: z.enum(['domain_probe_failed', 'certificate_renewal_failed']) }),
    z.strictObject({ kind: z.literal('environmentHealth'), domainId: id, targetLinkId: id }),
]));
export type HealthCheckConditionBindingV1 = z.infer<typeof HealthCheckConditionBindingV1Schema>;

/** A kind's admitted recursively closed config schema validates config at source setup. */
export const HealthCheckDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
    checkId: id, kind: asProtocolZod(PluginContributionIdentityV1Schema),
    binding: HealthCheckConditionBindingV1Schema, config: PluginJsonValueV2Schema,
    periodMs: positive, consecutiveFailuresBeforeAlerting: positive,
}));
export type HealthCheckDefinitionV1 = z.infer<typeof HealthCheckDefinitionV1Schema>;

/** Assignment stays on the existing Automation materialization, outside sourceConfig. */
export const HealthCheckSourceConfigV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), subject: HealthCheckSubjectV1Schema,
    checks: z.array(HealthCheckDefinitionV1Schema).check(z.minLength(1)),
}).check(z.refine(source => new Set(source.checks.map(check => check.checkId)).size === source.checks.length
    && (source.subject.kind === 'environment' || source.checks.every(check => check.binding.kind === 'healthCheck')))));
export type HealthCheckSourceConfigV1 = z.infer<typeof HealthCheckSourceConfigV1Schema>;
export const HealthCheckSourceConfigV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSourceConfigV1Schema));

/** User Action operands reference saved checks; callers cannot replace endpoints or policy. */
export const SavedHealthCheckSelectorV1Schema = lazyZodSchema(() => z.strictObject({
    sourceInstanceId: AutomationEventSourceInstanceIdV1Schema, checkId: id,
}));
export type SavedHealthCheckSelectorV1 = z.infer<typeof SavedHealthCheckSelectorV1Schema>;
export const SavedHealthCheckSelectorV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SavedHealthCheckSelectorV1Schema));
