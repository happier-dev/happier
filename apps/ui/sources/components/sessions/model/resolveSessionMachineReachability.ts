export function resolveSessionMachineReachability(opts: Readonly<{
    machineIsKnown: boolean;
    machineIsOnline: boolean;
}>): boolean {
    // When we can't resolve the machine record (e.g. shared sessions where the
    // collaborator can't see the owner's machine in their machine list), we
    // must not fail-closed as "offline: unknown". Let the session attempt
    // proceed and rely on the actual runtime/transport errors if it truly
    // can't resume.
    if (!opts.machineIsKnown) return true;
    return opts.machineIsOnline;
}

