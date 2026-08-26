import type { CatalogAgentId } from '@/agent/catalog/ids';
import { CatalogAgentNotInstalledError } from '@/agent/catalog/registry';
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

function ensureHeadlessTmuxRemoteStartingModeArgs(argv: string[]): string[] {
  const modeFlagIndexes: number[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--happy-starting-mode') {
      modeFlagIndexes.push(index);
    }
  }

  if (modeFlagIndexes.length === 0) {
    return [...argv, '--happy-starting-mode', 'remote'];
  }

  for (const index of modeFlagIndexes) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for --happy-starting-mode (expected "remote" or "local" for terminal mode)');
    }
    if (value === 'remote') continue;

    throw new Error('Headless tmux sessions require remote mode; terminal mode is not supported.');
  }

  return argv;
}

export async function resolveHeadlessTmuxAgentLaunchConfig(argv: string[]): Promise<HeadlessTmuxAgentLaunchConfig> {
  const agent = inferAgent(argv);

  return {
    agent,
    childArgs: ensureHeadlessTmuxRemoteStartingModeArgs(argv),
  };
}
