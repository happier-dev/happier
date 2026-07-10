import {
  AGENT_IDS,
  type AgentId,
} from '../generated/agentIds.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../generated/bundledAgentDefinitions.js';

type BundledAgentDefinition = (typeof BUNDLED_AGENT_DEFINITIONS_BY_ID)[keyof typeof BUNDLED_AGENT_DEFINITIONS_BY_ID];

const GENERATED_AGENT_DEFINITIONS_BY_ID = BUNDLED_AGENT_DEFINITIONS_BY_ID as Readonly<
  Partial<Record<AgentId, BundledAgentDefinition>>
>;

export function mergeAuthoredWithGeneratedAgentFacts<T>(params: Readonly<{
  authored: Readonly<Partial<Record<AgentId, T>>>;
  label: string;
  readGenerated: (definition: BundledAgentDefinition) => T | null | undefined;
}>): Readonly<Record<AgentId, T>> {
  const entries: Array<[AgentId, T]> = [];

  for (const agentId of AGENT_IDS) {
    const authored = params.authored[agentId];
    if (authored !== undefined) {
      entries.push([agentId, authored]);
      continue;
    }

    const generated = GENERATED_AGENT_DEFINITIONS_BY_ID[agentId];
    const generatedFact = generated ? params.readGenerated(generated) : null;
    if (generatedFact === null || generatedFact === undefined) {
      throw new Error(`Missing ${params.label} for agent '${agentId}'`);
    }
    entries.push([agentId, generatedFact]);
  }

  return Object.freeze(Object.fromEntries(entries) as Record<AgentId, T>);
}
