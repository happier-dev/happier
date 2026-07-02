import type {
    AttachSurfaceV1,
    CheckpointSurfaceV1,
    ExternalSessionSurfaceV1,
    ForkSurfaceV1,
    HandoffSurfaceV1,
    TerminalRuntimeSurfaceV1,
} from '@happier-dev/agents';
import type { SessionRuntimeCreateResultV1 } from './runtime/session';

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

// @ts-expect-error A.13q.1 keeps host-plan compatibility behind the internal bundled-only subpath.
type _PublicRuntimeSessionModuleMustNotExportInternalHostPlan = import('./runtime/session').InternalHostSessionRuntimePlanV1;
