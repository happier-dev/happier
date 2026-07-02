import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';
import type {
    TerminalRuntimeAvailabilityRequestV1,
} from '@happier-dev/agents';
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
    TResolveTranscriptBindingParams = never,
    TResolveTranscriptBindingResult = LocalHostedDirectTranscriptBinding | undefined,
    TAvailabilityParams = never,
> = Readonly<{
    evaluateAvailability?: (params: TAvailabilityParams) => Promise<BackendSurfaceAvailabilityV1> | BackendSurfaceAvailabilityV1;
    launch?: (params: TLaunchParams) => Promise<TLaunchResult>;
    discoverIdentity?: (params: TDiscoverIdentityParams) => Promise<TDiscoverIdentityResult>;
    resolveTranscriptBinding?: (
        params: TResolveTranscriptBindingParams,
    ) => TResolveTranscriptBindingResult | Promise<TResolveTranscriptBindingResult>;
}>;

export type AnyTerminalRuntimeOps = Readonly<{
    evaluateAvailability?: BivariantMaybeAsyncUnaryFn<TerminalRuntimeAvailabilityRequestV1, BackendSurfaceAvailabilityV1>;
    launch?: BivariantAsyncUnaryFn<unknown, unknown>;
    discoverIdentity?: BivariantAsyncUnaryFn<unknown, unknown>;
    resolveTranscriptBinding?: BivariantMaybeAsyncUnaryFn<unknown, LocalHostedDirectTranscriptBinding | undefined>;
}>;
