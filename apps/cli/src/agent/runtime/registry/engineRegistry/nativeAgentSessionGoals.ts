import type { AgentSessionCapabilities } from '@happier-dev/agents';
import type { AgentSessionGoalControl, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

/** The opened runtime, including transport suppression, owns native Goal availability. */
export function resolveNativeAgentSessionGoals(
    session: AgentSessionRuntime,
    capabilities: AgentSessionCapabilities,
    factoryGoals?: AgentSessionGoalControl,
): AgentSessionGoalControl | undefined {
    return capabilities.goals?.active && session.nativeGoalControlsSupported !== false
        ? session.goals ?? factoryGoals
        : undefined;
}
