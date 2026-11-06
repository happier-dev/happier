import type { TabType } from './tabTypes';

export type ResolveTabBarTabsInput = Readonly<{
  inboxEnabled: boolean;
  /** The Workflows destination is discoverable (`useWorkflowsDestinationAccess`). */
  workflowsEnabled: boolean;
}>;

/** The phone's tabs (owner Q4): Sessions, Projects, Inbox, Workflows, each while its destination exists. */
export function resolveTabBarTabs(input: ResolveTabBarTabsInput): TabType[] {
  return [
    'sessions',
    'projects',
    ...(input.inboxEnabled ? ['inbox' as const] : []),
    ...(input.workflowsEnabled ? ['workflows' as const] : []),
  ];
}
