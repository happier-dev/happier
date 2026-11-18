import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { TriageEntryRefV1Schema, TriageSourceInstanceIdV1Schema } from '../tasks/entryRefV1.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import type { InboxArtifactAdmissionDispositionV1 } from '../artifacts/artifactKindV1.js';
import { AccountNoticeRecoveryChoicesV1Schema } from './accountNoticeRecoveryV1.js';
import { AttentionRemindAtV1Schema, resolveAttentionReminderV1, type AttentionReminderV1 } from './attentionReminderV1.js';
export { AccountNoticeRecoveryChoiceV1Schema, AccountNoticeRecoveryChoicesV1Schema,
  AccountNoticeDismissInputV1Schema, AccountNoticeDismissResultV1Schema,
  type AccountNoticeRecoveryChoiceV1, type AccountNoticeDismissInputV1 } from './accountNoticeRecoveryV1.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { AccountNoticePageV1Schema, ServiceHealthNoticePageV1Schema } from './accountNoticePageV1.js';
export { AccountNoticePageV1Schema, PluginNoticePageV1Schema, ServiceHealthNoticePageV1Schema, ServiceHealthNoticePageV1ProtocolSchema,
  ServiceHealthNoticeMachineV1Schema, ServiceHealthNoticeMachineV1ProtocolSchema,
  type ServiceHealthNoticePageV1, type ServiceHealthNoticeMachineV1 } from './accountNoticePageV1.js';
import { HealthAlertIdentityV1Schema } from './healthAlertIdentityV1.js';
import { DeploymentEnvironmentHealthAggregateV1Schema } from '../deployments/environmentHealthV1.js';
import { DeploymentIdentifierV1Schema, DeploymentTimestampV1Schema } from '../deployments/deploymentIdentifiersV1.js';
import { HealthCheckAlertsV1Schema } from '../deployments/healthCheckSourceV1.js';
export { DeploymentHealthStatusV1Schema, DeploymentHealthRoleV1Schema, DeploymentHealthRoleEvidenceV1Schema,
  DeploymentHealthMemberV1Schema, DeploymentEnvironmentHealthAggregateV1Schema,
  type DeploymentHealthStatusV1, type DeploymentHealthRoleV1, type DeploymentHealthRoleEvidenceV1,
  type DeploymentHealthMemberV1, type DeploymentEnvironmentHealthAggregateV1 } from '../deployments/environmentHealthV1.js';
export { HealthAlertIdentityV1Schema, healthAlertIdentityTupleV1, type HealthAlertIdentityV1 } from './healthAlertIdentityV1.js';
export { createHealthCheckSourceInstanceIdV1, HealthCheckSubjectV1Schema, HealthCheckSubjectV1ProtocolSchema, type HealthCheckSubjectV1 } from '../deployments/healthCheckSubjectV1.js';
export { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_KINDS_V1, HealthCheckKindV1Schema, HealthCheckStatusV1Schema,
  HealthCheckResultV1Schema, HealthCheckResultV1ProtocolSchema,
  type HealthCheckKindV1, type HealthCheckStatusV1, type HealthCheckResultV1 } from '../deployments/healthCheckV1.js';
export { HealthCheckDefinitionV1Schema, HealthCheckSourceConfigV1Schema, HealthCheckSourceConfigV1ProtocolSchema,
  HealthCheckAlertChannelV1Schema, HealthCheckAlertsV1Schema, type HealthCheckAlertChannelV1, type HealthCheckAlertsV1,
  HealthCheckSetupInputV1Schema, HealthCheckSetupInputV1ProtocolSchema, type HealthCheckSetupInputV1,
  HealthCheckSetupDraftV1Schema, HealthCheckSetupDraftV1ProtocolSchema, type HealthCheckSetupDraftV1,
  HealthCheckHttpConfigV1Schema, HealthCheckHttpConfigV1ProtocolSchema, type HealthCheckHttpConfigV1,
  HealthCheckTransitionV1Schema, HealthCheckTransitionV1ProtocolSchema, type HealthCheckTransitionV1,
  HealthCheckConditionBindingV1Schema, HealthCheckDomainHttpConfigV1Schema, HealthCheckServiceHttpConfigV1Schema,
  HealthCheckTcpConfigV1Schema, HealthCheckTcpConfigV1ProtocolSchema,
  HealthCheckDnsConfigV1Schema, HealthCheckDnsConfigV1ProtocolSchema,
  HealthCheckHeartbeatConfigV1Schema, HealthCheckHeartbeatConfigV1ProtocolSchema,
  SavedHealthCheckSelectorV1Schema, SavedHealthCheckSelectorV1ProtocolSchema,
  type HealthCheckDefinitionV1, type HealthCheckSourceConfigV1, type HealthCheckConditionBindingV1,
  type HealthCheckDomainHttpConfigV1, type HealthCheckServiceHttpConfigV1,
  type HealthCheckTcpConfigV1, type HealthCheckDnsConfigV1, type HealthCheckHeartbeatConfigV1,
  type SavedHealthCheckSelectorV1 } from '../deployments/healthCheckSourceV1.js';
