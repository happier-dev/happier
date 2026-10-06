import type { Metadata } from '@/api/types';
import { projectSessionModesV1Compatibility } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionOwnerModeCatalogV2 } from '@happier-dev/protocol';

type SessionControlMetadataSession = Readonly<{
  ensureMetadataSnapshot?: (opts: Readonly<{ timeoutMs: number }>) => Promise<unknown> | unknown;
  updateMetadata: (updater: (prev: Metadata) => Metadata) => Promise<void> | void;
}>;

type SessionModesState = NonNullable<Metadata['sessionModesV1']>;
type SessionModelsState = NonNullable<Metadata['sessionModelsV1']>;
type SessionConfigOptionsState = NonNullable<Metadata['sessionConfigOptionsV1']>;

export async function publishSessionControlsMetadataBestEffort(params: Readonly<{
  session: SessionControlMetadataSession;
  metadataSnapshot?: Metadata | null;
  sessionModesState?: SessionModesState | null;
  sessionModesStateV2?: SessionOwnerModeCatalogV2 | null;
  sessionModelsState?: SessionModelsState | null;
  sessionConfigOptionsState?: SessionConfigOptionsState | null;
  timeoutMs?: number;
}>): Promise<void> {
  if (!params.sessionModesState && !params.sessionModesStateV2 && !params.sessionModelsState && !params.sessionConfigOptionsState) {
    return;
  }

  const hasMetadataSnapshotCapability = typeof params.session.ensureMetadataSnapshot === 'function';
  const snapshot = params.metadataSnapshot
    ?? (hasMetadataSnapshotCapability
      ? await Promise.resolve(params.session.ensureMetadataSnapshot({
        timeoutMs: params.timeoutMs ?? 60_000,
      })).catch(() => null)
      : null);
  if (!snapshot && hasMetadataSnapshotCapability) return;
  const modes = params.sessionModesStateV2 ?? (params.sessionModesState ? { ...params.sessionModesState, v: 2 as const } : null);

  await params.session.updateMetadata((prev) => ({
    ...prev,
    ...(modes ? {
      sessionModesV2: modes,
      sessionModesV1: projectSessionModesV1Compatibility(modes),
      acpSessionModesV1: undefined,
    } : {}),
    ...(params.sessionModelsState
      ? {
          sessionModelsV1: params.sessionModelsState,
        }
      : {}),
    ...(params.sessionConfigOptionsState
      ? {
          sessionConfigOptionsV1: params.sessionConfigOptionsState,
        }
      : {}),
  }));
}
