import type { CatalogAgentId } from '@/agent/catalog/ids';
import { CatalogAgentNotInstalledError, requireCatalogEntry } from '@/agent/catalog/registry';
import {
  resolveCatalogAgentId,
  resolveCatalogAgentIdForCliSubcommand,
} from '@/agent/catalog/resolution';
import { DEFAULT_CATALOG_AGENT_ID } from '@/agent/catalog/ids';

type HeadlessTmuxAgentLaunchConfig = Readonly<{
  agent: CatalogAgentId;
  childArgs: string[];
}>;

function inferAgent(argv: string[]): CatalogAgentId {
  const first = typeof argv[0] === 'string' ? argv[0].trim() : '';
  if (!first || first.startsWith('-')) {
    return DEFAULT_CATALOG_AGENT_ID;
  }

  // A subcommand names the installed catalog entry; it is not limited to the
  // generated bundled census. An unknown non-option command is a CLI invocation
  // error: refuse it here rather than launching the default Agent.
  const requestedAgentId = resolveCatalogAgentIdForCliSubcommand(first) ?? first;
  const catalogAgentId = resolveCatalogAgentId(requestedAgentId);
  if (!catalogAgentId) throw new CatalogAgentNotInstalledError(requestedAgentId);
  return catalogAgentId;
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
