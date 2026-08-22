import type { StoredCredentials } from '@/persistence';
import { tryDecryptSessionPresentationMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import {
  readSystemSessionMetadataFromMetadata,
  type SessionSummary as ProtocolSessionSummary,
  type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';

export type SessionSummary = Readonly<ProtocolSessionSummary>;

function readShare(value: unknown): { accessLevel: string; canApprovePermissions: boolean } | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const accessLevel = (value as any).accessLevel;
  const canApprovePermissions = (value as any).canApprovePermissions;
  if (typeof accessLevel !== 'string') return undefined;
  if (typeof canApprovePermissions !== 'boolean') return undefined;
  return { accessLevel, canApprovePermissions };
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
  const tag = typeof (metadata as any)?.tag === 'string' ? String((metadata as any).tag) : undefined;
  const title = typeof (metadata as any)?.summary?.text === 'string' ? String((metadata as any).summary.text).trim() : undefined;
  const path = typeof (metadata as any)?.path === 'string' ? String((metadata as any).path) : undefined;
  const host = typeof (metadata as any)?.host === 'string' ? String((metadata as any).host) : undefined;
  const systemMetadata = metadata === null ? null : readSystemSessionMetadataFromMetadata({ metadata });
  const isSystem = systemMetadata !== null;
  const archivedAt = (params.row as any)?.archivedAt;
  const archivedAtValue = typeof archivedAt === 'number' && Number.isFinite(archivedAt) && archivedAt >= 0 ? archivedAt : archivedAt === null ? null : undefined;

  return {
    id,
    createdAt: params.row.createdAt,
    updatedAt: params.row.updatedAt,
    active: params.row.active,
    activeAt: params.row.activeAt,
    ...(archivedAtValue !== undefined ? { archivedAt: archivedAtValue } : {}),
    ...(typeof params.row.pendingCount === 'number' ? { pendingCount: params.row.pendingCount } : {}),
    ...(typeof (params.row as any).pendingBlockedCount === 'number' ? { pendingBlockedCount: (params.row as any).pendingBlockedCount } : {}),
    ...(tag ? { tag } : {}),
    ...(title ? { title } : {}),
    ...(path ? { path } : {}),
    ...(host ? { host } : {}),
    ...(isSystem ? { isSystem, systemPurpose: systemMetadata?.key ?? null } : {}),
    ...(readShare(params.row.share) !== undefined ? { share: readShare(params.row.share) } : {}),
    ...((params.row as any)?.encryptionMode ? { encryptionMode: (params.row as any).encryptionMode } : {}),
    encryption: params.credentials.encryption
      ? { type: params.credentials.encryption.type }
      : null,
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
