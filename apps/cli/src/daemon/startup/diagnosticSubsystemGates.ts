import { parseBooleanEnv } from '@happier-dev/protocol';

export type DaemonDiagnosticSubsystemGates = Readonly<{
    disableMachineSync: boolean;
    disableAutomationWorker: boolean;
}>;

export function resolveDaemonDiagnosticSubsystemGates(
    env: NodeJS.ProcessEnv,
): DaemonDiagnosticSubsystemGates {
    return {
        disableMachineSync: parseBooleanEnv(env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC, false),
        disableAutomationWorker: parseBooleanEnv(env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER, false),
    };
}
