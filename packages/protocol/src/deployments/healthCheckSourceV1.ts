import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/publicTypes.js';
import { AutomationEventSourceInstanceIdV1Schema } from '../automations/automationEventJsonBoundsV1.js';
import { MachineTargetV1Schema } from '../machines/machineAccessV1.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { EnvironmentHealthCheckSubjectV1Schema, HealthCheckSubjectV1Schema, type HealthCheckSubjectV1 } from './healthCheckSubjectV1.js';
import type { AutomationPluginEventTrigger } from '../automations/automationTriggerProjectionV1.js';
import { isLoopbackHostname } from '../server/urls/loopbackHostname.js';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_EVENT_REFS_V1, HEALTH_CHECK_KINDS_V1, type HealthCheckKindV1 } from './healthCheckV1.js';
import type { DeploymentDomainHealthCheckV1 } from './deploymentDomainHealthCheckV1.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';

/** A listener reads saved transitions; it does not enroll or execute a probe. */
export const SavedHealthTransitionSourceV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), serverId: z.string().check(z.minLength(1)),
    observingSince: z.number().check(z.int(), z.nonnegative()),
    nativeSourceInstanceId: z.optional(AutomationEventSourceInstanceIdV1Schema),
}));
export type SavedHealthTransitionSourceV1 = z.infer<typeof SavedHealthTransitionSourceV1Schema>;
export const SavedHealthTransitionSourceV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SavedHealthTransitionSourceV1Schema));

export function createSavedHealthTransitionSourceInstanceIdV1(
    eventLocalId: string, source: SavedHealthTransitionSourceV1,
): string {
    return `health-saved:${computeCanonicalDomainSeparatedDigest('happier.health.saved-source.v1',
        [source.serverId, eventLocalId, String(source.observingSince), ...(source.nativeSourceInstanceId ? [source.nativeSourceInstanceId] : [])])}`;
}

/** Syntax-only projection shared by saved HTTP/certificate probes and their settings display. Admission remains with the host. */
export function readHealthCheckHttpTargetV1(target:
    | Readonly<{ hostname: string; healthCheck?: DeploymentDomainHealthCheckV1 }>
    | Readonly<{ endpoint: string; expectStatus: number }>,
): Readonly<{ url: string; expectStatus?: number }> | null {
    if ('hostname' in target && !target.healthCheck) return null;
    const address = 'hostname' in target ? `https://${target.hostname}${target.healthCheck!.path}` : target.endpoint;
    // Concatenation keeps an admitted hostname even when the configured path starts with //.
    const url = new URL(address);
    url.hash = '';
    // A Domain check without an expected status accepts any answer below 500 (deploymentDomainHealthStatusMatchesV1).
    const expectStatus = 'hostname' in target ? target.healthCheck!.expectStatus : target.expectStatus;
    return { url: url.href, ...(expectStatus === undefined ? {} : { expectStatus }) };
}

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
export const HealthCheckHttpConfigV1Schema = lazyZodSchema(() => z.union([
    HealthCheckDomainHttpConfigV1Schema, HealthCheckServiceHttpConfigV1Schema,
]));
export type HealthCheckHttpConfigV1 = z.infer<typeof HealthCheckHttpConfigV1Schema>;
export const HealthCheckHttpConfigV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckHttpConfigV1Schema));

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
const healthCheckBinding = lazyZodSchema(() => z.strictObject({ kind: z.literal('healthCheck') }));
const domainBinding = lazyZodSchema(() => z.strictObject({ kind: z.literal('domain'), domainId: id, targetLinkId: id,
    condition: z.enum(['domain_probe_failed', 'certificate_renewal_failed']) }));
const environmentHealthBinding = lazyZodSchema(() => z.strictObject({ kind: z.literal('environmentHealth'), domainId: id, targetLinkId: id }));
export const HealthCheckConditionBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    healthCheckBinding, domainBinding, environmentHealthBinding,
]));
export type HealthCheckConditionBindingV1 = z.infer<typeof HealthCheckConditionBindingV1Schema>;

/** A kind's admitted recursively closed config schema validates config at source setup. */
export const HealthCheckDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
    checkId: id, kind: asProtocolZod(PluginContributionIdentityV1Schema),
    binding: HealthCheckConditionBindingV1Schema, config: PluginJsonValueV2Schema,
    periodMs: positive, consecutiveFailuresBeforeAlerting: positive,
}));
export type HealthCheckDefinitionV1 = z.infer<typeof HealthCheckDefinitionV1Schema>;

