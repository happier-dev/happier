import type { ExternalSessionTakeoverStorageModeV1 } from '@happier-dev/protocol/sessions';

import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

type TranscriptStorageMode = NonNullable<SpawnSessionOptions['transcriptStorage']>;

const TRANSCRIPT_STORAGE_BY_TAKEOVER_MODE = {
    'external-linked': 'direct',
    persisted: 'persisted',
} as const satisfies Record<ExternalSessionTakeoverStorageModeV1, TranscriptStorageMode>;

export function mapExternalSessionTakeoverStorageModeToTranscriptStorage(
    storageMode: ExternalSessionTakeoverStorageModeV1,
): TranscriptStorageMode {
    return TRANSCRIPT_STORAGE_BY_TAKEOVER_MODE[storageMode];
}
