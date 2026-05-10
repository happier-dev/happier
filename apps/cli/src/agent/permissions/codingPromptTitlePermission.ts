import {
  extractShellCommand,
  isCodingPromptSessionTitleUpdatesEnabled,
  parseHappierToolsShellBridgeCommand,
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

export function shouldDenyAgentSessionTitleToolCall(params: Readonly<{
  settings: unknown;
  toolName: string;
  input: unknown;
}>): boolean {
  return !isCodingPromptSessionTitleUpdatesEnabled(params.settings)
    && isAgentSessionTitleToolCall(params.toolName, params.input);
}