function hasConsistentChecks(source: Readonly<{ subject: z.infer<typeof HealthCheckSubjectV1Schema>;
    checks: readonly Pick<HealthCheckDefinitionV1, 'checkId' | 'binding'>[] }>): boolean {
    const domainConditions = source.checks.flatMap(check => check.binding.kind === 'domain'
        ? [JSON.stringify([check.binding.domainId, check.binding.targetLinkId, check.binding.condition])] : []);
    return new Set(source.checks.map(check => check.checkId)).size === source.checks.length
        && new Set(domainConditions).size === domainConditions.length
        && (source.subject.kind === 'environment' || source.checks.every(check => check.binding.kind === 'healthCheck'));
}

/** Saved delivery choices contain references, never provider credentials. */
export const HealthCheckAlertChannelV1Schema = lazyZodSchema(() => z.strictObject({
    channelId: keyword,
    /** Provider-owned, non-secret destination references returned by its setup Action. */
    destination: z.optional(PluginJsonValueV2Schema),
}));
export type HealthCheckAlertChannelV1 = z.infer<typeof HealthCheckAlertChannelV1Schema>;
export const HealthCheckAlertsV1Schema = lazyZodSchema(() => z.strictObject({
    channels: z.array(HealthCheckAlertChannelV1Schema),
    phases: z.array(z.enum(['open', 'recovered'])),
}));
export type HealthCheckAlertsV1 = z.infer<typeof HealthCheckAlertsV1Schema>;

/** Assignment stays on the existing Automation materialization, outside sourceConfig. */
export const HealthCheckSourceConfigV1BaseSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), subject: HealthCheckSubjectV1Schema,
    checks: z.array(HealthCheckDefinitionV1Schema).check(z.minLength(1)),
    /** Absent on retained sources; an explicit empty selection stays off. */
    alerts: z.optional(HealthCheckAlertsV1Schema),
    investigation: z.optional(z.strictObject({ mode: z.literal('inbox') })),
}));
/** Environment notification choices use the same saved source before a probe is configured.
 * Keep the empty arm structural so portable Action/catalog validators retain the service check requirement. */
const emptyEnvironmentSource = lazyZodSchema(() => z.strictObject({
    ...HealthCheckSourceConfigV1BaseSchema.shape,
    subject: EnvironmentHealthCheckSubjectV1Schema,
    checks: z.array(HealthCheckDefinitionV1Schema).check(z.maxLength(0)),
}));
const environmentNotificationSource = lazyZodSchema(() => z.union([
    z.strictObject({ ...emptyEnvironmentSource.shape, alerts: HealthCheckAlertsV1Schema }),
    z.strictObject({ ...emptyEnvironmentSource.shape,
        investigation: z.nonoptional(HealthCheckSourceConfigV1BaseSchema.shape.investigation) }),
]));
// The notification arm has no checks, so only the probe arm needs the consistency refinement.
export const HealthCheckSourceConfigV1Schema = lazyZodSchema(() => z.union([
    HealthCheckSourceConfigV1BaseSchema.check(z.refine(hasConsistentChecks)), environmentNotificationSource,
]));
export type HealthCheckSourceConfigV1 = z.infer<typeof HealthCheckSourceConfigV1Schema>;
export const HealthCheckSourceConfigV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSourceConfigV1Schema));

export const HEALTH_CHECK_EVENT_SOURCE_SELECTION_V1 = {
    sourceContractVersion: 1, eventRefs: Object.values(HEALTH_CHECK_EVENT_REFS_V1),
} as const;
export function isHealthCheckEventSourceV1(source: Pick<AutomationPluginEventTrigger, 'eventRef' | 'sourceContractVersion'>): boolean {
    return source.sourceContractVersion === HEALTH_CHECK_EVENT_SOURCE_SELECTION_V1.sourceContractVersion
        && HEALTH_CHECK_EVENT_SOURCE_SELECTION_V1.eventRefs.some(ref =>
        ref.pluginId === source.eventRef.pluginId && ref.localId === source.eventRef.localId);
}

/** Display scope comes from the admitted source, independently of the observing Machine. */
export function readHealthCheckEventSubjectV1(sourceConfig: unknown): HealthCheckSubjectV1 | null {
    const source = HealthCheckSourceConfigV1Schema.safeParse(sourceConfig);
    return source.success ? source.data.subject : null;
}

function setupCheck<const Kind extends HealthCheckKindV1, Config extends z.ZodMiniType>(kind: Kind, config: Config) {
    return z.strictObject({ ...HealthCheckDefinitionV1Schema.shape,
        kind: z.strictObject({ pluginId: z.literal(HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1), localId: z.literal(kind) }),
        binding: healthCheckBinding, config });
}

