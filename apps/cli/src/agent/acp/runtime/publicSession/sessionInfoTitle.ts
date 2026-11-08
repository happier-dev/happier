import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';

export type AcpSessionTitleTarget = Pick<ApiSessionClient, 'updateMetadata'>;

export function createAcpSessionInfoTitleUpdater(
  update: unknown,
): ((metadata: Metadata) => Metadata) | null {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const record = update as Readonly<Record<string, unknown>>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) return null;
  const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : Number.NaN;
  return metadata => applyDisplayTitleSessionMetadata(metadata, {
    title,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
    staleBehavior: 'drop',
    preserveExistingValue: true,
  });
}
