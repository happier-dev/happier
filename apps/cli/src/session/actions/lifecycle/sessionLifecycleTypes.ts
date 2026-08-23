import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import type { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import type { BackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

export type SessionLifecycleActionHandler = (
    rawParams: unknown,
    context?: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

export type SessionLifecycleMachineHandlers = Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<StopSessionResult | boolean>;
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
    }>) => Promise<
        | Readonly<{ status: 'opened'; request: AgentSessionOpenRequest }>
        | Readonly<{ status: 'runner_exited' }>
        | Readonly<{ status: 'timeout' }>
    >;
}>;
