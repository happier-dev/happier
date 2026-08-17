import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { PluginAgentExternalSessionLinkDataSchema } from '../../plugins/contributions/agentExternalSessions.js';
import { RuntimeDescriptorV1Schema } from '../metadata/runtimeDescriptorV1.js';
import {
  ExternalSessionsAgentIdSchema,
  ExternalSessionsSourceSchema,
} from './sourceCatalog.js';
import type { ExternalSessionTranscriptRawMessageV1 } from './daemonRpcV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

export type ExternalSessionFollowPolicy = 'attached_only' | 'background_follow';

export type ExternalSessionFollowPolicyV1 = Readonly<{
  v: 1;
  policy: ExternalSessionFollowPolicy;
  updatedAtMs?: number;
}>;

const ExternalSessionFollowPolicyV1Schema = z.object({
  v: z.literal(1),
  policy: z.enum(['attached_only', 'background_follow']),
  updatedAtMs: z.number().finite().nonnegative()
    .transform((value) => Math.trunc(value)).optional(),
}).strict();

export const ExternalSessionFollowStatusValueV1Schema = z.enum([
  'disabled',
  'paused',
  'reacquiring',
  'active',
  'error',
]);

export type ExternalSessionFollowStatusValueV1 = z.infer<
  typeof ExternalSessionFollowStatusValueV1Schema
>;

export const ExternalSessionFollowStatusV1Schema = z.object({
  v: z.literal(1),
  status: ExternalSessionFollowStatusValueV1Schema,
  reason: z.string().trim().min(1).max(256).optional(),
  updatedAtMs: z.number().int().min(0),
}).strict();

export type ExternalSessionFollowStatusV1 = z.infer<
  typeof ExternalSessionFollowStatusV1Schema
>;

export const ExternalSessionFollowIssueV1Schema = z.object({
  v: z.literal(1),
  code: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(2_000).optional(),
  retryable: z.boolean().optional(),
  observedAtMs: z.number().int().min(0),
}).strict();

export type ExternalSessionFollowIssueV1 = z.infer<
  typeof ExternalSessionFollowIssueV1Schema
>;

export type ExternalSessionAttentionV1 = Readonly<{
  observedProgressToken?: string;
  viewedProgressToken?: string;
  observedAtMs?: number;
  viewedAtMs?: number;
}>;

export type ExternalSessionObservedProgress = Readonly<{
  token: string;
  atMs: number;
}>;

export const LinkedExternalSessionQualifiedIdentityV1Schema = z.object({
  v: z.literal(1),
  agent: asProtocolZod(PluginContributionIdentityV1Schema),
  source: z.object({
    kind: z.string().trim().min(1).max(256),
    contractVersion: z.literal(1),
  }).strict(),
}).strict();

export type LinkedExternalSessionQualifiedIdentityV1 = z.infer<
  typeof LinkedExternalSessionQualifiedIdentityV1Schema
>;

export function buildLinkedExternalSessionQualifiedIdentityV1(input: Readonly<{
  agent: z.input<typeof PluginContributionIdentityV1Schema>;
  sourceKind: string;
}>): LinkedExternalSessionQualifiedIdentityV1 {
  return LinkedExternalSessionQualifiedIdentityV1Schema.parse({
    v: 1,
    agent: input.agent,
    source: {
      kind: input.sourceKind,
      contractVersion: 1,
    },
  });
}

// Released/predecessor read compatibility is intentionally scoped to the
// `directSessionV1` envelope, whose immutable writers used `providerId`.
function normalizeLegacyLinkedExternalSessionIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, 'providerId')
    || Object.hasOwn(record, 'agentId')
    || Object.hasOwn(record, 'runtimeDescriptorV1')
    || Object.hasOwn(record, 'qualifiedIdentity')
    || Object.hasOwn(record, 'linkData')
  ) {
    return undefined;
  }
  const legacyAgentId = ExternalSessionsAgentIdSchema.safeParse(record.providerId);
  if (!legacyAgentId.success) return undefined;
  const { providerId: _legacyProviderId, agentRuntimeDescriptorV1, ...rest } = record;
  const runtimeDescriptor = RuntimeDescriptorV1Schema.safeParse(
    agentRuntimeDescriptorV1,
  );
  return {
    ...rest,
    agentId: legacyAgentId.data,
    ...(runtimeDescriptor.success ? { runtimeDescriptorV1: runtimeDescriptor.data } : {}),
  };
}

