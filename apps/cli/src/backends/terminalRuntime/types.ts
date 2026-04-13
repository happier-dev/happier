import type { LocalHostedDirectTranscriptBinding } from '@/agent/terminalRuntime/directTranscriptBinding';

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
    TBindTranscriptParams = never,
    TBindTranscriptResult = LocalHostedDirectTranscriptBinding | undefined,
> = Readonly<{
    launch?: (params: TLaunchParams) => Promise<TLaunchResult>;
    discoverIdentity?: (params: TDiscoverIdentityParams) => Promise<TDiscoverIdentityResult>;
    bindTranscript?: (params: TBindTranscriptParams) => TBindTranscriptResult | Promise<TBindTranscriptResult>;
}>;

export type AnyTerminalRuntimeOps = Readonly<{
    launch?: BivariantAsyncUnaryFn<unknown, unknown>;
    discoverIdentity?: BivariantAsyncUnaryFn<unknown, unknown>;
    bindTranscript?: BivariantMaybeAsyncUnaryFn<unknown, LocalHostedDirectTranscriptBinding | undefined>;
}>;