import { ConnectedServiceUsageNotificationV1Schema, MachineVitalsNotificationV1Schema } from './usageNotificationFactsV1.js';
import { USAGE_NOTICE_ARTIFACT_KIND_V1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1 } from './accountNoticeArtifactKindsV1.js';
export { USAGE_NOTICE_ARTIFACT_KIND_V1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1 } from './accountNoticeArtifactKindsV1.js';

const UsageNoticeV1Schema = lazyZodSchema(() => z.union([
  ConnectedServiceUsageNotificationV1Schema, MachineVitalsNotificationV1Schema,
]));

export const UsageNoticeArtifactHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal(USAGE_NOTICE_ARTIFACT_KIND_V1), title: z.string().check(z.minLength(1)),
  status: z.enum(['open', 'dismissed']), notice: UsageNoticeV1Schema,
  // The incumbent Artifact writer refreshes this body-derived encrypted preview.
  excerpt: z.optional(z.string()),
}));
export const UsageNoticeArtifactBodyV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), notice: UsageNoticeV1Schema,
}));
export type UsageNoticeArtifactHeaderV1 = z.infer<typeof UsageNoticeArtifactHeaderV1Schema>;

// Mutation/identity/routing objects are closed. Stored readers drop unknown
// presentation fields; they never turn them into source or routing authority.
export const AccountNoticeItemTypeV1Schema = lazyZodSchema(() => z.enum(['decision', 'approval', 'blocked', 'update', 'mention']));
export const ServiceHealthNoticeSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('host'), topic: z.literal('service_health'), subject: HealthAlertIdentityV1Schema,
}));
export type ServiceHealthNoticeSourceV1 = z.infer<typeof ServiceHealthNoticeSourceV1Schema>;
export const ServiceHealthNoticeSourceV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ServiceHealthNoticeSourceV1Schema));
export const AccountNoticeSourceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), itemId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('host'), topic: z.enum(['connected_service_usage', 'resource_limit']) }),
  ServiceHealthNoticeSourceV1Schema,
]));
// The containing stored document may drop retired presentation fields, while
// source identity and executable page routing stay closed on read and write.
defineStoredReadProjection(AccountNoticeSourceV1Schema, () => AccountNoticeSourceV1Schema);
/** Data-only intent; current Triage/Action admission owns every execution decision. */
export const AccountNoticeInvestigationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('alertEntry'),
  entry: z.strictObject({
    entryRef: asProtocolZod(TriageEntryRefV1Schema),
    sourceInstanceId: asProtocolZod(TriageSourceInstanceIdV1Schema),
  }),
}));
export type AccountNoticeInvestigationV1 = z.infer<typeof AccountNoticeInvestigationV1Schema>;
// Stored presentation fields may be dropped; unknown routing operands cannot.
defineStoredReadProjection(AccountNoticeInvestigationV1Schema, () => AccountNoticeInvestigationV1Schema);
const accountNoticeContent = {
  v: z.literal(1), source: AccountNoticeSourceV1Schema, type: AccountNoticeItemTypeV1Schema,
  resolved: z.boolean(), page: z.optional(AccountNoticePageV1Schema), body: z.optional(z.string()),
  notice: z.optional(UsageNoticeV1Schema),
  healthPhase: z.optional(z.enum(['open', 'recovered'])),
  platformTransition: z.optional(z.strictObject({ transitionId: DeploymentIdentifierV1Schema, observedAtMs: DeploymentTimestampV1Schema })),
  environmentHealth: z.optional(DeploymentEnvironmentHealthAggregateV1Schema),
  investigation: z.optional(AccountNoticeInvestigationV1Schema),
  recoveryChoices: z.optional(AccountNoticeRecoveryChoicesV1Schema),
};
function validNoticeContent(value: z.infer<ReturnType<typeof noticeContentSchema>>) {
  if (value.platformTransition && (value.source.kind !== 'host' || value.source.topic !== 'service_health'
    || value.source.subject.kind !== 'platformTarget')) return false;
  if (value.environmentHealth) {
    const source = value.source;
    if (source.kind !== 'host' || source.topic !== 'service_health' || source.subject.kind !== 'environment'
      || source.subject.condition !== 'health' || source.subject.environmentId !== value.environmentHealth.environmentId
      || source.subject.targetLinkId !== value.environmentHealth.targetLinkId
      || value.healthPhase === 'recovered' && !value.environmentHealth.authoritativeRecovery) return false;
  }
  if (value.source.kind === 'plugin') return value.notice === undefined
    && value.recoveryChoices === undefined
    && (value.investigation === undefined || value.investigation.entry.entryRef.source.pluginId === value.source.pluginId)
    && (!value.page || !('kind' in value.page))
    && (value.healthPhase === undefined || (value.type === 'blocked' || value.type === 'update')
      && (value.healthPhase !== 'recovered' || value.type === 'update')
      && (!value.resolved || value.healthPhase === 'recovered'));
  if (value.source.topic !== 'service_health') return value.notice?.topic === value.source.topic
    && value.page === undefined && value.healthPhase === undefined && value.investigation === undefined && value.recoveryChoices === undefined;
  return value.notice === undefined && value.healthPhase !== undefined && value.investigation === undefined
    && (value.type === 'blocked' || value.type === 'update')
    && (value.healthPhase !== 'recovered' || value.type === 'update')
    && (!value.resolved || value.healthPhase === 'recovered') && matchingHealthPage(value.source, value.page)
    && matchingRecoveryChoices(value);
}
function matchingRecoveryChoices(value: z.infer<ReturnType<typeof noticeContentSchema>>) {
  if (!value.recoveryChoices) return true;
  const source = value.source;
  const page = value.page;
  if (source.kind !== 'host' || source.topic !== 'service_health'
    || !page || !('kind' in page)) return false;
  const subject = source.subject;
  if (page.page === 'machine_service') return subject.kind === 'deployment' && value.recoveryChoices.every(choice =>
    choice.actionId === 'deployments.restart' && choice.input.serverId === page.machine.serverId
      && sameStrictJsonValue(choice.input.service, subject)
    || choice.actionId === 'deployments.rollback' && choice.input.serverId === page.machine.serverId
      && choice.input.environmentId === subject.environmentId);
  if (subject.kind === 'backup') return value.recoveryChoices.every(choice => choice.actionId === 'deployments.backups.run'
    && choice.input.serverId === page.environment.serverId && choice.input.environmentId === subject.environmentId
    && choice.input.targetLinkId === page.targetLinkId);
  if (subject.kind !== 'environment' || subject.condition !== 'deployment_failed' && subject.condition !== 'health') return false;
  return value.recoveryChoices.every(choice => choice.actionId === 'inbox.notice.dismiss'
    || choice.actionId === 'deployments.restart' && subject.condition === 'health'
      && choice.input.serverId === page.environment.serverId && choice.input.environmentId === subject.environmentId
      && choice.input.targetLinkId === subject.targetLinkId
    || choice.actionId === 'deployments.rollback' && choice.input.serverId === page.environment.serverId
      && choice.input.environmentId === subject.environmentId && choice.input.targetLinkId === subject.targetLinkId);
}
function noticeContentSchema() { return z.strictObject(accountNoticeContent); }
function matchingHealthPage(source: ServiceHealthNoticeSourceV1, page: z.infer<typeof AccountNoticePageV1Schema> | undefined) {
  if (!page || !('kind' in page)) return false;
  const subject = source.subject;
  switch (subject.kind) {
    case 'healthCheck': return subject.subject.kind === 'machineService'
      ? page.page === 'machine_service' && page.machine.machineId === subject.subject.machineId
        && page.service.serviceId === subject.subject.serviceId
      : page.page === 'environment' && page.environment.environmentId === subject.subject.environmentId;
    case 'platformTarget':
    case 'environment':
    case 'domain': return page.page === 'environment' && page.environment.environmentId === subject.environmentId
      && page.targetLinkId === subject.targetLinkId;
    case 'backup': return page.page === 'environment' && page.environment.environmentId === subject.environmentId;
    default: return page.page === 'machine_service' && sameStrictJsonValue(subject, page.service);
  }
}
export const AccountNoticeArtifactBodyV1Schema = lazyZodSchema(() => noticeContentSchema().check(z.refine(validNoticeContent)));
export const AccountNoticeArtifactHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  ...accountNoticeContent, kind: z.literal(ACCOUNT_NOTICE_ARTIFACT_KIND_V1), title: z.string().check(z.minLength(1)),
  status: z.enum(['open', 'dismissed']), readAt: z.optional(z.number().check(z.int(), z.nonnegative())), excerpt: z.optional(z.string()),
  remindAt: z.optional(AttentionRemindAtV1Schema),
}).check(z.refine(validNoticeContent)));
export type AccountNoticeArtifactHeaderV1 = z.infer<typeof AccountNoticeArtifactHeaderV1Schema>;

