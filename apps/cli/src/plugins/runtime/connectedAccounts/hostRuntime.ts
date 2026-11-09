import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    ConnectedAccountAuthenticationContext,
    ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

type ReadContext = Parameters<ConnectedAccountRuntime['status']>[0];
type MutationContext = Parameters<ConnectedAccountRuntime['refresh']>[0];
type NativeContext = Parameters<NonNullable<ConnectedAccountRuntime['materializeNative']>>[1];
export type HostConnectedAccountNativeContext = Pick<NativeContext, 'service' | 'signal' | 'invokedAtMs'>;

/** Built-in services use host authority; they have no plugin invocation identity. */
export type HostConnectedAccountAuthenticationContext = Pick<
    ConnectedAccountAuthenticationContext,
    'service' | 'attempt' | 'configuration' | 'attemptCredentials' | 'signal' | 'invokedAtMs'
> & Readonly<{
    stageAccountConfiguration(input: Readonly<{
        values: Readonly<Record<string, JsonValue>>;
        secretValues?: Readonly<Record<string, string>>;
    }>): Promise<void>;
}>;

export type HostConnectedAccountReadContext = Pick<
    ReadContext,
    'account' | 'configuration' | 'credentials' | 'signal' | 'invokedAtMs'
>;
export type HostConnectedAccountMutationContext = HostConnectedAccountReadContext
    & Pick<MutationContext, 'operation' | 'stagedCredentials'>;

type RuntimeContext<T, Authentication, Read> = T extends ConnectedAccountAuthenticationContext
    ? Authentication
    : T extends MutationContext ? Read & Pick<MutationContext, 'operation' | 'stagedCredentials'>
    : T extends ReadContext ? Read
    : T extends NativeContext ? HostConnectedAccountNativeContext
    : T;
type RuntimeForContext<T, Authentication, Read> = T extends (...args: infer Args) => infer Result
    ? (...args: { [K in keyof Args]: RuntimeContext<Args[K], Authentication, Read> }) => Result
    : T extends object ? { readonly [K in keyof T]: RuntimeForContext<T[K], Authentication, Read> } : T;

export type ConnectedAccountAuthenticationModeRuntimeFor<Context> = RuntimeForContext<
    ConnectedAccountRuntime['authentication']['modes'][string], Context, ReadContext
>;
export type ConnectedAccountEstablishedRuntimeFor<Context> = RuntimeForContext<
    Omit<ConnectedAccountRuntime, 'authentication'>, ConnectedAccountAuthenticationContext, Context
>;

/** The existing request/result contracts, with only the host context substituted. */
export type HostConnectedAccountRuntime = RuntimeForContext<ConnectedAccountRuntime,
    HostConnectedAccountAuthenticationContext, HostConnectedAccountReadContext>;
