import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol/sessions/control/contract';
import type { SessionSummary as ProtocolSessionSummary, AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

export type SessionSummary = Readonly<ProtocolSessionSummary>;

function readShare(value: unknown): { accessLevel: string; canApprovePermissions: boolean } | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const accessLevel = record.accessLevel;
  const canApprovePermissions = record.canApprovePermissions;
  if (typeof accessLevel !== 'string') return undefined;
  if (typeof canApprovePermissions !== 'boolean') return undefined;
  return { accessLevel, canApprovePermissions };
}

function readTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNullableTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null;
  return readTimestamp(value);
}

/**
 * Every operational fact the public `SessionSummary` schema can already carry.
 *
 * `summarizeSessionRow` used to drop these, so a CLI/daemon/Action caller saw a Session with no
 * turn, runtime, rollback or pending-activation state at all and had no way to tell "idle" from
 * "this mapper did not look". They are copied verbatim: interpretation belongs to the awareness
 * projector, not to a mapper.
 */
function readOperationalRowFacts(row: RawSessionListRow): Partial<SessionSummary> {
  const latestTurnId = typeof row.latestTurnId === 'string' ? row.latestTurnId : row.latestTurnId === null ? null : undefined;
  const latestTurnStatus = row.latestTurnStatus ?? undefined;
  const latestTurnStatusObservedAt = readNullableTimestamp(row.latestTurnStatusObservedAt);
  const lastRuntimeIssue = row.lastRuntimeIssue ?? undefined;
  const runtimeActivityObservedAt = readNullableTimestamp(row.runtimeActivityObservedAt);
  const rollbackEligibleTurnStarts = Array.isArray(row.rollbackEligibleTurnStarts)
    ? row.rollbackEligibleTurnStarts
    : undefined;
  return {
    ...(latestTurnId !== undefined ? { latestTurnId } : {}),
    ...(latestTurnStatus !== undefined ? { latestTurnStatus } : {}),
    ...(latestTurnStatusObservedAt !== undefined ? { latestTurnStatusObservedAt } : {}),
    ...(lastRuntimeIssue !== undefined ? { lastRuntimeIssue } : {}),
    ...(row.runtimeActivityState !== undefined ? { runtimeActivityState: row.runtimeActivityState } : {}),
    ...(readTimestamp(row.runtimeActivityActiveCount) !== undefined
      ? { runtimeActivityActiveCount: row.runtimeActivityActiveCount }
      : {}),
    ...(runtimeActivityObservedAt !== undefined ? { runtimeActivityObservedAt } : {}),
    ...(readTimestamp(row.runtimeActivityRevision) !== undefined
      ? { runtimeActivityRevision: row.runtimeActivityRevision }
      : {}),
    ...(rollbackEligibleTurnStarts !== undefined ? { rollbackEligibleTurnStarts } : {}),
    ...(row.pendingActivationAuthorization !== undefined
      ? { pendingActivationAuthorization: row.pendingActivationAuthorization }
      : {}),
  };
}

export function summarizeSessionRow(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  row: RawSessionListRow;
}>): SessionSummary {
  const id = params.row.id.trim();
  const metadata = tryDecryptSessionPresentationMetadataView({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionMode,
    rawSession: params.row,
  });
  const summary = metadata?.summary && typeof metadata.summary === 'object' && !Array.isArray(metadata.summary)
    ? metadata.summary as Readonly<Record<string, unknown>>
    : null;
  const tag = typeof metadata?.tag === 'string' ? metadata.tag : undefined;
  const title = typeof summary?.text === 'string' ? summary.text.trim() : undefined;
  const path = typeof metadata?.path === 'string' ? metadata.path : undefined;
  const host = typeof metadata?.host === 'string' ? metadata.host : undefined;
  const machineId = typeof metadata?.machineId === 'string' ? metadata.machineId.trim() : undefined;
  const permissionMode = resolvePermissionIntentFromSessionMetadata(metadata)?.intent;
  const systemMetadata = metadata === null ? null : readSystemSessionMetadataFromMetadata({ metadata });
  const isSystem = systemMetadata !== null;
  const archivedAt = params.row.archivedAt;
  const archivedAtValue = typeof archivedAt === 'number' && Number.isFinite(archivedAt) && archivedAt >= 0 ? archivedAt : archivedAt === null ? null : undefined;

  return {
    id,
    createdAt: params.row.createdAt,
    updatedAt: params.row.updatedAt,
    active: params.row.active,
    activeAt: params.row.activeAt,
    ...(archivedAtValue !== undefined ? { archivedAt: archivedAtValue } : {}),
    ...(typeof params.row.pendingCount === 'number' ? { pendingCount: params.row.pendingCount } : {}),
    ...(typeof params.row.pendingBlockedCount === 'number' ? { pendingBlockedCount: params.row.pendingBlockedCount } : {}),
    ...(tag ? { tag } : {}),
    ...(title ? { title } : {}),
    ...(path ? { path } : {}),
    ...(host ? { host } : {}),
    ...(machineId ? { machineId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(isSystem ? { isSystem, systemPurpose: systemMetadata?.key ?? null } : {}),
    ...(params.row.effectiveAccess !== undefined
      ? { effectiveAccess: params.row.effectiveAccess }
      : {}),
    ...(readShare(params.row.share) !== undefined ? { share: readShare(params.row.share) } : {}),
    ...(params.row.encryptionMode ? { encryptionMode: params.row.encryptionMode } : {}),
    encryption: params.credentials.encryption
      ? { type: params.credentials.encryption.type }
      : null,
    ...readOperationalRowFacts(params.row),
  };
}

export function summarizeSessionRecord(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  session: RawSessionRecord;
}>): SessionSummary {
  // The /v2/sessions/:id response includes similar shape, so reuse the same summarization logic.
  return summarizeSessionRow({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionMode,
    row: params.session,
  });
}
