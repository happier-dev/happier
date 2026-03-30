import { inferAgentIdFromSessionMetadata, evaluateVendorResumeEligibility, type VendorResumeEligibility } from '@happier-dev/agents';
import {
  readSystemSessionMetadataFromMetadata,
  type AccountSettings,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type CliSessionRowModel = Readonly<{
  id: string;
  agentId: ReturnType<typeof inferAgentIdFromSessionMetadata>;
  createdAt: number;
  updatedAt: number;
  active: boolean;
  activeAt: number;
  archivedAt: number | null;
  tag: string | null;
  title: string | null;
  path: string | null;
  isSystem: boolean;
  systemPurpose: string | null;
  vendorResume: VendorResumeEligibility;
  encryptionMode: 'plain' | 'e2ee';
}>;

function readOptionalNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const raw = record[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTitleFromMetadata(metadata: Record<string, unknown>): string | null {
  const summary = metadata.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const summaryRecord = summary as Record<string, unknown>;
  const text = summaryRecord.text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveArchivedAtValue(raw: RawSessionListRow | RawSessionRecord): number | null {
  const archivedAt = raw.archivedAt;
  if (archivedAt === null) return null;
  if (typeof archivedAt !== 'number' || !Number.isFinite(archivedAt) || archivedAt < 0) return null;
  return archivedAt;
}

export function buildCliSessionRowModel(params: Readonly<{
  credentials: Credentials;
  rawSession: RawSessionListRow | RawSessionRecord;
  accountSettings?: AccountSettings | null;
}>): CliSessionRowModel {
  const raw = params.rawSession;
  const id = raw.id.trim();
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;
  const active = raw.active;
  const activeAt = raw.activeAt;
  const archivedAt = resolveArchivedAtValue(raw);

  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession });
  const metaRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const agentId = inferAgentIdFromSessionMetadata(metaRecord);

  const tag = metaRecord ? readOptionalNonEmptyString(metaRecord, 'tag') : null;
  const title = metaRecord ? readTitleFromMetadata(metaRecord) : null;
  const path = metaRecord ? readOptionalNonEmptyString(metaRecord, 'path') : null;

  const system = metaRecord ? readSystemSessionMetadataFromMetadata({ metadata: metaRecord }) : null;
  const isSystem = system !== null;
  const systemPurpose = system?.key ?? null;

  const vendorResume = evaluateVendorResumeEligibility({
    agentId,
    metadata: metaRecord,
    accountSettings: params.accountSettings ?? null,
  });

  const encryptionMode: 'plain' | 'e2ee' = raw.encryptionMode === 'plain' ? 'plain' : 'e2ee';

  return {
    id,
    agentId,
    createdAt,
    updatedAt,
    active,
    activeAt,
    archivedAt,
    tag,
    title,
    path,
    isSystem,
    systemPurpose,
    vendorResume,
    encryptionMode,
  };
}
