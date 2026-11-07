import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedGuestDiagnosticsV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { BugReportMachineDiagnosticsSnapshotSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';
import { buildDedicatedDaemonInvocationCommand, buildRemoteHappierInvocationCommand, DEDICATED_DAEMON_INSTALL_HOME } from '../../systemTasks/ssh/remoteBootstrapCommandBuilder.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../../systemTasks/ssh/remoteFirstPartyInstallPath.js';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

/** Explicit finite read: the installed collector owns selection, redaction and tail budgets. */
export async function readManagedGuestDiagnostics(input: Readonly<{
    machine: ManagedMachineV1; requesterAccountId: string | undefined;
    transport: MachineProvisionerContributionV1['bootstrapTransport'];
    channel: 'stable' | 'preview' | 'dev'; native?: Pick<ManagedNativeBootstrapIO, 'exec'>; signal?: AbortSignal;
}>): Promise<ManagedGuestDiagnosticsV1> {
    const unavailable = (code: string): ManagedGuestDiagnosticsV1 => ({ status: 'unavailable', code });
    if (input.requesterAccountId !== input.machine.custodianAccountId) return unavailable('permission_denied');
    if (!input.machine.enrolledMachineId) return unavailable('admission_unavailable');
    if (!input.machine.resource || input.transport?.kind !== 'native' || !input.native) return unavailable('provider_unavailable');
    const dedicated = input.machine.enrollmentIdentity?.kind === 'dedicatedDaemonUser';
    const command = buildRemoteHappierInvocationCommand({
        binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({ componentId: 'happier-cli', channel: input.channel,
            ...(dedicated ? { remoteHomeDir: DEDICATED_DAEMON_INSTALL_HOME } : {}) }),
        args: ['doctor', '--json', '--include-daemon-log'], channel: input.channel,
    });
    try {
        input.signal?.throwIfAborted();
        const result = await input.native.exec({ command: dedicated ? buildDedicatedDaemonInvocationCommand(command) : command,
            allowWake: false, signal: input.signal });
        if (result.status !== 0) return { status: 'unavailable', code: 'remote_command_failed', exitCode: result.status };
        let value: unknown;
        try { value = JSON.parse(result.stdout); } catch { return unavailable('invalid_action_output'); }
        const parsed = BugReportMachineDiagnosticsSnapshotSchema.safeParse(value);
        if (!parsed.success) return unavailable('invalid_action_output');
        const { daemonState, sessionDiagnostics } = parsed.data;
        if (!daemonState?.machineId) return unavailable('admission_unavailable');
        if (daemonState.machineId !== input.machine.enrolledMachineId) return unavailable('resource_mismatch');
        return { status: 'collected', snapshot: { daemonState, sessionDiagnostics } };
    } catch (error) {
        input.signal?.throwIfAborted();
        return unavailable(error instanceof ManagedMachineControllerError || error instanceof SystemTaskExecutionError
            ? error.code : 'provider_unavailable');
    }
}
