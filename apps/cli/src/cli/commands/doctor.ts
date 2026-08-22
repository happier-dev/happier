import { killRunawayHappyProcesses } from '@/daemon/doctor';
import { runDoctorCommand } from '@/ui/doctor';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';
import { renderHelpPage } from '@happier-dev/cli-common/output';
import { handleServiceRepairCliCommand } from './service/repair/handleServiceRepairCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';

function printDoctorHelp(): void {
  console.log(renderHelpPage({
    title: 'happier doctor',
    subtitle: 'System diagnostics and repair',
    usage: [
      { label: 'happier doctor [--json]', description: 'Inspect CLI and daemon health' },
      { label: 'happier doctor repair [options]', description: 'Plan or apply supported repairs' },
      { label: 'happier doctor clean', description: 'Stop runaway Happier processes' },
    ],
  }));
}

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
    const result = await killRunawayHappyProcesses();
    console.log(`Cleaned up ${result.killed} runaway processes`);
    if (result.errors.length > 0) {
      console.log('Errors:', result.errors);
    }
    process.exit(0);
  }

  if (args.includes('--json')) {
    const snapshot = await buildDoctorSnapshot();
    await writeJsonStdout(snapshot, { pretty: true });
    return;
  }

  await runDoctorCommand();
}
