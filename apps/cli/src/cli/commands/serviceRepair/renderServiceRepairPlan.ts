import { cmd, createOutputBuilder, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

import type { HappierRuntimeRepairPlan } from '@/diagnostics/happierRuntimeRepair';

export function renderServiceRepairPlan(params: Readonly<{
    plan: HappierRuntimeRepairPlan;
    commandPath: string;
}>): string {
    const out = createOutputBuilder();
    out.line(sectionTitle(`Background service repair (${params.plan.actions.length})`));
    for (const action of params.plan.actions) {
        if (action.kind === 'install-default-following-service' && action.targetServerUrl) {
            out.line(`- Current default server: ${action.targetServerUrl}`);
        }
        out.line(`- ${cmd(action.command)}`);
    }
    if (params.plan.manualWarnings.length > 0) {
        out.blank();
        out.line(sectionTitle('Manual follow-up'));
        for (const manualWarning of params.plan.manualWarnings) {
            out.line(`- ${warn(manualWarning.message)}`);
        }
    }
    out.blank();
    out.line(`Re-run with ${cmd('--yes')} to apply supported repairs.`);
    if (params.commandPath !== 'happier service') {
        out.line(ok(`Canonical command: ${cmd('happier service repair')}`));
    }
    return out.render();
}
