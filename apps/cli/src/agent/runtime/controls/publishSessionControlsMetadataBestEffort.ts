import type { Metadata } from '@/api/types';

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
  sessionModelsState?: SessionModelsState | null;
  sessionConfigOptionsState?: SessionConfigOptionsState | null;
  timeoutMs?: number;
}>): Promise<void> {
  if (!params.sessionModesState && !params.sessionModelsState && !params.sessionConfigOptionsState) {
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

  await params.session.updateMetadata((prev) => ({
    ...prev,
    ...(params.sessionModesState
      ? {
          sessionModesV1: params.sessionModesState,
        }
      : {}),
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