export function canSetAccountNoticeReminderV1(header: AccountNoticeArtifactHeaderV1): boolean {
  return header.source.kind === 'plugin' && header.status === 'open' && !header.resolved;
}

/** Reminder state belongs to the recipient's private notice, outside source-authored content. */
export function readAccountNoticeReminderV1(header: AccountNoticeArtifactHeaderV1, nowMs: number): AttentionReminderV1 | null {
  return resolveAttentionReminderV1(canSetAccountNoticeReminderV1(header) ? header.remindAt : undefined, nowMs);
}

/** Authored operands, not a grant: the live catalog and Action front door re-admit a press. */
export const PluginNotificationPushContextV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema), categoryId: asProtocolZod(PluginContributionLocalIdSchema),
  occurrenceId: z.string().check(z.minLength(1)), clientRequestId: z.string().check(z.minLength(1)),
  buttonInputs: z.optional(z.record(z.string(), StrictJsonValueSchema)),
}));
export type PluginNotificationPushContextV1 = z.infer<typeof PluginNotificationPushContextV1Schema>;

/** No request/decision fields can acquire Session permission authority. */
export const AccountNoticePushDataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), topic: z.literal('account_notice'),
  accountId: z.string().check(z.minLength(1)), artifactId: z.string().check(z.minLength(1)),
  source: AccountNoticeSourceV1Schema, page: z.optional(AccountNoticePageV1Schema),
  pluginNotification: z.optional(PluginNotificationPushContextV1Schema),
  serverId: z.optional(z.string().check(z.minLength(1))), serverUrl: z.optional(z.string().check(z.minLength(1))),
}).check(z.refine(value => Boolean(value.serverId || value.serverUrl) && (value.source.kind === 'plugin'
  ? (!value.page || !('kind' in value.page)) && (!value.pluginNotification || value.pluginNotification.pluginId === value.source.pluginId)
  : value.source.topic === 'service_health' && value.pluginNotification === undefined && matchingHealthPage(value.source, value.page)
    && (!value.serverId || value.page && 'kind' in value.page
      && (value.page.page === 'machine_service' ? value.page.machine.serverId : value.page.environment.serverId) === value.serverId)))));

