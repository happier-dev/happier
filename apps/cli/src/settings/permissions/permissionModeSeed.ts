import type { AgentId } from '@happier-dev/agents';
import { resolvePermissionModeGroupForAgent } from '@happier-dev/agents';

import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';

export type PermissionModeSeedSource = 'explicit' | 'inferred' | 'account_default' | 'fallback';

export type PermissionModeSeed = Readonly<{
  mode: PermissionMode;
  source: PermissionModeSeedSource;
}>;

function clampPermissionModeForAgent(agentId: AgentId, mode: PermissionMode): PermissionMode {
  const group = resolvePermissionModeGroupForAgent(agentId);
  if (group === 'codexLike' && mode === 'plan') {
    // Fail closed: codex-like providers do not support plan as a permission mode.
    return 'read-only';
  }
  return mode;
}

export function normalizePermissionModeForAgentStart(opts: { agentId: AgentId; value: unknown }): PermissionMode | null {
  const normalized = normalizePermissionModeToIntent(opts.value);
  if (!normalized) return null;
  return clampPermissionModeForAgent(opts.agentId, normalized);
}

export function resolveAccountDefaultPermissionModeFromAccountSettings(opts: {
  agentId: AgentId;
  accountSettings: unknown;
}): PermissionMode | null {
  const settings = opts.accountSettings;
  const record =
    settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null;
  const rawMap = record?.sessionDefaultPermissionModeByAgent;
  const map =
    rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap) ? (rawMap as Record<string, unknown>) : null;
  const candidate = map?.[opts.agentId];
  return normalizePermissionModeForAgentStart({ agentId: opts.agentId, value: candidate });
}

export function resolvePermissionModeSeedForAgentStart(opts: {
  agentId: AgentId;
  explicitPermissionMode: unknown;
  inferredPermissionMode?: unknown;
  accountSettings: unknown;
}): PermissionModeSeed {
  const explicit = normalizePermissionModeForAgentStart({ agentId: opts.agentId, value: opts.explicitPermissionMode });
  if (explicit) return { mode: explicit, source: 'explicit' };

  const inferred = normalizePermissionModeForAgentStart({ agentId: opts.agentId, value: opts.inferredPermissionMode });
  if (inferred) return { mode: inferred, source: 'inferred' };

  const accountDefault = resolveAccountDefaultPermissionModeFromAccountSettings({
    agentId: opts.agentId,
    accountSettings: opts.accountSettings,
  });
  if (accountDefault) return { mode: accountDefault, source: 'account_default' };

  return { mode: 'default', source: 'fallback' };
}

