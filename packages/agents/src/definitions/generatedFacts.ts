import {
  AGENT_IDS,
  isBundledAgentId,
  type AgentId,
  type BundledAgentId,
} from '../generated/agentIds.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../generated/bundledAgentDefinitions.js';

type BundledAgentDefinition = (typeof BUNDLED_AGENT_DEFINITIONS_BY_ID)[keyof typeof BUNDLED_AGENT_DEFINITIONS_BY_ID];

const GENERATED_AGENT_DEFINITIONS_BY_ID = BUNDLED_AGENT_DEFINITIONS_BY_ID as Readonly<
  Partial<Record<BundledAgentId, BundledAgentDefinition>>
>;

export function mergeAuthoredWithGeneratedAgentFacts<T>(params: Readonly<{
  authored: Readonly<Partial<Record<BundledAgentId, T>>>;
  label: string;
  readGenerated: (definition: BundledAgentDefinition, agentId: BundledAgentId) => T | null | undefined;
}>): Readonly<Record<BundledAgentId, T>> {
  const entries: Array<[BundledAgentId, T]> = [];

  for (const agentId of AGENT_IDS) {
    const authored = params.authored[agentId];
    if (authored !== undefined) {
      entries.push([agentId, authored]);
      continue;
    }

    const generated = GENERATED_AGENT_DEFINITIONS_BY_ID[agentId];
    const generatedFact = generated ? params.readGenerated(generated, agentId) : null;
    if (generatedFact === null || generatedFact === undefined) {
      throw new Error(`Missing ${params.label} for agent '${agentId}'`);
    }
    entries.push([agentId, generatedFact]);
  }

  return Object.freeze(Object.fromEntries(entries) as Record<BundledAgentId, T>);
}

/**
 * Read a bundled Agent fact by an open Agent id.
 *
 * Bundled fact records are exhaustive over `AGENT_IDS` only. An externally
 * installed Agent has no entry, so the lookup reports a typed unavailable
 * instead of borrowing a bundled Agent's fact.
 */
export function readBundledAgentFact<T>(
  factsByAgentId: Readonly<Record<BundledAgentId, T>>,
  agentId: AgentId,
): T | null {
  return isBundledAgentId(agentId) ? factsByAgentId[agentId] : null;
}
