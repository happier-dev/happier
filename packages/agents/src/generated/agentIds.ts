/**
 * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)
 *
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 *
 * Agent ids are sourced from the built-in runtime catalog plus bundled plugin `AGENT_DEFINITION.id` values.
 */

export const AGENT_IDS = Object.freeze([
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
  'coderabbit',
  'deepsec',
] as const);

export type AgentId = (typeof AGENT_IDS)[number];

const AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_ID_SET.has(value);
}
