import { autoApprovedNames } from './autoApprovedNames.generated.js';
import { isChangeTitleToolLikeName } from './v2/aliases.js';

const toolNames = autoApprovedNames;
const normalizedNames = new Set(toolNames.map((name) => name.toLowerCase()));
const recognizedPrefixes = ['mcp__happier__', 'mcp__happy__', 'happier__', 'happy__', 'happier_', 'happy_'];

/** Bare names for native Agent permission projections and session-scoped servers. */
export function listHappierToolAutoApprovedNamesV1(): readonly string[] {
  return toolNames;
}

/** Project only the native server prefix used by this launch, never recognition aliases. */
export function listHappierToolAutoApprovedNameSpellingsV1(nativePrefix: string): readonly string[] {
  return Object.freeze(toolNames.map((name) => `${nativePrefix}${name}`));
}

export function isHappierToolAutoApprovedByAgentLayerV1(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalizedNames.has(normalized)
    || recognizedPrefixes.some((prefix) => normalized.startsWith(prefix) && normalizedNames.has(normalized.slice(prefix.length)))
    || (normalizedNames.has('session_title_set') && isChangeTitleToolLikeName(normalized));
}
