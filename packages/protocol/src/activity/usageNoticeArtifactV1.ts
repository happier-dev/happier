export { HealthCheckSubjectV1Schema, HealthCheckSubjectV1ProtocolSchema, type HealthCheckSubjectV1 } from '../deployments/healthCheckSubjectV1.js';
export { HEALTH_CHECK_KINDS_V1, HealthCheckKindV1Schema, HealthCheckStatusV1Schema,
  HealthCheckResultV1Schema, HealthCheckResultV1ProtocolSchema,
  type HealthCheckKindV1, type HealthCheckStatusV1, type HealthCheckResultV1 } from '../deployments/healthCheckV1.js';
export { HealthCheckDefinitionV1Schema, HealthCheckSourceConfigV1Schema, HealthCheckSourceConfigV1ProtocolSchema,
  HealthCheckConditionBindingV1Schema, HealthCheckDomainHttpConfigV1Schema, HealthCheckServiceHttpConfigV1Schema,
  HealthCheckTcpConfigV1Schema, HealthCheckTcpConfigV1ProtocolSchema,
  HealthCheckDnsConfigV1Schema, HealthCheckDnsConfigV1ProtocolSchema,
  HealthCheckHeartbeatConfigV1Schema, HealthCheckHeartbeatConfigV1ProtocolSchema,
  SavedHealthCheckSelectorV1Schema, SavedHealthCheckSelectorV1ProtocolSchema,
  type HealthCheckDefinitionV1, type HealthCheckSourceConfigV1, type HealthCheckConditionBindingV1,
  type HealthCheckDomainHttpConfigV1, type HealthCheckServiceHttpConfigV1,
  type HealthCheckTcpConfigV1, type HealthCheckDnsConfigV1, type HealthCheckHeartbeatConfigV1,
  type SavedHealthCheckSelectorV1 } from '../deployments/healthCheckSourceV1.js';
import { z } from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { AccountNoticePageV1Schema } from './accountNoticePageV1.js';
export { AccountNoticePageV1Schema } from './accountNoticePageV1.js';
import { ConnectedServiceUsageNotificationV1Schema, MachineVitalsNotificationV1Schema } from './webhookPayload.js';
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
export const AccountNoticeSourceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('plugin'), pluginId: z.string().check(z.minLength(1)), itemId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('host'), topic: z.enum(['connected_service_usage', 'resource_limit']) }),
]));
// The containing stored document may drop retired presentation fields, while
// source identity and executable page routing stay closed on read and write.
defineStoredReadProjection(AccountNoticeSourceV1Schema, () => AccountNoticeSourceV1Schema);
const accountNoticeContent = {
  v: z.literal(1), source: AccountNoticeSourceV1Schema, type: AccountNoticeItemTypeV1Schema,
  resolved: z.boolean(), page: z.optional(AccountNoticePageV1Schema), body: z.optional(z.string()),
  notice: z.optional(UsageNoticeV1Schema),
};
export const AccountNoticeArtifactBodyV1Schema = lazyZodSchema(() => z.strictObject(accountNoticeContent).check(z.refine(value =>
  value.source.kind === 'host' ? value.notice?.topic === value.source.topic && value.page === undefined : value.notice === undefined)));
export const AccountNoticeArtifactHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  ...accountNoticeContent, kind: z.literal(ACCOUNT_NOTICE_ARTIFACT_KIND_V1), title: z.string().check(z.minLength(1)),
  status: z.enum(['open', 'dismissed']), readAt: z.optional(z.number().check(z.int(), z.nonnegative())), excerpt: z.optional(z.string()),
}).check(z.refine(value =>
  value.source.kind === 'host' ? value.notice?.topic === value.source.topic && value.page === undefined : value.notice === undefined)));
export type AccountNoticeArtifactHeaderV1 = z.infer<typeof AccountNoticeArtifactHeaderV1Schema>;

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
  pageRoute: string; pluginDisplayName?: string | null;
}>) {
  const { header, artifactId, serverId } = input;
  if (header.status !== 'open' || header.resolved) return null;
  return { key: `notice:${serverId}:${artifactId}`, producer: 'notice' as const, type: header.type,
    view: inboxItemViewV1(header.type), title: header.title, context: header.body ?? null,
    createdAt: input.createdAt, read: header.readAt !== undefined,
    focus: { kind: 'notice' as const, id: artifactId, serverId }, pageRoute: input.pageRoute,
    author: null, excerpt: header.body ?? header.excerpt ?? null,
    source: { kind: 'account_notice', id: artifactId, serverId,
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

/** Authenticated Artifact facts, never a notice-supplied Account or audience. */
export function readOwnedNoticeArtifactV1(artifact: Readonly<{
  ownerAccountId?: string; access?: string; publicAudience?: string; header?: unknown; body?: unknown;
}>, accountId: string | null | undefined): AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1 | null {
  if (!accountId || artifact.ownerAccountId !== accountId || artifact.access !== 'owner' || artifact.publicAudience !== 'none') return null;
  const content = { header: artifact.header, body: artifact.body };
  return readAccountNoticeArtifactV1(content) ?? readUsageNoticeArtifactV1(content);
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
