import { applyHappierRuntimeRepairPlan, buildHappierRuntimeRepairPlan } from '@/diagnostics/happierRuntimeRepair';
import { buildDoctorSnapshot } from '@/ui/doctorSnapshot';
import { ok } from '@happier-dev/cli-common/output';

import { isInteractiveTerminal, promptInput } from '../server/commandUtilities';
import { renderServiceRepairPlan } from './renderServiceRepairPlan';

export async function handleServiceRepairCliCommand(params: Readonly<{
    argv: readonly string[];
    commandPath: string;
}>): Promise<void> {
    const execute = params.argv.includes('--yes');
    const asJson = params.argv.includes('--json');
    const snapshot = await buildDoctorSnapshot();
    const plan = buildHappierRuntimeRepairPlan(snapshot);

    if (asJson) {
        if (!execute) {
            console.log(JSON.stringify({
                ok: true,
                executed: false,
                actions: plan.actions,
                manualWarnings: plan.manualWarnings,
            }, null, 2));
            return;
        }

        const result = await applyHappierRuntimeRepairPlan(plan);
        console.log(JSON.stringify({
            ok: true,
            executed: true,
            executedActions: result.executedActions,
            manualWarnings: plan.manualWarnings,
        }, null, 2));
        return;
    }

    if (!execute) {
        console.log(renderServiceRepairPlan({
            plan,
            commandPath: params.commandPath,
        }));
        if (!isInteractiveTerminal() || plan.actions.length === 0) {
            return;
        }

        const answer = await promptInput('Apply these recommended background-service repair actions now? [Y/n]: ');
        const normalizedAnswer = String(answer ?? '').trim().toLowerCase();
        const shouldExecute = normalizedAnswer === '' || normalizedAnswer === 'y' || normalizedAnswer === 'yes';
        if (!shouldExecute) {
            return;
        }
    }

    await applyHappierRuntimeRepairPlan(plan);
    console.log(ok(`Applied ${plan.actions.length} background-service repair action(s).`));
}
