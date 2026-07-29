export type SessionMachineReachability = 'reachable' | 'unreachable' | 'unknown';

export function resolveSessionMachineReachabilityState(opts: Readonly<{
    machineIsKnown: boolean;
    machineIsOnline: boolean;
}>): SessionMachineReachability {
    if (!opts.machineIsKnown) return 'unknown';
    return opts.machineIsOnline ? 'reachable' : 'unreachable';
}

export function resolveSessionMachineReachability(opts: Readonly<{
    machineIsKnown: boolean;
    machineIsOnline: boolean;
}>): boolean {
    // When we can't resolve the machine record (e.g. shared sessions where the
    // collaborator can't see the owner's machine in their machine list), we
    // must not fail-closed as "offline: unknown". Let the session attempt
    // proceed and rely on the actual runtime/transport errors if it truly
    // can't resume.
    return resolveSessionMachineReachabilityState(opts) !== 'unreachable';
}
