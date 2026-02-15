import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from './sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from './sessionsHttp';

export type SessionSummary = Readonly<{
  id: string;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  activeAt: number;
  pendingCount?: number;
  tag?: string;
  path?: string;
  host?: string;
  share?: { accessLevel: string; canApprovePermissions: boolean } | null;
  isSystem?: boolean;
  systemPurpose?: string | null;
  encryption: { type: 'legacy' | 'dataKey' };
}>;

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

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
  credentials: Credentials;
  row: RawSessionListRow;
}>): SessionSummary {
  const id = readString(params.row.id).trim();
  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.row });
  const tag = typeof (metadata as any)?.tag === 'string' ? String((metadata as any).tag) : undefined;
  const path = typeof (metadata as any)?.path === 'string' ? String((metadata as any).path) : undefined;
  const host = typeof (metadata as any)?.host === 'string' ? String((metadata as any).host) : undefined;

  return {
    id,
    createdAt: readNumber(params.row.createdAt),
    updatedAt: readNumber(params.row.updatedAt),
    active: Boolean((params.row as any).active),
    activeAt: readNumber((params.row as any).activeAt),
    ...(typeof (params.row as any).pendingCount === 'number' ? { pendingCount: (params.row as any).pendingCount } : {}),
    ...(tag ? { tag } : {}),
    ...(path ? { path } : {}),
    ...(host ? { host } : {}),
    ...(readShare((params.row as any).share) !== undefined ? { share: readShare((params.row as any).share) } : {}),
    encryption: { type: params.credentials.encryption.type },
  };
}

export function summarizeSessionRecord(params: Readonly<{
  credentials: Credentials;
  session: RawSessionRecord;
}>): SessionSummary {
  // The /v2/sessions/:id response includes similar shape, so reuse the same summarization logic.
  return summarizeSessionRow({ credentials: params.credentials, row: params.session as any });
}

