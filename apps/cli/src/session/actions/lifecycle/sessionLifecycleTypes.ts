import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import type { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import type { StopSessionOptions } from '@/daemon/sessions/stopSession';
import type { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import type { RpcHandlerContext } from '@/api/rpc/types';

export type SessionLifecycleActionHandler = (
    rawParams: unknown,
    context?: Readonly<{ signal?: AbortSignal }> & Pick<SpawnSessionOptions, 'creationAuthorization' | 'callerInputConstraints'>
        & Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent' | 'requesterSessionBootstrap' | 'beforeSessionRunnerLaunch' | 'localActionContext'
            | 'callerInputAuthorization' | 'originalActionEnvelope'>,
) => Promise<unknown>;

export type SessionLifecycleMachineHandlers = Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string, options?: StopSessionOptions) => Promise<StopSessionResult | boolean>;
}>;

export type SessionLifecycleMachineDeps = Readonly<{
    runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
    resolveExecutionSurfaces?: (
        backendId?: string | null,
    ) => Promise<BackendExecutionSurfaces>;
    awaitAgentSessionOpen?: (input: Readonly<{
        sessionId: string;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>) => ReturnType<typeof awaitTrackedRunnerAgentSessionOpen>;
}>;
