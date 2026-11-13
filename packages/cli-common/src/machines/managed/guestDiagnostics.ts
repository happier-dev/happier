import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedGuestDiagnosticsV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { BugReportMachineDiagnosticsSnapshotSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type { ManagedNativeBootstrapIO } from '../../systemTasks/kinds/managedMachineEnrollment.js';
import { buildDedicatedDaemonInvocationCommand, buildRemoteHappierInvocationCommand, DEDICATED_DAEMON_INSTALL_HOME } from '../../systemTasks/ssh/remoteBootstrapCommandBuilder.js';
import { resolveRemoteInstalledFirstPartyBinaryPath } from '../../systemTasks/ssh/remoteFirstPartyInstallPath.js';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Explicit finite read: the installed collector owns selection, redaction and tail budgets. */
export async function readManagedGuestDiagnostics(input: Readonly<{
    machine: ManagedMachineV1; requesterAccountId: string | undefined; requestId?: string;
    transport: MachineProvisionerContributionV1['bootstrapTransport'];
    channel: 'stable' | 'preview' | 'dev'; native?: Pick<ManagedNativeBootstrapIO, 'exec'>; signal?: AbortSignal;
}>): Promise<ManagedGuestDiagnosticsV1> {
    const unavailable = (code: string, phase: string, exitCode?: number): ManagedGuestDiagnosticsV1 => ({
        status: 'unavailable', code, phase,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
    });
    if (input.requesterAccountId !== input.machine.custodianAccountId) return unavailable('permission_denied', 'guest_custody');
    if (!input.machine.enrolledMachineId) return unavailable('guest_not_enrolled', 'guest_identity');
    if (!input.machine.resource || input.transport?.kind !== 'native' || !input.native) return unavailable('provider_unavailable', 'guest_transport');
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
        if (result.status !== 0) return unavailable('remote_command_failed', 'guest_collection', result.status);
        let value: unknown;
        try { value = JSON.parse(result.stdout); } catch { return unavailable('invalid_action_output', 'guest_output'); }
        const parsed = BugReportMachineDiagnosticsSnapshotSchema.safeParse(value);
        if (!parsed.success) return unavailable('invalid_action_output', 'guest_output');
        const { daemonState, sessionDiagnostics } = parsed.data;
        if (!daemonState?.machineId) return unavailable('guest_identity_unavailable', 'guest_identity');
        if (daemonState.machineId !== input.machine.enrolledMachineId) return unavailable('resource_mismatch', 'guest_identity');
        return { status: 'collected', snapshot: { daemonState, sessionDiagnostics } };
    } catch (error) {
        input.signal?.throwIfAborted();
        return unavailable(readActionErrorCodeV1(error) ?? 'action_failed', 'guest_collection');
    }
}
