import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { SessionGoalControlAdapterParams } from '@/session/goalControls/sessionGoalControlTypes';
import type { BoundAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

export type InactiveSessionControlLaunchScope = Readonly<{
  environment: Readonly<Record<string, string>>;
  nativeOperation?: import('../agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
  connectedAccounts: AgentSessionControlContext['session']['connectedAccounts'];
  exactPurposeBindingSubjectId?: string;
  agentCliLaunch?: BoundAgentCliLaunchSpec;
  providerBindingActive?: boolean;
  connectedAccountsOwner?: import('@/plugins/runtime/invocation/services/connectedAccounts').StablePluginConnectedAccountsOwner;
  assertCurrent(): Promise<void>;
  dispose(): Promise<void>;
}>;

export type ResolveInactiveSessionControlLaunchScope = (input: Readonly<{
  agentId: string;
  runtimeRegistryLease: PluginRuntimeRegistryLease;
  adapterParams: Pick<SessionGoalControlAdapterParams, 'sessionId' | 'rawSession' | 'metadata' | 'cwd' | 'credentials'>;
  signal: AbortSignal;
}>) => Promise<InactiveSessionControlLaunchScope>;

// The daemon installs its existing admitted Session/Account launch composition.
// Controls outside that owner have no authority to borrow a host-default home.
let activeResolver: ResolveInactiveSessionControlLaunchScope | null = null;

export function bindInactiveSessionControlLaunchScope(resolver: ResolveInactiveSessionControlLaunchScope): () => void {
  activeResolver = resolver;
  return () => { if (activeResolver === resolver) activeResolver = null; };
}

export const resolveInactiveSessionControlLaunchScope: ResolveInactiveSessionControlLaunchScope = async input => {
  if (!activeResolver) throw new PluginError({
    code: 'inactive_agent_launch_scope_unavailable',
    message: 'The Session launch admission owner is unavailable',
  });
  return await activeResolver(input);
};
