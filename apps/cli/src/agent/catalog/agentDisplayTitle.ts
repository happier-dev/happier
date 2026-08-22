import { getAgentCliRuntimeSpec, type AgentId } from '@happier-dev/agents';

import { readDeclaredAgentTitle } from '@/plugins/projection/registry/agentCliMetadata';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';

import { readAgentCatalogSnapshot } from './snapshot';

/**
 * Canonical owner of an installed Agent's user-facing display title.
 *
 * Every installed Agent — bundled or externally contributed — declares its own
 * title in its plugin manifest, so the declaration is the authority. The CLI
 * runtime descriptor title (`cli.displayName`, e.g. "Claude Code CLI") names the
 * *CLI tool* rather than the Agent, so it only answers for an Agent that
 * declares no title at all. The generated bundled table is the last resort and
 * legitimately has no entry for an external Agent.
 */
export function readAgentContributionDisplayTitle(
  contribution: ResolvedAgentContribution | null | undefined,
  agentId: AgentId,
): string | null {
  const declared = readDeclaredAgentTitle(contribution?.richDefinition?.definition.title);
  if (declared) return declared;

  const descriptorTitle = readDeclaredAgentTitle(contribution?.runtimeSpec?.title);
  if (descriptorTitle) return descriptorTitle;

  return readDeclaredAgentTitle(getAgentCliRuntimeSpec(agentId)?.title);
}

/**
 * Resolve the display title of an installed Agent by id.
 *
 * Returns null when no Agent with that id is installed, which is a distinct
 * fact from "installed but unnamed" — callers must not substitute another
 * Agent's title for it.
 */
export function resolveAgentDisplayTitle(agentId: AgentId): string | null {
  const { agentDefinitionsById } = readAgentCatalogSnapshot();
  const contribution = agentDefinitionsById.get(agentId);
  if (!contribution) return null;
  return readAgentContributionDisplayTitle(contribution, agentId);
}