function setupHttpCheck<const Kind extends 'http' | 'certificate'>(kind: Kind) {
    return z.union([
        setupCheck(kind, HealthCheckServiceHttpConfigV1Schema),
        z.strictObject({ ...setupCheck(kind, HealthCheckDomainHttpConfigV1Schema).shape,
            binding: z.union([domainBinding, environmentHealthBinding]) }),
    ]);
}

const setupChecksByKind = lazyDefinition(() => ({
    http: setupHttpCheck('http'),
    certificate: setupHttpCheck('certificate'),
    tcp: setupCheck('tcp', HealthCheckTcpConfigV1Schema),
    dns: setupCheck('dns', HealthCheckDnsConfigV1Schema),
    heartbeat: setupCheck('heartbeat', z.partial(HealthCheckHeartbeatConfigV1Schema, { webhookEndpointId: true })),
} satisfies Record<HealthCheckKindV1, z.ZodMiniType>));

// Keep native configuration validation in its existing arms. Contributed kinds
// carry JSON to their catalog schema at host setup, including same-plugin kinds.
const contributedSetupCheck = lazyZodSchema(() => {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const otherPlugin = new RegExp(`^(?!${escape(HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1)}$)[\\s\\S]+$`, 'u');
    const otherKind = new RegExp(`^(?!(?:${HEALTH_CHECK_KINDS_V1.map(escape).join('|')})$)[\\s\\S]+$`, 'u');
    return z.strictObject({ ...HealthCheckDefinitionV1Schema.shape,
        kind: z.intersection(asProtocolZod(PluginContributionIdentityV1Schema), z.union([
            z.strictObject({ pluginId: z.string().check(z.regex(otherPlugin)), localId: z.string() }),
            z.strictObject({ pluginId: z.literal(HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1), localId: z.string().check(z.regex(otherKind)) }),
        ])),
    });
});

/** Built-in authoring validates kind-specific input before endpoint enrollment.
 * Saved sourceConfig remains open to installed qualified check kinds. */
export const HealthCheckSetupInputV1BaseSchema = lazyZodSchema(() => z.strictObject({
    ...HealthCheckSourceConfigV1BaseSchema.shape,
    checks: z.array(z.union([...HEALTH_CHECK_KINDS_V1.map(kind => setupChecksByKind[kind]), contributedSetupCheck])).check(z.minLength(1)),
}));
export const HealthCheckSetupInputV1Schema = lazyZodSchema(() => z.union([
    HealthCheckSetupInputV1BaseSchema.check(z.refine(hasConsistentChecks)), environmentNotificationSource,
]));
export type HealthCheckSetupInputV1 = z.infer<typeof HealthCheckSetupInputV1Schema>;
export const HealthCheckSetupInputV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSetupInputV1Schema));

/** Launch intent names the admitted Domain; cadence is accepted in the setup editor. */
export const HealthCheckDomainSetupIntentV1Schema = lazyZodSchema(() => z.strictObject({ domainId: id, targetLinkId: id }));
export type HealthCheckDomainSetupIntentV1 = z.infer<typeof HealthCheckDomainSetupIntentV1Schema>;
export const HealthCheckDomainSetupIntentV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckDomainSetupIntentV1Schema));

/** The installed kind owns validation when the person applies the completed draft. */
const HealthCheckContributedSetupIntentV1Schema = lazyZodSchema(() => z.strictObject({
    kind: asProtocolZod(PluginContributionIdentityV1Schema),
    config: PluginJsonValueV2Schema,
}));
export const HealthCheckContributedSetupIntentV1ProtocolSchema = lazyDefinition(() =>
    projectZodProtocolSchema(HealthCheckContributedSetupIntentV1Schema));
const setupIntent = lazyZodSchema(() => z.strictObject({
    domain: z.optional(HealthCheckDomainSetupIntentV1Schema),
    newContributedCheck: z.optional(HealthCheckContributedSetupIntentV1Schema),
}));

/** Draft-only launch intent stays outside the saved source. */
const emptyEnvironmentDraft = lazyZodSchema(() => z.strictObject({
    ...z.partial(emptyEnvironmentSource).shape,
    subject: emptyEnvironmentSource.shape.subject,
    checks: emptyEnvironmentSource.shape.checks,
}));
export const HealthCheckSetupDraftV1Schema = lazyZodSchema(() => z.union([z.strictObject({
    ...z.partial(HealthCheckSetupInputV1BaseSchema).shape,
    ...setupIntent.shape,
}).check(z.refine(draft => !draft.domain || draft.subject?.kind === 'environment')),
z.strictObject({ ...emptyEnvironmentDraft.shape, ...setupIntent.shape }),
]));
export type HealthCheckSetupDraftV1 = z.infer<typeof HealthCheckSetupDraftV1Schema>;
export const HealthCheckSetupDraftV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSetupDraftV1Schema));

