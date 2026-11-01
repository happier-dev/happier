/** Existing Account-operation admission belongs to the hosting executor. */
export type ConnectedAccountEstablishedReadScope = Readonly<{
    isAccountRuntimeCurrent(signal?: AbortSignal): Promise<boolean>;
    assertAccountRuntimeCurrent(signal?: AbortSignal): Promise<void>;
    runMaterialization<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    runCurrentAccountRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T>;
    runIndependentAccountRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}>;

export type ConnectedAccountEstablishedPhase =
    | 'established_account_currentness' | 'established_credential_read'
    | 'established_configuration_read' | 'established_account_mode'
    | 'established_snapshots' | 'established_registry' | 'established_runtime_resolution'
    | 'established_configuration_record' | 'established_configuration'
    | 'established_registry_release' | 'established_runtime'
    | 'runtime_callback_before' | 'runtime_callback' | 'runtime_callback_after'
    | 'runtime_configuration_currentness' | 'runtime_credential_currentness';
export type ConnectedAccountEstablishedPhaseObserver = <T>(phase: ConnectedAccountEstablishedPhase, work: () => T | Promise<T>) => Promise<T>;

export function assertNotAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Connected-account established operation was aborted');
}
