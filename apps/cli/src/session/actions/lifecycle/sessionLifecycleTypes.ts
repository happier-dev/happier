import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import type { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';

export type SessionLifecycleActionHandler = (rawParams: unknown) => Promise<unknown>;

export type SessionLifecycleMachineHandlers = Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<boolean>;
}>;

export type SessionLifecycleMachineDeps = Readonly<{
    runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
}>;