/** Configure prepares deliberate choices before cadence or endpoints are saved. */
export const HealthCheckSetupPreviewInputV1Schema = lazyZodSchema(() => z.union([z.strictObject({
    ...z.partial(HealthCheckSetupInputV1BaseSchema).shape,
    v: z.literal(1), mode: z.literal('preview'), subject: HealthCheckSubjectV1Schema,
}), z.strictObject({ ...emptyEnvironmentDraft.shape, v: z.literal(1), mode: z.literal('preview') }),
]));
export type HealthCheckSetupPreviewInputV1 = z.infer<typeof HealthCheckSetupPreviewInputV1Schema>;
export const HealthCheckSetupPreviewInputV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSetupPreviewInputV1Schema));

/** Only the saved source owner can supply the Test selector; defaults never do. */
export const HealthCheckSetupPreviewResultV1Schema = lazyZodSchema(() => z.strictObject({
    mode: z.literal('preview'), sourceConfig: HealthCheckSetupDraftV1Schema,
    destinationSelectionContext: z.optional(MachineTargetV1Schema),
    testContext: z.optional(z.strictObject({ serverId: id, machineId: id,
        sourceInstanceId: AutomationEventSourceInstanceIdV1Schema, expectedSourceRevision: keyword,
        templateVersion: z.optional(z.number().check(z.int(), z.minimum(1))) })),
}));
export type HealthCheckSetupPreviewResultV1 = z.infer<typeof HealthCheckSetupPreviewResultV1Schema>;
export const HealthCheckSetupPreviewResultV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSetupPreviewResultV1Schema));

/** Threshold decisions belong to the observer; consumers receive only its
 * committed transition, never endpoint configuration or probe evidence. */
export const HealthCheckTransitionV1Schema = lazyZodSchema(() => z.strictObject({
    sourceInstanceId: z.string(), subject: HealthCheckSubjectV1Schema, checkId: z.string(),
    transition: z.enum(['failed', 'recovered']), observedAt: z.number().check(z.int(), z.minimum(0)),
}));
export type HealthCheckTransitionV1 = z.infer<typeof HealthCheckTransitionV1Schema>;
export const HealthCheckTransitionV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckTransitionV1Schema));

/** User Action operands reference saved checks; callers cannot replace endpoints or policy. */
export const HealthCheckSourceSelectorV1Schema = lazyZodSchema(() => z.strictObject({
    sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
}));
export type HealthCheckSourceSelectorV1 = z.infer<typeof HealthCheckSourceSelectorV1Schema>;
export const HealthCheckSourceSelectorV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSourceSelectorV1Schema));

export const SavedHealthCheckSelectorV1Schema = lazyZodSchema(() => z.strictObject({
    ...HealthCheckSourceSelectorV1Schema.shape, checkId: id,
}));
export type SavedHealthCheckSelectorV1 = z.infer<typeof SavedHealthCheckSelectorV1Schema>;
export const SavedHealthCheckSelectorV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SavedHealthCheckSelectorV1Schema));

/**
 * Loopback means "the Machine running the check". A check run anywhere but the
 * watched service's own Machine would reach itself, so the saved-check producer
 * refuses it; setup forms read the same rule before saving. Only the host-bearing
 * kinds (TCP host, HTTP/certificate endpoint) can be refused, and only once the
 * config parses.
 */
export function isHealthCheckLoopbackRefusedV1(input: Readonly<{
    subject: z.infer<typeof HealthCheckSubjectV1Schema>; observerMachineId: string; kindLocalId: string; config: unknown;
}>): boolean {
    if (input.subject.kind !== 'machineService' || input.observerMachineId === input.subject.machineId) return false;
    if (input.kindLocalId === 'tcp') {
        const config = HealthCheckTcpConfigV1Schema.safeParse(input.config);
        return config.success && isLoopbackHostname(config.data.host);
    }
    if (input.kindLocalId !== 'http' && input.kindLocalId !== 'certificate') return false;
    const config = HealthCheckServiceHttpConfigV1Schema.safeParse(input.config);
    return config.success && isLoopbackHostname(new URL(config.data.endpoint).hostname);
}
