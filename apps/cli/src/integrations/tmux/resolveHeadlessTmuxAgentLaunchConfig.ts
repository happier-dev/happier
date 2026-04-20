import type { AgentId } from '@/agent/core';
import { requireCatalogEntry, resolveCatalogAgentId } from '@/backends/catalog';
import { CATALOG_AGENT_IDS, DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';

type HeadlessTmuxAgentLaunchConfig = Readonly<{
  agent: AgentId;
  childArgs: string[];
}>;

function inferAgent(argv: string[]): AgentId {
  const first = argv[0];
  if (typeof first === 'string' && (CATALOG_AGENT_IDS as readonly string[]).includes(first)) {
    return resolveCatalogAgentId(first as AgentId);
  }
  return DEFAULT_CATALOG_AGENT_ID;
}

export async function resolveHeadlessTmuxAgentLaunchConfig(argv: string[]): Promise<HeadlessTmuxAgentLaunchConfig> {
  const agent = inferAgent(argv);
  const entry = requireCatalogEntry(agent);
  const transform = entry.getHeadlessTmuxArgvTransform ? await entry.getHeadlessTmuxArgvTransform() : null;

  return {
    agent,
    childArgs: transform ? transform(argv) : argv,
  };
}
