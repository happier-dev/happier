import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';

export function renderServiceRepairPlan(params: Readonly<{
  plan: BackgroundServiceRepairPlan;
  commandPath: string;
}>): string {
  const warningLines = params.plan.manualWarnings.length > 0
    ? [
        '',
        'Manual cleanup required:',
        ...params.plan.manualWarnings.map((warning) => `- ${warning}`),
      ]
    : [];

  if (params.plan.actions.length === 0) {
    return [
      params.plan.manualWarnings.length > 0
        ? 'No automatic background-service repair actions are available.'
        : 'No background-service repair actions are needed.',
      ...warningLines,
    ].join('\n');
  }

  return [
    `Background service repair (${params.plan.actions.length})`,
    '',
    ...params.plan.actions.map((action, index) => {
      if (action.kind === 'remove-service') {
        return `${index + 1}. Remove ${action.service.label} (${action.service.mode}, ${action.service.releaseChannel}, ${action.service.targetMode})`;
      }
      return `${index + 1}. Install one default background service on ${action.releaseChannel} (${action.mode})`;
    }),
    '',
    `Run ${params.commandPath} repair --yes to apply these actions non-interactively.`,
    ...warningLines,
  ].join('\n');
}
