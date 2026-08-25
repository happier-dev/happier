import {
  extractShellCommand,
  parseHappierToolsShellBridgeCommand,
  resolveEffectiveCodingPromptBehaviorV1,
} from '@happier-dev/protocol';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';

function readActionId(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const raw = (input as Record<string, unknown>).actionId;
  return typeof raw === 'string' ? raw.trim() : '';
}

function isTitleActionExecute(toolName: string, input: unknown): boolean {
  const lower = toolName.toLowerCase();
  return lower.includes('action_execute') && readActionId(input) === 'session.title.set';
}

function isShellBridgeTitleCall(toolName: string, input: unknown): boolean {
  const lowerToolName = toolName.toLowerCase();
  if (lowerToolName !== 'bash' && lowerToolName !== 'execute' && lowerToolName !== 'shell') return false;

  const command = extractShellCommand(input);
  if (!command) return false;

  const parsed = parseHappierToolsShellBridgeCommand(command);
  if (!parsed || parsed.kind !== 'call') return false;
  if (parsed.source !== 'happier') return false;
  return parsed.tool === 'change_title' || parsed.tool === 'session_title_set';
}

export function isAgentSessionTitleToolCall(toolName: string, input: unknown): boolean {
  return isChangeTitleToolLikeName(toolName)
    || isTitleActionExecute(toolName, input)
    || isShellBridgeTitleCall(toolName, input);
}

/**
 * Tool admission for agent-initiated session-title calls.
 *
 * Reads the SAME resolved `codingPromptBehavior` fact the prompt composer reads
 * (`resolveEffectiveCodingPromptBehaviorV1`: Account default, then the selected
 * Launch Profile's sparse override). Deciding from the Account value alone made
 * this a second decision-maker: a profile that re-enabled title updates was told
 * to call `change_title` by the system prompt while this gate denied every call.
 */
export function shouldDenyAgentSessionTitleToolCall(params: Readonly<{
  settings: unknown;
  profileId?: string | null | undefined;
  toolName: string;
  input: unknown;
}>): boolean {
  if (!isAgentSessionTitleToolCall(params.toolName, params.input)) return false;
  return resolveEffectiveCodingPromptBehaviorV1({
    settings: params.settings,
    profileId: params.profileId ?? null,
  }).sessionTitleUpdates === 'disabled';
}
