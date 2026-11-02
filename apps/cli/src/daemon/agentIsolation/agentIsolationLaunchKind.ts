/** Shared by the private runner wire and the canonical launch-policy owner. */
export const HOST_AGENT_ISOLATION_LAUNCH_KINDS = ['exec', 'acp', 'managedService', 'terminal', 'attach', 'workspaceExec'] as const;
export type HostAgentIsolationLaunchKind = typeof HOST_AGENT_ISOLATION_LAUNCH_KINDS[number];
