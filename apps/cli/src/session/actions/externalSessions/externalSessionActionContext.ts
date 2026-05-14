import type { ExternalSessionTranscriptDeltaEphemeral } from '@happier-dev/protocol';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { TransientSessionMediaReadAllowance } from '@/session/media/readAllowance';

export type ExternalSessionTakeoverActionInput = Readonly<{
    linkedSessionId: string;
    targetRuntimeMode: 'terminal' | 'remote';
    storageMode: 'external-linked' | 'persisted';
    forceStop?: boolean;
    machineId?: string;
}>;

export type ExternalSessionActionContext = Readonly<{
    followLeaseManager: ReturnType<typeof createExternalSessionFollowLeaseManager>;
    emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptDeltaEphemeral) => void;
    transientMediaReadAllowance?: Pick<TransientSessionMediaReadAllowance, 'grantReadFiles'>;
    spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession?: (sessionId: string) => Promise<boolean>;
    takeoverReadiness: Readonly<{
        read: (sessionId: string) => boolean | null;
        write: (sessionId: string, value: boolean) => void;
        invalidate: (sessionId: string) => void;
    }>;
}>;
