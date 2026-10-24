import type { SessionHookData } from './startHookServer';
import { normalizeClaudeAgentSdkProviderTaskId } from '../providerActivity/createClaudeProviderActivityLedger';

/**
 * Claude Code emits hook events for sidechain (subagent) activity with an
 * `agent_id` attribution field; main-conversation hooks carry no agent id.
 *
 * Sidechain-attributed hooks must never drive the primary turn lifecycle:
 * a subagent StopFailure is not a primary-turn failure and a subagent Stop is
 * not a primary-turn completion. (Live incident 2026-06-12, session
 * cmq8171vw02q5tm6lzgdq32kc: five subagent auth StopFailures marked the
 * canonical turn failed while the main agent kept working, so the session was
 * presented as idle for the rest of the turn.)
 */
export function readSessionHookSidechainAgentId(data: SessionHookData): string | null {
  const raw = data.agent_id ?? data.agentId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Scope shared by SDK and transcript observations of Claude requests. */
export function isClaudeSidechainRuntimeEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const parentToolUseId = record.parent_tool_use_id ?? record.parentToolUseId;
  return record.isSidechain === true
    || (typeof parentToolUseId === 'string' && parentToolUseId.trim().length > 0);
}

export function isSidechainSessionHook(data: SessionHookData): boolean {
  return readSessionHookSidechainAgentId(data) !== null;
}

export function readSessionHookEventName(data: SessionHookData): string {
  const raw = data.hook_event_name ?? data.hookEventName;
  return typeof raw === 'string' ? raw : '';
}

export function readSidechainSessionHookProviderTaskId(data: SessionHookData): string | null {
  const agentId = readSessionHookSidechainAgentId(data);
  return normalizeClaudeAgentSdkProviderTaskId(agentId);
}

export function isSidechainSessionHookRuntimeActivityEvent(data: SessionHookData): boolean {
  switch (readSessionHookEventName(data)) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'UserPromptSubmit':
    case 'Notification':
      return true;
    default:
      return false;
  }
}

export function isSidechainSessionHookRuntimeActivityTerminalEvent(data: SessionHookData): boolean {
  switch (readSessionHookEventName(data)) {
    case 'Stop':
    case 'StopFailure':
    case 'SessionEnd':
      return true;
    default:
      return false;
  }
}
