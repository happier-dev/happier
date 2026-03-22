function parseBooleanEnv(value: string | undefined): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export type DaemonDiagnosticSubsystemGates = Readonly<{
    disableMachineSync: boolean;
    disableAutomationWorker: boolean;
}>;

export function resolveDaemonDiagnosticSubsystemGates(
    env: NodeJS.ProcessEnv,
): DaemonDiagnosticSubsystemGates {
    return {
        disableMachineSync: parseBooleanEnv(env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC),
        disableAutomationWorker: parseBooleanEnv(env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER),
    };
}