/** Delivery references an already committed C1 item; it never creates another. */
export const ServiceHealthNoticeNotificationV1Schema = lazyZodSchema(() => z.strictObject({
  topic: z.literal('service_health'), type: z.enum(['blocked', 'update']),
  healthPhase: z.optional(z.enum(['open', 'recovered'])),
  title: z.string().check(z.minLength(1)), body: z.optional(z.string()), data: AccountNoticePushDataV1Schema,
}).check(z.refine(value => value.data.source.kind === 'host' && value.data.source.topic === 'service_health')));
export type ServiceHealthNoticeNotificationV1 = z.infer<typeof ServiceHealthNoticeNotificationV1Schema>;

/** Operands for one exact-controller hop, not authority to create or replay a notice. */
export const CommittedServiceHealthDeliveryRequestV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)), serverId: z.string().check(z.minLength(1)),
  artifactId: z.string().check(z.minLength(1)), revision: ArtifactRevisionV1Schema,
  alerts: z.optional(HealthCheckAlertsV1Schema),
}));
export type CommittedServiceHealthDeliveryRequestV1 = z.infer<typeof CommittedServiceHealthDeliveryRequestV1Schema>;
export const CommittedServiceHealthDeliveryResultV1Schema = lazyZodSchema(() => z.strictObject({
  // Attempted means the canonical dispatcher ran, not that a provider delivered.
  kind: z.enum(['attempted', 'suppressed']),
}));