const LinkedExternalSessionV1Schema = z
  .object({
    v: z.literal(1),
    agentId: ExternalSessionsAgentIdSchema,
    machineId: z.string().min(1),
    remoteSessionId: z.string().min(1),
    source: ExternalSessionsSourceSchema,
    qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema.optional(),
    linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
    linkedAtMs: z.number().int().min(0).optional(),
    lastKnownActivityAtMs: z.number().int().min(0).optional(),
    followPolicyV1: ExternalSessionFollowPolicyV1Schema.optional(),
    followStatusV1: ExternalSessionFollowStatusV1Schema.optional(),
    lastFollowIssueV1: ExternalSessionFollowIssueV1Schema.optional(),
    // This explicitly declared Codex leaf remains extensible; the Codex plugin
    // validates its value in resolveLinkIdentity.
    codexBackendMode: z.string().optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
  })
  .strict()
  .superRefine((link, ctx) => {
    if (Object.hasOwn(link, 'providerId') || Object.hasOwn(link, 'agentRuntimeDescriptorV1')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Canonical external-session metadata cannot use released legacy identity fields.',
      });
    }
    if (link.qualifiedIdentity && link.qualifiedIdentity.source.kind !== link.source.kind) {
      ctx.addIssue({
        code: 'custom',
        path: ['qualifiedIdentity', 'source', 'kind'],
        message: 'Qualified external-session source kind must match the linked source.',
      });
    }
  });

const ReleasedLinkedExternalSessionV1Schema = z.preprocess(
  normalizeLegacyLinkedExternalSessionIdentity,
  LinkedExternalSessionV1Schema,
);

export type LinkedExternalSessionV1 = z.infer<typeof LinkedExternalSessionV1Schema>;

export const ExternalHistoryImportV1Schema = z.object({
  v: z.literal(1),
  agentId: ExternalSessionsAgentIdSchema,
  remoteSessionId: z.string().trim().min(1).max(2_000),
  importedAtMs: z.number().int().min(0),
  source: ExternalSessionsSourceSchema,
  linkData: PluginAgentExternalSessionLinkDataSchema.optional(),
}).strict();

export type ExternalHistoryImportV1 = z.infer<typeof ExternalHistoryImportV1Schema>;

export type ExternalHistoryImportMetadataResolutionV1 =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'valid';
      historyImport: ExternalHistoryImportV1;
    }>
  | Readonly<{
      state: 'invalid';
      error: 'external_history_import_invalid';
    }>;

// Stable cli-v0.2.1, preview cli-v0.2.2-preview.1775586717.26498, and the
// inspected predecessor remote-dev@17bcdb9e24479ee5fa642c53ccdcfe883eb9cc81
// persisted this tombstone with `providerId`. Keep this read adapter until
// those writers are unsupported and their persisted layout-0 rows are
// migrated or proven absent. Canonical writes remain agentId-only through
// ExternalHistoryImportV1Schema.
function normalizeReleasedExternalHistoryImportIdentity(value: unknown): unknown {
  const record = asRecord(value);
  if (!record || !Object.hasOwn(record, 'providerId')) return value;
  if (Object.hasOwn(record, 'agentId') || Object.hasOwn(record, 'linkData')) {
    return undefined;
  }
  const legacyAgentId = ExternalSessionsAgentIdSchema.safeParse(record.providerId);
  if (!legacyAgentId.success) return undefined;
  const { providerId: _legacyProviderId, ...rest } = record;
  return {
    ...rest,
    agentId: legacyAgentId.data,
  };
}

const LEGACY_LINKED_SESSION_METADATA_KEY = 'direct' + 'SessionV1';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function resolveExternalHistoryImportV1FromMetadata(
  metadata: unknown,
): ExternalHistoryImportMetadataResolutionV1 {
  const record = asRecord(metadata);
  if (!record || !Object.hasOwn(record, 'externalHistoryImportV1')) {
    return { state: 'absent' };
  }
  const parsed = ExternalHistoryImportV1Schema.safeParse(
    normalizeReleasedExternalHistoryImportIdentity(record.externalHistoryImportV1),
  );
  return parsed.success
    ? { state: 'valid', historyImport: parsed.data }
    : { state: 'invalid', error: 'external_history_import_invalid' };
}

