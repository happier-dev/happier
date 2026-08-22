import {
  CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
} from '../agentSettings/definition.js';
import type {
  ClaudeUnifiedTerminalHost,
  ClaudeUnifiedTerminalResumeChoice,
  ClaudeUnifiedTerminalWorkspaceTrustPolicy,
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
  ClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '../agentSettings/definition.js';

export function normalizeClaudeUnifiedTerminalHost(raw: unknown): ClaudeUnifiedTerminalHost | null {
  if (typeof raw !== 'string') return null;
  return (CLAUDE_UNIFIED_TERMINAL_HOSTS as readonly string[]).includes(raw) ? (raw as ClaudeUnifiedTerminalHost) : null;
}

function normalizeEnum<TValue extends string>(
  raw: unknown,
  values: readonly TValue[],
): TValue | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw)
    ? raw as TValue
    : null;
}

export function normalizeClaudeUnifiedTerminalResumeChoice(
  raw: unknown,
): ClaudeUnifiedTerminalResumeChoice | null {
  return normalizeEnum(raw, CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES);
}

export function normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(
  raw: unknown,
): ClaudeUnifiedTerminalWorkspaceTrustPolicy | null {
  return normalizeEnum(raw, CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES);
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

type ClaudeLocalPluginOption = Readonly<{
  type: 'local';
  path: string;
}>;

type ClaudeSystemPromptOption =
  | string
  | Readonly<{
      type: 'preset';
      preset: 'claude_code';
      append?: string;
    }>;

type ClaudeToolsOption =
  | readonly string[]
  | Readonly<{
      type: 'preset';
      preset: 'claude_code';
    }>;

export type ClaudeRemoteAdvancedOptions = Readonly<{
  plugins?: readonly ClaudeLocalPluginOption[];
  betas?: readonly string[];
  maxBudgetUsd?: number;
  sandbox?: Readonly<Record<string, unknown>>;
  additionalDirectories?: readonly string[];
  permissionPromptToolName?: string;
  tools?: ClaudeToolsOption;
  systemPrompt?: ClaudeSystemPromptOption;
  debug?: boolean;
  debugFile?: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function readPlugins(value: unknown): readonly ClaudeLocalPluginOption[] | null {
  if (!Array.isArray(value)) return null;
  const plugins: ClaudeLocalPluginOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== 'local' || typeof entry.path !== 'string') return null;
    plugins.push({ type: 'local', path: entry.path });
  }
  return plugins;
}

function readSystemPrompt(value: unknown): ClaudeSystemPromptOption | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || value.type !== 'preset' || value.preset !== 'claude_code') return null;
  if (value.append !== undefined && typeof value.append !== 'string') return null;
  return {
    type: 'preset',
    preset: 'claude_code',
    ...(typeof value.append === 'string' ? { append: value.append } : {}),
  };
}

function readTools(value: unknown): ClaudeToolsOption | null {
  const tools = readStringArray(value);
  if (tools) return tools;
  return isRecord(value) && value.type === 'preset' && value.preset === 'claude_code'
    ? { type: 'preset', preset: 'claude_code' }
    : null;
}

export function parseClaudeRemoteAdvancedOptionsJson(raw: unknown): ClaudeRemoteAdvancedOptions {
  const normalized = normalizeClaudeRemoteAdvancedOptionsJson(raw);
  if (!normalized) return {};
  const parsed = JSON.parse(normalized) as unknown;
  if (!isRecord(parsed)) return {};

  const plugins = readPlugins(parsed.plugins);
  const betas = readStringArray(parsed.betas);
  const additionalDirectories = readStringArray(parsed.additionalDirectories);
  const tools = readTools(parsed.tools);
  const systemPrompt = readSystemPrompt(parsed.systemPrompt);
  const permissionPromptToolName = typeof parsed.permissionPromptToolName === 'string'
    ? parsed.permissionPromptToolName
    : null;
  const debugFile = typeof parsed.debugFile === 'string' ? parsed.debugFile : null;
  const maxBudgetUsd = typeof parsed.maxBudgetUsd === 'number'
    && Number.isFinite(parsed.maxBudgetUsd)
    && parsed.maxBudgetUsd >= 0
    ? parsed.maxBudgetUsd
    : null;

  return {
    ...(plugins ? { plugins } : {}),
    ...(betas ? { betas } : {}),
    ...(maxBudgetUsd !== null ? { maxBudgetUsd } : {}),
    ...(isRecord(parsed.sandbox) ? { sandbox: parsed.sandbox } : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
    ...(permissionPromptToolName !== null ? { permissionPromptToolName } : {}),
    ...(tools ? { tools } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(typeof parsed.debug === 'boolean' ? { debug: parsed.debug } : {}),
    ...(debugFile !== null ? { debugFile } : {}),
  };
}
