import { killRunawayHappyProcesses } from '@/daemon/doctor';
import { runDoctorCommand } from '@/ui/doctor';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';
import { handleServiceRepairCliCommand } from './serviceRepair/handleServiceRepairCliCommand';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleDoctorCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;

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
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  await runDoctorCommand();
}
