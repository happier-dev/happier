import { killRunawayHappyProcesses } from '@/daemon/doctor';
import { applyHappierRuntimeRepairPlan, buildHappierRuntimeRepairPlan } from '@/diagnostics/happierRuntimeRepair';
import { runDoctorCommand } from '@/ui/doctor';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';
import { cmd, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleDoctorCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;

  if (args[1] === 'repair') {
    const snapshot = await buildDoctorSnapshot();
    const plan = buildHappierRuntimeRepairPlan(snapshot);
    const execute = args.includes('--yes');

    if (args.includes('--json')) {
      if (!execute) {
        console.log(JSON.stringify({ ok: true, executed: false, actions: plan.actions, manualWarnings: plan.manualWarnings }, null, 2));
        return;
      }

      const result = await applyHappierRuntimeRepairPlan(plan);
      console.log(JSON.stringify({ ok: true, executed: true, executedActions: result.executedActions, manualWarnings: plan.manualWarnings }, null, 2));
      return;
    }

    if (!execute) {
      console.log(sectionTitle(`Doctor repair (${plan.actions.length})`));
      for (const action of plan.actions) {
        console.log(`- ${cmd(action.command)}`);
      }
      if (plan.manualWarnings.length > 0) {
        console.log(sectionTitle('Manual follow-up'));
        for (const warning of plan.manualWarnings) {
          console.log(`- ${warn(warning.message)}`);
        }
      }
      console.log(`Re-run with ${cmd('--yes')} to apply supported repairs.`);
      return;
    }

    await applyHappierRuntimeRepairPlan(plan);
    console.log(ok(`Applied ${plan.actions.length} repair action(s).`));
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