export function readExternalHistoryImportV1FromMetadata(
  metadata: unknown,
): ExternalHistoryImportV1 | null {
  const resolution = resolveExternalHistoryImportV1FromMetadata(metadata);
  return resolution.state === 'valid' ? resolution.historyImport : null;
}

function projectReleasedProjectIdLinkData(
  link: LinkedExternalSessionV1,
): LinkedExternalSessionV1 {
  if (
    link.qualifiedIdentity !== undefined
    || link.linkData !== undefined
    || link.source.kind !== 'claudeConfig'
  ) {
    return link;
  }

  const source = asRecord(link.source);
  const projectId = typeof source?.projectId === 'string'
    ? source.projectId.trim()
    : '';
  if (!projectId) return link;

  // Read-forward support for cli-v0.2.1 (b1d15a8),
  // cli-v0.2.2-preview.1775586717.26498 (4913c1e), and the inspected
  // remote-dev predecessor at 17bcdb9e: those writers persisted Claude's
  // project identity only in source.projectId. The public Claude contribution
  // owns strict current linkData writes, so this projection is intentionally
  // limited to unqualified persisted rows. Remove it only after those writers
  // are unsupported and historical source-only rows are migrated or absent.
  return {
    ...link,
    linkData: PluginAgentExternalSessionLinkDataSchema.parse({ projectId }),
  };
}

function readCanonicalLinkedExternalSessionV1(value: unknown): LinkedExternalSessionV1 | null {
  const parsed = LinkedExternalSessionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readReleasedLinkedExternalSessionV1(value: unknown): LinkedExternalSessionV1 | null {
  const parsed = ReleasedLinkedExternalSessionV1Schema.safeParse(value);
  return parsed.success ? projectReleasedProjectIdLinkData(parsed.data) : null;
}

export function buildLinkedExternalSessionMetadataV1(
  metadata: unknown,
  link: LinkedExternalSessionV1,
): Record<string, unknown> {
  const parsed = LinkedExternalSessionV1Schema.parse(link);
  const record = asRecord(metadata) ?? {};
  const { [LEGACY_LINKED_SESSION_METADATA_KEY]: _released, ...currentRecord } = record;

  return {
    ...currentRecord,
    externalSessionV1: parsed,
  };
}

export type LinkedExternalSessionMetadataResolutionV1 =
  | Readonly<{
      ok: true;
      source: 'canonical' | 'released' | 'reconciled_legacy_follow_policy';
      linkedSession: LinkedExternalSessionV1;
    }>
  | Readonly<{
      ok: false;
      error: 'linked_session_not_found' | 'linked_session_invalid' | 'linked_session_reconciliation_required';
      reason:
        | 'metadata_not_object'
        | 'canonical_invalid'
        | 'legacy_invalid'
        | 'identity_conflict'
        | 'source_conflict'
        | 'runtime_conflict'
        | 'follow_policy_conflict'
        | 'unsupported_mutable_field_conflict';
    }>;

function areSemanticallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areSemanticallyEqual(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) =>
        key === rightKeys[index]
        && areSemanticallyEqual(leftRecord[key], rightRecord[key]),
    );
}

function reconciliationRequired(
  reason: Extract<
    LinkedExternalSessionMetadataResolutionV1,
    Readonly<{ ok: false }>
  >['reason'],
): LinkedExternalSessionMetadataResolutionV1 {
  return {
    ok: false,
    error: 'linked_session_reconciliation_required',
    reason,
  };
}

/**
 * Canonical persisted-link admission for current and provenance-supported
 * historical dual-envelope rows. Current writes emit only the canonical
 * envelope. If a predecessor mutated only its historical row, this owner must
 * not silently select stale canonical data.
 *
 * Only follow policy has a provenance-proven timestamped merge contract.
 * Identity, source, runtime, and every other mutable-field divergence requires
 * explicit relink/reconciliation before an effect. Remove the dual-row branch
 * with the rollback projection after the supported old readers/writers and
 * historical dual rows are unreachable.
 */
