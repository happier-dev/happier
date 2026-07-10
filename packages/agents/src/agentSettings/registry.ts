import type { SettingDefinitionMap } from '@happier-dev/protocol';
import type { ZodTypeAny } from 'zod';

import { buildAgentSettingsDefinitionFromContribution } from './fromContribution.js';
import { BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS } from './generated/bundledAgentSettings.js';
import type { AgentSettingsDefinition, AgentSettingsDescriptor } from './types.js';

const BUNDLED_AGENT_SETTINGS_DEFINITIONS = BUNDLED_AGENT_SETTINGS_CONTRIBUTIONS.map(
  buildAgentSettingsDefinitionFromContribution,
);

const ALL_DEFINITIONS: readonly AgentSettingsDefinition[] = Object.freeze(BUNDLED_AGENT_SETTINGS_DEFINITIONS);

export function getAllAgentSettingsDefinitions(): readonly AgentSettingsDefinition[] {
  return ALL_DEFINITIONS;
}

export function getAgentSettingsDefinition(agentId: string): AgentSettingsDefinition | null {
  return (ALL_DEFINITIONS.find((d) => d.agentId === agentId) ?? null) as AgentSettingsDefinition | null;
}

export function getAgentSettingsFields(agentId: string): SettingDefinitionMap | null {
  return getAgentSettingsDefinition(agentId)?.fields ?? null;
}

export function getAgentSettingsDefaults(agentId: string): Readonly<Record<string, unknown>> | null {
  const fields = getAgentSettingsFields(agentId);
  if (!fields) return null;
  return Object.freeze(
    Object.fromEntries(Object.entries(fields).map(([key, definition]) => [key, definition.default])),
  );
}

export function getAgentSettingsShape(agentId: string): Readonly<Record<string, ZodTypeAny>> | null {
  const fields = getAgentSettingsFields(agentId);
  if (!fields) return null;
  return Object.freeze(
    Object.fromEntries(Object.entries(fields).map(([key, definition]) => [key, definition.schema])),
  );
}

export function assertAgentSettingsRegistryValid(definitions: readonly AgentSettingsDescriptor[] = ALL_DEFINITIONS): void {
  assertAgentSettingsRegistryValidFor(definitions);
}

export function assertAgentSettingsRegistryValidFor(definitions: readonly AgentSettingsDescriptor[]): void {
  const seenAgents = new Set<string>();
  const seenKeys = new Set<string>();

  for (const def of definitions) {
    if (seenAgents.has(def.agentId)) {
      throw new Error(`Duplicate agent settings definition: ${def.agentId}`);
    }
    seenAgents.add(def.agentId);

    for (const key of Object.keys(def.fields)) {
      if (seenKeys.has(key)) {
        throw new Error(`Agent settings key "${key}" is defined more than once across agents`);
      }
      seenKeys.add(key);
    }
  }
}