/** Push-only source navigation has Account custody without a persisted notice. */
export const PluginSessionPushDataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), topic: z.literal('plugin_session'), accountId: z.string().check(z.minLength(1)),
  sessionId: asProtocolZod(SessionIdSchema), serverId: z.string().check(z.minLength(1)), serverUrl: z.string().check(z.minLength(1)),
  pluginNotification: z.optional(PluginNotificationPushContextV1Schema),
}));

export type InboxItemTypeV1 = AccountNoticeArtifactHeaderV1['type'];
export type InboxItemViewV1 = 'needs_you' | 'updates' | 'mentions';
export function inboxItemViewV1(type: InboxItemTypeV1): InboxItemViewV1 {
  return type === 'mention' ? 'mentions' : type === 'update' ? 'updates' : 'needs_you';
}

export function inboxNoticeFocusKeyV1(serverId: string, artifactId: string): string {
  return `notice:${encodeURIComponent(serverId)}:${encodeURIComponent(artifactId)}`;
}

/** Shared transient notice row; source admission and page routing stay with their owners. */
export function projectAccountNoticeInboxItemV1(input: Readonly<{
  artifactId: string; serverId: string; createdAt: number; header: AccountNoticeArtifactHeaderV1;
  pageRoute: string; pluginDisplayName?: string | null; nowMs?: number;
}>) {
  const { header, artifactId, serverId } = input;
  if (header.status !== 'open' || header.resolved) return null;
  const reminder = readAccountNoticeReminderV1(header, input.nowMs ?? Date.now());
  const scheduled = reminder?.state === 'scheduled';
  return { key: `notice:${serverId}:${artifactId}`, producer: 'notice' as const, type: header.type,
    view: scheduled ? 'updates' as const : inboxItemViewV1(header.type), title: header.title, context: header.body ?? null,
    ...(scheduled ? { remindAt: reminder.remindAt } : {}),
    createdAt: input.createdAt, read: header.readAt !== undefined,
    focus: { kind: 'notice' as const, id: artifactId, serverId }, pageRoute: input.pageRoute,
    // The generic Artifact excerpt contains the serialized notice envelope.
    author: null, excerpt: header.body ?? null,
    source: { kind: 'account_notice', id: artifactId, serverId,
      ...(header.source.kind === 'plugin' ? { pluginId: header.source.pluginId } : {}),
      displayName: header.source.kind === 'plugin' ? input.pluginDisplayName ?? null : null } };
}

