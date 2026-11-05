import * as React from 'react';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';

import { useConnectedServicesAgentUses } from '../model/useConnectedServicesAgents';

export type AgentSignInTarget = Readonly<{
  /** Presentation row key (`agent:<agentId>`), never a visible label. */
  key: string;
  agent: string;
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
}>;

const NONE: readonly AgentSignInTarget[] = [];

/**
 * Who each agent signs in as on any machine of this Account: its Account default sign-in, from the same
 * agent catalog projection and purpose defaults "How agents sign in" edits (58d "Agents sign in as").
 * Display only; an agent with no default (its own login) is left out. Empty until both are known.
 */
export function useAgentSignInTargets(): readonly AgentSignInTarget[] {
  const { agentUses } = useConnectedServicesAgentUses({
    agents: 'cached',
  });
  return React.useMemo(() => {
    if (!agentUses) return NONE;
    return agentUses.flatMap((agent) => {
      const target = agent.defaults[0];
      return target
        ? [{ key: `agent:${agent.agentId}`, agent: agent.title, target }]
        : [];
    });
  }, [agentUses]);
}
