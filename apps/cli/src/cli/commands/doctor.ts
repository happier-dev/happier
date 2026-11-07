import { printDoctorHelp } from './doctorHelp';
import { readDaemonProcessesForDoctor, stopStaleDaemonForDoctor } from '@/daemon/doctor';
import { inspectDaemonRunningStateAndCleanupStaleState, requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import { MachineProcessesCleanUpResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { normalizeActionExecuteResult, unwrapCliActionSuccessPayload } from './session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './session/shared/tryHandleApprovalRequestCreated';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { runDoctorCommand } from '@/ui/doctor';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';
import { renderHelpPage } from '@happier-dev/cli-common/output';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';



export async function handleDoctorCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;

  if (args[1] === 'help' || args[1] === '--help' || args[1] === '-h') {
    printDoctorHelp();
    return;
  }

  if (args[1] === 'repair') {
    await handleServiceRepairCliCommand({
      argv: ['repair', ...args.slice(2)],
      commandPath: 'happier doctor',
    });
    return;
  }

  if (args[1] === 'clean') {
    const result = await stopStaleDaemonForDoctor();
    if (result.stopped) console.log(`Stopped ${result.stopped} stale daemon`);
    if (result.errors.length > 0) {
      console.error('Stale daemon stop failed:', result.errors);
      process.exitCode = 1;
      return;
    }
    const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
    if (inspection.status !== 'running') {
      console.log('Process ownership is unavailable until the daemon answers. Start the daemon to review left-behind processes.');
      return;
    }
    const processes = await readDaemonProcessesForDoctor({ target: inspection.state, signal: context.signal });
    if (processes.status === 'unavailable') {
      console.error(`Process ownership is unavailable: ${processes.reason}`);
      process.exitCode = 1;
      return;
    }
    const refs = processes.answer.leftBehind.map(row => row.ref);
    if (!refs.length) {
      console.log('No confirmed left-behind processes.');
      return;
    }
    for (const row of processes.answer.leftBehind) console.log(`PID ${row.pid}: ${row.name}`);
    if (!isInteractiveTerminal()) {
      console.log('Use an interactive terminal to review this cleanup, or invoke happier machines processes clean-up with the confirmed refs.');
      return;
    }
    if (!await promptConfirmYesNo(`Clean up ${refs.length} confirmed left-behind processes?`, {
      default: 'no', ...(context.signal ? { signal: context.signal } : {}),
    })) return;
    // The terminal review selects the set; this normal Action ingress still owns
    // its approval setting and execution-time identity checks.
    const cleanup = normalizeActionExecuteResult(await requestDaemonSignedRootActionExecution({
      actionId: 'machines.processes.leftBehind.cleanUp',
      input: { machineId: processes.answer.machineId, refs }, surface: 'cli',
    }, { target: inspection.state, signal: context.signal }));
    if (!cleanup.ok) {
      console.error(`Cleanup failed: ${cleanup.errorCode}`);
      process.exitCode = 1;
      return;
    }
    const payload = unwrapCliActionSuccessPayload(cleanup.data);
    if (await tryHandleApprovalRequestCreated({ envelopeKind: 'machines_processes_clean_up', json: false, result: payload })) return;
    const parsed = MachineProcessesCleanUpResultV1Schema.safeParse(payload);
    if (!parsed.success) {
      console.error('Cleanup result is unavailable: invalid_action_output');
      process.exitCode = 1;
      return;
    }
    console.log(`Cleaned up ${parsed.data.ended.length} · ${parsed.data.skipped.length} skipped`);
    for (const skipped of parsed.data.skipped) console.log(`${skipped.ref}: ${skipped.reason}`);
    return;
  }

  if (args.includes('--json')) {
    if (args.includes('--include-daemon-log')) {
      const { collectBugReportMachineDiagnosticsSnapshotForBugReport } = await import('@/diagnostics/bugReportMachineDiagnosticsRecipe');
      const snapshot = await collectBugReportMachineDiagnosticsSnapshotForBugReport({
        logSelection: { daemon: true, session: false, provider: false },
      }, { signal: context.signal });
      await writeJsonStdout(snapshot, { pretty: true });
      return;
    }
    const snapshot = await buildDoctorSnapshot();
    await writeJsonStdout(snapshot, { pretty: true });
    return;
  }

  await runDoctorCommand();
}
