import type { DirectSessionTranscriptDeltaEphemeral } from '@happier-dev/protocol';

import { createDirectSessionFollowLeaseManager } from '@/api/session/external/leases/createDirectSessionFollowLeaseManager';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

export type ExternalSessionTakeoverActionInput = Readonly<{
    linkedSessionId: string;
    targetRuntimeMode: 'terminal' | 'remote';
    storageMode: 'external-linked' | 'persisted';
    forceStop?: boolean;
    machineId?: string;
}>;

export type ExternalSessionActionContext = Readonly<{
    followLeaseManager: ReturnType<typeof createDirectSessionFollowLeaseManager>;
    emitDirectSessionTranscriptUpdate?: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
    spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession?: (sessionId: string) => Promise<boolean>;
    takeoverReadiness: Readonly<{
        read: (sessionId: string) => boolean | null;
        write: (sessionId: string, value: boolean) => void;
        invalidate: (sessionId: string) => void;
    }>;
}>;
