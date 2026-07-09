import type {
    AttachSurfaceV1,
    CheckpointSurfaceV1,
    ExternalSessionSurfaceV1,
    ForkSurfaceV1,
    HandoffSurfaceV1,
    TerminalRuntimeSurfaceV1,
} from '@happier-dev/agents';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';
import type {
    RuntimeConfigUpdateOutcomeV1,
    ExecutionRunHostBackendV1,
    RuntimeSendOptionsV1,
    SessionRuntimeCreateResultV1,
    SessionRuntimeV1,
} from './runtime/session.js';
import type {
    AgentMessageMetaEnricherV1,
    AgentRuntimeV1,
} from './engine.js';

type AssertTrue<T extends true> = T;
type AssertNever<T extends never> = T;

type IsUnknown<T> = unknown extends T
    ? keyof T extends never
        ? true
        : false
    : false;

type FirstParameter<T> = T extends (request: infer TRequest, ...args: never[]) => unknown
    ? TRequest
    : never;

type AwaitedReturn<T> = T extends (...args: never[]) => infer TResult
    ? Awaited<TResult>
    : never;

type _TerminalLaunchRequestMustBeConcrete = AssertTrue<
    IsUnknown<FirstParameter<NonNullable<TerminalRuntimeSurfaceV1['launch']>>> extends false ? true : false
>;

type _TerminalLaunchResultMustBeConcrete = AssertTrue<
    IsUnknown<AwaitedReturn<NonNullable<TerminalRuntimeSurfaceV1['launch']>>> extends false ? true : false
>;

type _ExternalResolveSourceRequestMustBeConcrete = AssertTrue<
    IsUnknown<FirstParameter<ExternalSessionSurfaceV1['resolveSource']>> extends false ? true : false
>;

type _ExternalResolveSourceResultMustBeConcrete = AssertTrue<
    IsUnknown<AwaitedReturn<ExternalSessionSurfaceV1['resolveSource']>> extends false ? true : false
>;

type _AttachRequestMustBeConcrete = AssertTrue<
    IsUnknown<FirstParameter<AttachSurfaceV1['attach']>> extends false ? true : false
>;

type _HandoffImportResultMustBeConcrete = AssertTrue<
    IsUnknown<AwaitedReturn<HandoffSurfaceV1['importBundle']>> extends false ? true : false
>;

type _ForkRequestMustBeConcrete = AssertTrue<
    IsUnknown<FirstParameter<NonNullable<ForkSurfaceV1['fork']>>> extends false ? true : false
>;

type _CheckpointRestoreResultMustBeConcrete = AssertTrue<
    IsUnknown<AwaitedReturn<NonNullable<CheckpointSurfaceV1['restore']>>> extends false ? true : false
>;

type _PublicSessionRuntimeCreateResultMustNotExposeHostPlan = AssertNever<
    Extract<SessionRuntimeCreateResultV1, { kind: 'hostSessionRuntimePlan' }>
>;

type _RuntimeSendOptionsMustUseDeliveryMode = AssertTrue<
    RuntimeSendOptionsV1 extends Readonly<{
        deliverAs?: 'steer' | 'followUp';
    }> ? true : false
>;

type _RuntimeSendOptionsMayCarryProviderAcceptanceSeq = AssertTrue<
    RuntimeSendOptionsV1 extends Readonly<{
        userMessageSeq?: number | null;
    }> ? true : false
>;

type _RuntimeSendOptionsMayCarryProviderClaimedPendingIdentity = AssertTrue<
    RuntimeSendOptionsV1 extends Readonly<{
        providerClaimedPendingLocalIds?: readonly string[];
    }> ? true : false
>;

type _RuntimeSendOptionsMayCarryOneShotModel = AssertTrue<
    RuntimeSendOptionsV1 extends Readonly<{
        modelId?: string;
    }> ? true : false
>;

type _RuntimeSendOptionsMustNotExposeLegacySteerBoolean = AssertTrue<
    Extract<keyof RuntimeSendOptionsV1, 'isSteer'> extends never ? true : false
>;

type _SessionRuntimeMustExposePublicIdentityAndEvents = AssertTrue<
    SessionRuntimeV1 extends Readonly<{
        identity: Readonly<{
            read(): Readonly<{ providerSessionId: string | null }>;
        }>;
        events: Readonly<{
            subscribe(handler: (event: RuntimeEventV1) => void): () => void;
        }>;
    }> ? true : false
>;

type _SessionRuntimePermissionCapabilityMustBeDeclared = AssertTrue<
    NonNullable<SessionRuntimeV1['permissions']> extends Readonly<{
        capability: 'responds' | 'inline' | 'static';
    }> ? true : false
>;

type _ExecutionRunHostBackendPermissionCapabilityMustBeDeclared = AssertTrue<
    ExecutionRunHostBackendV1 extends Readonly<{
        permissionCapability?: 'responds' | 'inline' | 'static';
    }> ? true : false
>;

type _SessionRuntimeConfigUpdateMustUsePublicOutcome = AssertTrue<
    NonNullable<SessionRuntimeV1['updateConfig']> extends (
        update: Readonly<{
            modeId?: string;
            modelId?: string;
            configOption?: Readonly<Record<string, unknown>>;
        }>,
    ) => Promise<RuntimeConfigUpdateOutcomeV1 | void> ? true : false
>;

type _AgentRuntimeMessageMetaMustUseAgentVocabulary = AssertTrue<
    AgentRuntimeV1 extends Readonly<{
        messageMeta?: AgentMessageMetaEnricherV1;
    }> ? true : false
>;