export function readAccountNoticeArtifactHeaderV1(raw: unknown): AccountNoticeArtifactHeaderV1 | null {
  const parsed = createStoredReadSchema(AccountNoticeArtifactHeaderV1Schema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function readAccountNoticeArtifactV1(input: Readonly<{ header: unknown; body: unknown }>): AccountNoticeArtifactHeaderV1 | null {
  const header = readAccountNoticeArtifactHeaderV1(input.header);
  if (!header || typeof input.body !== 'string') return null;
  try {
    const body = createStoredReadSchema(AccountNoticeArtifactBodyV1Schema).safeParse(JSON.parse(input.body));
    const expected = AccountNoticeArtifactBodyV1Schema.parse(Object.fromEntries(Object.keys(accountNoticeContent)
      .filter(key => Reflect.get(header, key) !== undefined).map(key => [key, Reflect.get(header, key)])));
    return body.success && sameStrictJsonValue(body.data, expected) ? header : null;
  } catch { return null; }
}

/** Content validation is not audience admission; readers retain Artifact access/mode checks. */
export function readUsageNoticeArtifactHeaderV1(raw: unknown): UsageNoticeArtifactHeaderV1 | null {
  const parsed = createStoredReadSchema(UsageNoticeArtifactHeaderV1Schema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function readUsageNoticeArtifactV1(input: Readonly<{ header: unknown; body: unknown }>): UsageNoticeArtifactHeaderV1 | null {
  const header = readUsageNoticeArtifactHeaderV1(input.header);
  if (!header || typeof input.body !== 'string') return null;
  try {
    const body = createStoredReadSchema(UsageNoticeArtifactBodyV1Schema).safeParse(JSON.parse(input.body));
    return body.success && sameStrictJsonValue(body.data.notice, header.notice) ? header : null;
  } catch { return null; }
}

export type OwnedNoticeArtifactAdmissionV1 =
  | Readonly<{ disposition: Extract<InboxArtifactAdmissionDispositionV1, 'presented'>; notice: AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1 }>
  | Readonly<{ disposition: Extract<InboxArtifactAdmissionDispositionV1, 'not_presented'>; reason: 'retired_source' }>
  | Readonly<{ disposition: Extract<InboxArtifactAdmissionDispositionV1, 'unreadable'> }>;

// Only identify the closed source; do not restore its former Follow payload or routing contract.
const RetiredNoticeContentSchema = lazyZodSchema(() => z.object({
  v: z.literal(1), type: AccountNoticeItemTypeV1Schema, resolved: z.boolean(),
  source: z.strictObject({ kind: z.literal('host'), topic: z.literal('follow_update') }),
  notice: z.looseObject({ topic: z.literal('follow_update') }),
}));
const RetiredNoticeHeaderSchema = lazyZodSchema(() => z.extend(RetiredNoticeContentSchema, {
  kind: z.literal(ACCOUNT_NOTICE_ARTIFACT_KIND_V1), title: z.string().check(z.minLength(1)),
  status: AccountNoticeArtifactHeaderV1Schema.shape.status,
}));

/** Authenticated Artifact facts, never a notice-supplied Account or audience. */
export function readOwnedNoticeArtifactAdmissionV1(artifact: Readonly<{
  artifactId?: string; id?: string;
  ownerAccountId?: string; access?: string; publicAudience?: string; header?: unknown; body?: unknown;
}>, accountId: string | null | undefined): OwnedNoticeArtifactAdmissionV1 {
  if (!accountId || artifact.ownerAccountId !== accountId || artifact.access !== 'owner' || artifact.publicAudience !== 'none') return { disposition: 'unreadable' };
  const content = { header: artifact.header, body: artifact.body };
  const notice = readAccountNoticeArtifactV1(content) ?? readUsageNoticeArtifactV1(content);
  if (notice) return notice.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 && notice.recoveryChoices?.some(choice =>
    choice.actionId === 'inbox.notice.dismiss' && choice.input.artifactId !== (artifact.artifactId ?? artifact.id))
    ? { disposition: 'unreadable' } : { disposition: 'presented', notice };
  if (typeof content.body === 'string') try {
    const header = RetiredNoticeHeaderSchema.safeParse(content.header);
    const body = RetiredNoticeContentSchema.safeParse(JSON.parse(content.body));
    if (header.success && body.success
      && sameStrictJsonValue(RetiredNoticeContentSchema.parse(header.data), body.data)) return { disposition: 'not_presented', reason: 'retired_source' };
  } catch { /* Unparseable content remains incomplete, including bodies claiming a retired source. */ }
  return { disposition: 'unreadable' };
}

/** Detail and mutation consumers only receive presentable current notices. */
export function readOwnedNoticeArtifactV1(artifact: Parameters<typeof readOwnedNoticeArtifactAdmissionV1>[0],
  accountId: string | null | undefined): AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1 | null {
  const result = readOwnedNoticeArtifactAdmissionV1(artifact, accountId);
  return result.disposition === 'presented' ? result.notice : null;
}

/** Retained usage notices enter the same Inbox row model without rewriting storage. */
export function normalizeAccountNoticeArtifactV1(notice: AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1): AccountNoticeArtifactHeaderV1 {
  return notice.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 ? notice : AccountNoticeArtifactHeaderV1Schema.parse({
    v: 1, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1, title: notice.title, status: notice.status,
    type: 'update', resolved: false, source: { kind: 'host', topic: notice.notice.topic }, notice: notice.notice,
    ...(notice.excerpt === undefined ? {} : { excerpt: notice.excerpt }),
  });
}

/** Compatibility projection for the incumbent usage-notice Inbox field and detail adapter. */
export function projectOpenUsageNoticeHeaderV1(header: AccountNoticeArtifactHeaderV1): UsageNoticeArtifactHeaderV1 | null {
  return header.status === 'open' && !header.resolved && header.source.kind === 'host' && header.notice
    ? { v: 1, kind: USAGE_NOTICE_ARTIFACT_KIND_V1, title: header.title, status: header.status, notice: header.notice,
      ...(header.excerpt === undefined ? {} : { excerpt: header.excerpt }) } : null;
}
