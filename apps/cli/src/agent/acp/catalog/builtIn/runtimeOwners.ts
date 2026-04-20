import { hasBuiltInAcpConfig, type AgentId } from '@happier-dev/agents';

export async function loadBuiltInRuntimeOwners(agentId: AgentId) {
  if (!hasBuiltInAcpConfig(agentId)) {
    throw new Error(`Agent '${agentId}' is not registered as a built-in generic ACP agent`);
  }

  const [
    { createBuiltInBackend },
    { createBuiltInSessionPlan },
  ] = await Promise.all([
    import('./backend'),
    import('./sessionPlan'),
  ]);

  return {
    createRuntime: (opts: Parameters<typeof createBuiltInBackend>[1]) =>
      createBuiltInBackend(agentId, opts),
    createHostSessionRuntimePlan: (
      sessionParams: Parameters<typeof createBuiltInSessionPlan>[1],
    ) => createBuiltInSessionPlan(agentId, sessionParams),
  };
}