export function resolveLinkedExternalSessionMetadataV1(
  metadata: unknown,
): LinkedExternalSessionMetadataResolutionV1 {
  const record = asRecord(metadata);
  if (!record) {
    return {
      ok: false,
      error: 'linked_session_not_found',
      reason: 'metadata_not_object',
    };
  }

  const hasCanonical = Object.hasOwn(record, 'externalSessionV1');
  const hasLegacy = Object.hasOwn(record, LEGACY_LINKED_SESSION_METADATA_KEY);
  const canonical = hasCanonical
    ? readCanonicalLinkedExternalSessionV1(record.externalSessionV1)
    : null;
  if (hasCanonical && !canonical) {
    return {
      ok: false,
      error: 'linked_session_invalid',
      reason: 'canonical_invalid',
    };
  }
  if (!canonical) {
    const legacy = hasLegacy
      ? readReleasedLinkedExternalSessionV1(record[LEGACY_LINKED_SESSION_METADATA_KEY])
      : null;
    return legacy
      ? { ok: true, source: 'released', linkedSession: legacy }
      : {
          ok: false,
          error: hasLegacy ? 'linked_session_invalid' : 'linked_session_not_found',
          reason: hasLegacy ? 'legacy_invalid' : 'metadata_not_object',
        };
  }
  if (!hasLegacy) {
    return { ok: true, source: 'canonical', linkedSession: canonical };
  }

  const legacy = readReleasedLinkedExternalSessionV1(
    record[LEGACY_LINKED_SESSION_METADATA_KEY],
  );
  if (!legacy) return reconciliationRequired('legacy_invalid');

  if (
    canonical.agentId !== legacy.agentId
    || canonical.machineId !== legacy.machineId
    || canonical.remoteSessionId !== legacy.remoteSessionId
    || canonical.linkedAtMs !== legacy.linkedAtMs
  ) {
    return reconciliationRequired('identity_conflict');
  }
  if (!areSemanticallyEqual(canonical.source, legacy.source)) {
    return reconciliationRequired('source_conflict');
  }
  if (
    !areSemanticallyEqual(
      canonical.runtimeDescriptorV1,
      legacy.runtimeDescriptorV1,
    )
    || canonical.codexBackendMode !== legacy.codexBackendMode
  ) {
    return reconciliationRequired('runtime_conflict');
  }

  const canonicalPolicyRaw = canonical.followPolicyV1;
  const legacyPolicyRaw = legacy.followPolicyV1;
  let linkedSession = canonical;
  let source: Extract<
    LinkedExternalSessionMetadataResolutionV1,
    Readonly<{ ok: true }>
  >['source'] = 'canonical';
  if (!areSemanticallyEqual(canonicalPolicyRaw, legacyPolicyRaw)) {
    const canonicalPolicy = readExternalSessionFollowPolicyV1(canonicalPolicyRaw);
    const legacyPolicy = readExternalSessionFollowPolicyV1(legacyPolicyRaw);
    if (
      !canonicalPolicy
      || !legacyPolicy
      || canonicalPolicy.updatedAtMs === undefined
      || legacyPolicy.updatedAtMs === undefined
      || canonicalPolicy.updatedAtMs === legacyPolicy.updatedAtMs
    ) {
      return reconciliationRequired('follow_policy_conflict');
    }
    if (legacyPolicy.updatedAtMs > canonicalPolicy.updatedAtMs) {
      linkedSession = {
        ...canonical,
        followPolicyV1: legacyPolicy,
      };
      source = 'reconciled_legacy_follow_policy';
    }
  }

  const {
    qualifiedIdentity: _canonicalQualifiedIdentity,
    linkData: _canonicalLinkData,
    followPolicyV1: _canonicalFollowPolicy,
    ...canonicalShared
  } = canonical;
  const {
    qualifiedIdentity: _legacyQualifiedIdentity,
    linkData: _legacyLinkData,
    followPolicyV1: _legacyFollowPolicy,
    ...legacyShared
  } = legacy;
  if (!areSemanticallyEqual(canonicalShared, legacyShared)) {
    return reconciliationRequired('unsupported_mutable_field_conflict');
  }

  return { ok: true, source, linkedSession };
}

export function readLinkedExternalSessionV1FromMetadata(metadata: unknown): LinkedExternalSessionV1 | null {
  const resolved = resolveLinkedExternalSessionMetadataV1(metadata);
  return resolved.ok ? resolved.linkedSession : null;
}

export function normalizeLinkedExternalSessionMetadataV1(metadata: unknown): Record<string, unknown> | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const resolved = resolveLinkedExternalSessionMetadataV1(record);
  return resolved.ok
    ? buildLinkedExternalSessionMetadataV1(record, resolved.linkedSession)
    : record;
}

