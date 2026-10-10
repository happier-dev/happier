/**
 * GENERATED FILE CONTRACT (A.X-agent-ids-codegen)
 *
 * This file is emitted by:
 * - `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`
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
  'devin',
  'fx',
  'droid',
  'codebuddy',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
  'coderabbit',
  'deepsec',
  'custom-acp',
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

export const BUNDLED_AGENT_CONTRIBUTION_IDENTITIES: Readonly<Record<
  BundledAgentId,
  Readonly<{ pluginId: string; localId: string }>
>> = Object.freeze({
  'claude': Object.freeze({
    pluginId: 'happier.agent.claude',
    localId: 'claude',
  }),
  'codex': Object.freeze({
    pluginId: 'happier.agent.codex',
    localId: 'codex',
  }),
  'opencode': Object.freeze({
    pluginId: 'happier.agent.opencode',
    localId: 'opencode',
  }),
  'antigravity': Object.freeze({
    pluginId: 'happier.agent.antigravity',
    localId: 'antigravity',
  }),
  'gemini': Object.freeze({
    pluginId: 'happier.agent.gemini',
    localId: 'gemini',
  }),
  'grok': Object.freeze({
    pluginId: 'happier.agent.grok',
    localId: 'grok',
  }),
  'auggie': Object.freeze({
    pluginId: 'happier.agent.auggie',
    localId: 'auggie',
  }),
  'qwen': Object.freeze({
    pluginId: 'happier.agent.qwen',
    localId: 'qwen',
  }),
  'kimi': Object.freeze({
    pluginId: 'happier.agent.kimi',
    localId: 'kimi',
  }),
  'kilo': Object.freeze({
    pluginId: 'happier.agent.kilo',
    localId: 'kilo',
  }),
  'kiro': Object.freeze({
    pluginId: 'happier.agent.kiro',
    localId: 'kiro',
  }),
  'devin': Object.freeze({
    pluginId: 'happier.agent.devin',
    localId: 'devin',
  }),
  'fx': Object.freeze({
    pluginId: 'happier.agent.fx',
    localId: 'fx',
  }),
  'droid': Object.freeze({
    pluginId: 'happier.agent.droid',
    localId: 'droid',
  }),
  'codebuddy': Object.freeze({
    pluginId: 'happier.agent.codebuddy',
    localId: 'codebuddy',
  }),
  'cursor': Object.freeze({
    pluginId: 'happier.agent.cursor',
    localId: 'cursor',
  }),
  'ohMyPi': Object.freeze({
    pluginId: 'happier.agent.ohmypi',
    localId: 'ohmypi',
  }),
  'pi': Object.freeze({
    pluginId: 'happier.agent.pi',
    localId: 'pi',
  }),
  'copilot': Object.freeze({
    pluginId: 'happier.agent.copilot',
    localId: 'copilot',
  }),
  'coderabbit': Object.freeze({
    pluginId: 'happier.review.coderabbit',
    localId: 'coderabbit',
  }),
  'deepsec': Object.freeze({
    pluginId: 'happier.review.deepsec',
    localId: 'deepsec',
  }),
  'custom-acp': Object.freeze({
    pluginId: 'happier.agent.custom-acp',
    localId: 'custom-acp',
  }),
});

const BUNDLED_AGENT_ID_SET: ReadonlySet<string> = new Set(AGENT_IDS);

export function isBundledAgentId(value: unknown): value is BundledAgentId {
  return typeof value === 'string' && BUNDLED_AGENT_ID_SET.has(value);
}
