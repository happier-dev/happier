import type { CatalogAgentId as AgentId } from '@/agent/catalog/ids';
import { requireCatalogEntry } from '@/agent/catalog/registry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import { CATALOG_AGENT_IDS, DEFAULT_CATALOG_AGENT_ID } from '@/agent/catalog/ids';

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
