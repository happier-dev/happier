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

/**
 * Agent ids bundled with this build.
 *
 * Closed by construction: it is the discoverability list of Agents whose facts
 * ship inside the host, and it is the correct key for records that are
 * exhaustive over bundled Agents.
 */
export type BundledAgentId = (typeof AGENT_IDS)[number];

/**
 * Any installed Agent id.
 *
 * Plugin manifests admit an open local Agent identifier, so an externally
 * installed Agent legitimately carries an id outside `AGENT_IDS`. The
 * `(string & {})` member keeps editor autocomplete on the bundled ids while
 * accepting those contributed ids; validation belongs to the parsing boundary
 * that produced the id, not to this type.
 */
export type AgentId = BundledAgentId | (string & {});

const BUNDLED_AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);

export function isBundledAgentId(value: unknown): value is BundledAgentId {
  return typeof value === 'string' && BUNDLED_AGENT_ID_SET.has(value);
}
