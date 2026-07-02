import type { RuntimeCore, RuntimeConfigUpdateOutcomeV1 } from '@happier-dev/agents';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import type { PluginContextV1 } from '../../context';
import type { BackendEngineV1 } from '../../engine';
import type {
    CreateExecutionRunBackendParamsV1,
    CreateSessionRuntimeParamsV1,
    ExecutionRunBackendCreateResultV1,
    SessionRuntimeV1,
} from '../../runtime/session';

// The runtime-config update outcome ABI is owned by `@happier-dev/agents`
// (`runtime/session/runtimeConfigUpdateOutcome.ts`) because both the host override-synchronizers
// and bundled plugin adapters consume it. Re-exported here so first-party plugin importers of this
// internal subpath keep a single import site.
export {
    isRuntimeConfigUpdateOutcomeApplied,
    type RuntimeConfigUpdateOutcomeV1,
} from '@happier-dev/agents';

export type InternalHostSessionRuntimePlanV1 = Readonly<{
    kind: 'hostSessionRuntimePlan';
    providerId: string;
    opts: Readonly<Record<string, unknown>>;
    config: Readonly<Record<string, unknown>>;
}>;

export type InternalRuntimeTurnOperationsV1 = Readonly<{
    beginTurnLifecycle(): void;
    startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null | Readonly<Record<string, unknown>>>;
    sendTurnPrompt(prompt: string): Promise<void>;
    steerInFlightTurn(message: string): Promise<void>;
    waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void>;
    subscribeRuntimeEvents(handler: (message: RuntimeEventV1) => void): () => void;
    respondToPermission(requestId: string, approved: boolean): Promise<void>;
    cancelTurn(): Promise<void>;
    readSessionIdentity(): Readonly<{ sessionId: string | null }>;
    updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<RuntimeConfigUpdateOutcomeV1 | void>;
    resetOrDisposeRuntime(): Promise<void>;
}>;

export type InternalRuntimeTurnOperationsEnvelopeV1 = Readonly<{
    operations: InternalRuntimeTurnOperationsV1;
    nativeRuntime?: InternalRuntimeTurnOperationsV1 | null;
    runtimeDescriptor?: Readonly<Record<string, unknown>> | null;
    runtimeCapabilities?: Readonly<Record<string, unknown>> | null;
    runtimeFacets?: Readonly<Record<string, unknown>> | null;
}>;

export type BundledSessionRuntimeCreateResultV1 =
    | SessionRuntimeV1
    | InternalHostSessionRuntimePlanV1
    | InternalRuntimeTurnOperationsEnvelopeV1;

export type BundledRuntimeCoreV1 = RuntimeCore<
    CreateSessionRuntimeParamsV1,
    BundledSessionRuntimeCreateResultV1,
    CreateExecutionRunBackendParamsV1,
    ExecutionRunBackendCreateResultV1
>;

export type BundledBackendEngineV1 = Omit<BackendEngineV1, 'runtimeCore'> & Readonly<{
    runtimeCore?: BundledRuntimeCoreV1;
}>;

export type BundledRegisterBackendEngineV1 = Readonly<{
    backendId: string;
    create: (ctx: PluginContextV1) => BundledBackendEngineV1 | Promise<BundledBackendEngineV1>;
}>;
