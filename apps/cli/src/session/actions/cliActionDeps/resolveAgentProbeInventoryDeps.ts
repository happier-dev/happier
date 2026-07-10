export async function probeAgentModelsBestEffort(args: unknown): Promise<unknown> {
  const mod = await import('@/capabilities/probes/agentModelsProbe');
  return await mod.probeAgentModelsBestEffort(args as never);
}

export async function probeAgentModesBestEffort(args: unknown): Promise<unknown> {
  const mod = await import('@/capabilities/probes/agentModesProbe');
  return await mod.probeAgentModesBestEffort(args as never);
}

export async function probeAgentConfigOptionsBestEffort(args: unknown): Promise<unknown> {
  const mod = await import('@/capabilities/probes/agentConfigOptionsProbe');
  return await mod.probeAgentConfigOptionsBestEffort(args as never);
}