export function removeLinkedExternalSessionMetadataV1(metadata: unknown): Record<string, unknown> {
  const record = asRecord(metadata);
  const next: Record<string, unknown> = record ? { ...record } : {};
  delete next.externalSessionV1;
  delete next[LEGACY_LINKED_SESSION_METADATA_KEY];
  return next;
}

function normalizeOptionalToken(value: unknown): string | undefined {
  const token = typeof value === 'string' ? value.trim() : '';
  return token || undefined;
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function buildProgressToken(message: Pick<ExternalSessionTranscriptRawMessageV1, 'createdAtMs' | 'id'>): string {
  return `${message.createdAtMs}:${message.id}`;
}

function compareProgressTokens(left: string, right: string): number {
  return left.localeCompare(right);
}

export function readExternalSessionFollowPolicyV1(value: unknown): ExternalSessionFollowPolicyV1 | null {
  const parsed = ExternalSessionFollowPolicyV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return {
    v: 1,
    policy: parsed.data.policy,
    ...(parsed.data.updatedAtMs !== undefined
      ? { updatedAtMs: parsed.data.updatedAtMs }
      : {}),
  };
}

export function readExternalSessionFollowStatusV1(
  value: unknown,
): ExternalSessionFollowStatusV1 | null {
  const parsed = ExternalSessionFollowStatusV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return {
    v: 1,
    status: parsed.data.status,
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    updatedAtMs: parsed.data.updatedAtMs,
  };
}

export function readExternalSessionFollowIssueV1(
  value: unknown,
): ExternalSessionFollowIssueV1 | null {
  const parsed = ExternalSessionFollowIssueV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return {
    v: 1,
    code: parsed.data.code,
    ...(parsed.data.message === undefined ? {} : { message: parsed.data.message }),
    ...(parsed.data.retryable === undefined ? {} : { retryable: parsed.data.retryable }),
    observedAtMs: parsed.data.observedAtMs,
  };
}

export function buildExternalSessionFollowPolicyV1(
  value: Readonly<{
    policy: ExternalSessionFollowPolicy;
    updatedAtMs?: number;
  }>,
): ExternalSessionFollowPolicyV1 {
  const updatedAtMs = normalizeOptionalTimestamp(value.updatedAtMs);
  return {
    v: 1,
    policy: value.policy,
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
  };
}

export function readExternalSessionAttentionV1(value: unknown): ExternalSessionAttentionV1 | null {
  const candidate = asRecord(value);
  if (!candidate || candidate.v !== 1) return null;

  const observedProgressToken = normalizeOptionalToken(candidate.observedProgressToken);
  const viewedProgressToken = normalizeOptionalToken(candidate.viewedProgressToken);
  const observedAtMs = normalizeOptionalTimestamp(candidate.observedAtMs);
  const viewedAtMs = normalizeOptionalTimestamp(candidate.viewedAtMs);

  if (!observedProgressToken && !viewedProgressToken && observedAtMs === undefined && viewedAtMs === undefined) {
    return null;
  }

  return {
    ...(observedProgressToken ? { observedProgressToken } : {}),
    ...(viewedProgressToken ? { viewedProgressToken } : {}),
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
    ...(viewedAtMs !== undefined ? { viewedAtMs } : {}),
  };
}

export function buildExternalSessionAttentionV1(value: ExternalSessionAttentionV1) {
  return {
    v: 1 as const,
    ...(value.observedProgressToken ? { observedProgressToken: value.observedProgressToken } : {}),
    ...(value.viewedProgressToken ? { viewedProgressToken: value.viewedProgressToken } : {}),
    ...(value.observedAtMs !== undefined ? { observedAtMs: value.observedAtMs } : {}),
    ...(value.viewedAtMs !== undefined ? { viewedAtMs: value.viewedAtMs } : {}),
  };
}

export function deriveExternalSessionObservedProgress(
  items: ReadonlyArray<Pick<ExternalSessionTranscriptRawMessageV1, 'createdAtMs' | 'id'>>,
): ExternalSessionObservedProgress | null {
  let latest: Pick<ExternalSessionTranscriptRawMessageV1, 'createdAtMs' | 'id'> | null = null;
  let latestToken: string | null = null;
  for (const item of items) {
    const itemToken = buildProgressToken(item);
    if (!latest) {
      latest = item;
      latestToken = itemToken;
      continue;
    }
    if (item.createdAtMs > latest.createdAtMs) {
      latest = item;
      latestToken = itemToken;
      continue;
    }
    if (item.createdAtMs === latest.createdAtMs && latestToken && compareProgressTokens(itemToken, latestToken) > 0) {
      latest = item;
      latestToken = itemToken;
    }
  }

  if (!latest) return null;
  return {
    token: latestToken ?? buildProgressToken(latest),
    atMs: latest.createdAtMs,
  };
}

export function applyObservedProgressToExternalSessionAttentionV1(
  current: ExternalSessionAttentionV1 | null | undefined,
  progress: ExternalSessionObservedProgress | null | undefined,
): ExternalSessionAttentionV1 | null {
  const nextObservedProgress = progress ?? null;
  if (!nextObservedProgress) {
    return current ?? null;
  }

  const currentObservedAtMs = current?.observedAtMs;
  if (typeof currentObservedAtMs === 'number' && currentObservedAtMs > nextObservedProgress.atMs) {
    return current ?? null;
  }
  if (
    typeof currentObservedAtMs === 'number'
    && currentObservedAtMs === nextObservedProgress.atMs
    && typeof current?.observedProgressToken === 'string'
    && current.observedProgressToken.trim().length > 0
    && compareProgressTokens(current.observedProgressToken, nextObservedProgress.token) >= 0
  ) {
    return current ?? null;
  }
  if (
    current?.observedProgressToken === nextObservedProgress.token
    && currentObservedAtMs === nextObservedProgress.atMs
  ) {
    return current ?? null;
  }

  return {
    ...(current?.observedProgressToken ? { observedProgressToken: current.observedProgressToken } : {}),
    ...(current?.viewedProgressToken ? { viewedProgressToken: current.viewedProgressToken } : {}),
    ...(current?.observedAtMs !== undefined ? { observedAtMs: current.observedAtMs } : {}),
    ...(current?.viewedAtMs !== undefined ? { viewedAtMs: current.viewedAtMs } : {}),
    observedProgressToken: nextObservedProgress.token,
    observedAtMs: nextObservedProgress.atMs,
  };
}

export function markExternalSessionAttentionViewedV1(
  current: ExternalSessionAttentionV1 | null | undefined,
): ExternalSessionAttentionV1 | null {
  if (!current) return null;

  const nextViewedProgressToken = current.observedProgressToken ?? current.viewedProgressToken;
  const nextViewedAtMs = current.observedAtMs ?? current.viewedAtMs;

  if (
    current.viewedProgressToken === nextViewedProgressToken
    && current.viewedAtMs === nextViewedAtMs
  ) {
    return current;
  }

  return {
    ...(current.observedProgressToken ? { observedProgressToken: current.observedProgressToken } : {}),
    ...(current.observedAtMs !== undefined ? { observedAtMs: current.observedAtMs } : {}),
    ...(nextViewedProgressToken ? { viewedProgressToken: nextViewedProgressToken } : {}),
    ...(nextViewedAtMs !== undefined ? { viewedAtMs: nextViewedAtMs } : {}),
  };
}

export function markExternalSessionAttentionUnreadV1(
  current: ExternalSessionAttentionV1 | null | undefined,
): ExternalSessionAttentionV1 | null {
  if (!current) return null;

  const hasObservedProgress = Boolean(current.observedProgressToken) || current.observedAtMs !== undefined;
  if (!hasObservedProgress) {
    return current;
  }

  if (current.viewedProgressToken === undefined && current.viewedAtMs === undefined) {
    return current;
  }

  return {
    ...(current.observedProgressToken ? { observedProgressToken: current.observedProgressToken } : {}),
    ...(current.observedAtMs !== undefined ? { observedAtMs: current.observedAtMs } : {}),
  };
}

export function deriveExternalSessionAttentionHasUnread(
  attention: ExternalSessionAttentionV1 | null | undefined,
): boolean | null {
  if (!attention) return null;

  if (attention.observedProgressToken) {
    if (!attention.viewedProgressToken) return true;
    return attention.observedProgressToken !== attention.viewedProgressToken;
  }

  if (attention.observedAtMs !== undefined) {
    if (attention.viewedAtMs === undefined) return true;
    return attention.observedAtMs > attention.viewedAtMs;
  }

  return null;
}
