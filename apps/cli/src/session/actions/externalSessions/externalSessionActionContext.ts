import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionTranscriptInvalidationV1,
} from '@happier-dev/protocol';

import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import type { createExternalSessionObservationProjection } from '@/api/session/external/leases/createExternalSessionObservationProjection';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { TransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type { ExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type {
    ExternalSessionPassiveReconcileResult,
} from '@/api/session/external/leases/startExternalSessionPassiveObservation';
import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';

export type ExternalSessionTakeoverActionInput = Readonly<{
    linkedSessionId: string;
    targetRuntimeMode: 'terminal' | 'remote';
    storageMode: 'external-linked' | 'persisted';
    forceStop?: boolean;
    machineId?: string;
    operationId?: string;
}>;

export type ExternalSessionActionContext = Readonly<{
    followLeaseManager: ReturnType<typeof createExternalSessionFollowLeaseManager>;
    operationExclusion: ExternalSessionOperationExclusion;
    operationProgress: Readonly<{
        activeServerDir: string;
        publish(input: Readonly<{
            sessionId: string;
            progress: ExternalSessionOperationProgressV1;
        }>): Promise<void>;
    }>;
    observationProjection: Pick<
        ReturnType<typeof createExternalSessionObservationProjection>,
        'reconcileStatusLink' | 'reconcileTranscriptDemand'
    >;
    reconcilePassiveFollowSession?: (
        sessionId: string,
    ) => Promise<ExternalSessionPassiveReconcileResult>;
    getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    emitExternalSessionTranscriptUpdate?: (payload: ExternalSessionTranscriptInvalidationV1) => void | Promise<void>;
    transientMediaReadAllowance?: Pick<TransientSessionMediaReadAllowance, 'grantReadFiles'>;
    spawnSession?: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession?: (sessionId: string) => Promise<boolean>;
    takeoverReadiness: Readonly<{
        read: (sessionId: string, linkGeneration: string) => boolean | null;
        write: (
            sessionId: string,
            linkGeneration: string,
            value: boolean,
        ) => void;
        invalidate: (sessionId: string) => void;
    }>;
}>;
