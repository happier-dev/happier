import {
  CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
} from '../agentSettings/definition.js';
import type {
  ClaudeUnifiedTerminalHost,
  ClaudeUnifiedTerminalResumeChoice,
} from '../agentSettings/definition.js';

export {
  CLAUDE_REMOTE_DEBUG_CATEGORIES,
  CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
  CLAUDE_SETTING_SOURCES_V2,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
} from '../agentSettings/definition.js';
export type {
  ClaudeRemoteDebugCategory,
  ClaudeSettingSourceV2,
  ClaudeUnifiedTerminalHost,
  ClaudeUnifiedTerminalResumeChoice,
} from '../agentSettings/definition.js';

export function normalizeClaudeUnifiedTerminalHost(raw: unknown): ClaudeUnifiedTerminalHost | null {
  if (typeof raw !== 'string') return null;
  return (CLAUDE_UNIFIED_TERMINAL_HOSTS as readonly string[]).includes(raw) ? (raw as ClaudeUnifiedTerminalHost) : null;
}

export function normalizeClaudeUnifiedTerminalResumeChoice(
  raw: unknown,
): ClaudeUnifiedTerminalResumeChoice | null {
  if (typeof raw !== 'string') return null;
  return (CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES as readonly string[]).includes(raw)
    ? (raw as ClaudeUnifiedTerminalResumeChoice)
    : null;
}

export function isValidClaudeRemoteAdvancedOptionsJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.length > MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function normalizeClaudeRemoteAdvancedOptionsJson(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!isValidClaudeRemoteAdvancedOptionsJson(trimmed)) return '';
  const parsed = JSON.parse(trimmed) as unknown;
  const normalized = JSON.stringify(parsed);
  return normalized.length <= MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS ? normalized : '';
}
