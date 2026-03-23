import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';

export type AttachedRunRuntimeContext = Readonly<{
  resolvedMetadata: Metadata;
  runtimeDirectory: string;
  sessionMetadataSnapshot: Metadata | null;
}>;

export function resolveAttachedRunRuntimeContext(params: Readonly<{
  session: Pick<ApiSessionClient, 'getMetadataSnapshot'>;
  metadata: Metadata;
  resolveRuntimeDirectory?: (params: { session: ApiSessionClient; metadata: Metadata }) => string;
  fallbackDirectory?: string;
}>): AttachedRunRuntimeContext {
  const sessionMetadataSnapshot = params.session.getMetadataSnapshot() ?? null;
  const resolvedMetadata = sessionMetadataSnapshot ?? params.metadata;
  const resolvedRuntimeDirectory = params.resolveRuntimeDirectory
    ? params.resolveRuntimeDirectory({
      session: params.session as ApiSessionClient,
      metadata: resolvedMetadata,
    })
    : resolvedMetadata.path;

  return {
    resolvedMetadata,
    runtimeDirectory: resolvedRuntimeDirectory ?? params.fallbackDirectory ?? '',
    sessionMetadataSnapshot,
  };
}
