import type {
    HostTerminalAvailabilityRequest,
} from '@/agent/runtime/session/terminal/contract';
import type { BackendSurfaceAvailabilityV1 } from '@happier-dev/protocol';

type BivariantAsyncUnaryFn<TParams, TResult> = {
    bivarianceHack(params: TParams): Promise<TResult>;
}['bivarianceHack'];

type BivariantMaybeAsyncUnaryFn<TParams, TResult> = {
    bivarianceHack(params: TParams): TResult | Promise<TResult>;
}['bivarianceHack'];

export type TerminalRuntimeOps<
    TLaunchParams = never,
    TLaunchResult = never,
    TDiscoverIdentityParams = never,
    TDiscoverIdentityResult = never,
    TAvailabilityParams = never,
> = Readonly<{
    evaluateAvailability?: (params: TAvailabilityParams) => Promise<BackendSurfaceAvailabilityV1> | BackendSurfaceAvailabilityV1;
    launch?: (params: TLaunchParams) => Promise<TLaunchResult>;
    discoverIdentity?: (params: TDiscoverIdentityParams) => Promise<TDiscoverIdentityResult>;
}>;

export type AnyTerminalRuntimeOps = Readonly<{
    evaluateAvailability?: BivariantMaybeAsyncUnaryFn<HostTerminalAvailabilityRequest, BackendSurfaceAvailabilityV1>;
    launch?: BivariantAsyncUnaryFn<unknown, unknown>;
    discoverIdentity?: BivariantAsyncUnaryFn<unknown, unknown>;
}>;
