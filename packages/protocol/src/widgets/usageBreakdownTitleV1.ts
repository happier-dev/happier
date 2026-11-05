import type { UsageAnalyticsBreakdownDimension } from '../usage/usageAnalyticsContracts.js';
import type { WidgetInstanceV1 } from './widgetInstanceV1.js';

/** Block headings and configured card names share the same dimension vocabulary. */
export const USAGE_BREAKDOWN_DIMENSION_HEADING = {
  agent: 'usage.board.page.dimensionAgent',
  model: 'usage.board.page.dimensionModel',
  session: 'usage.board.page.dimensionSession',
  project: 'usage.board.page.dimensionProject',
  workspace: 'usage.board.page.dimensionWorkspace',
  backendMode: 'usage.board.page.dimensionBackendMode',
  source: 'usage.board.page.dimensionSource',
  machine: 'usage.board.page.dimensionMachine',
} as const satisfies Record<UsageAnalyticsBreakdownDimension, string>;

const titles = {
  agent: { title: 'Agents', titleKey: 'usage.board.page.filterAgents' },
  model: { title: 'Models', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.model },
  session: { title: 'Sessions', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.session },
  project: { title: 'Projects', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.project },
  workspace: { title: 'Workspaces', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.workspace },
  backendMode: { title: 'Backend modes', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.backendMode },
  source: { title: 'Sources', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.source },
  machine: { title: 'Machines', titleKey: USAGE_BREAKDOWN_DIMENSION_HEADING.machine },
} as const satisfies Record<UsageAnalyticsBreakdownDimension, Readonly<{ title: string; titleKey: string }>>;

/** One explicit dimension names the card; defaults and multiple dimensions keep its descriptor title. */
export function readUsageBreakdownsInstanceTitleV1(instance: Pick<WidgetInstanceV1, 'definition' | 'bindings'>) {
  if (instance.definition.kind !== 'builtin' || instance.definition.id !== 'usage_breakdowns') return null;
  const binding = instance.bindings.breakdown;
  if (binding?.kind !== 'value' || !Array.isArray(binding.value) || binding.value.length !== 1) return null;
  const dimension = binding.value[0];
  return typeof dimension === 'string' && Object.hasOwn(titles, dimension)
    ? titles[dimension as UsageAnalyticsBreakdownDimension] : null;
}
