/**
 * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Agent provider ids are sourced from the built-in runtime catalog plus bundled plugin `AGENT_DEFINITION.id` values.
 */

export const AGENT_PROVIDER_IDS = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'gemini',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
] as const);

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

const AGENT_PROVIDER_ID_SET: ReadonlySet<string> = new Set(AGENT_PROVIDER_IDS);

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && AGENT_PROVIDER_ID_SET.has(value);
}
