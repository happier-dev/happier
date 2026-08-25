import {
  readAccountSettingValueForBackendTarget,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import { AGENT_IDS, resolvePermissionModeGroupForAgent, type AgentId } from '@happier-dev/agents';

import type { PermissionMode } from '@/api/types';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permissions/modeCanonical';

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

function isBuiltInAgentId(agentId: string): agentId is AgentId {
  return (AGENT_IDS as readonly string[]).includes(agentId);
}

function clampPermissionModeForAgentStart(agentId: string, mode: PermissionMode): PermissionMode {
  return isBuiltInAgentId(agentId) ? clampPermissionModeForAgent(agentId, mode) : mode;
}

export function normalizePermissionModeForAgentStart(opts: { agentId: string; value: unknown }): PermissionMode | null {
  const normalized = normalizePermissionModeToIntent(opts.value);
  if (!normalized) return null;
  return clampPermissionModeForAgentStart(opts.agentId, normalized);
}

export function resolveAccountDefaultPermissionModeFromAccountSettings(opts: {
  agentId: string;
  backendTarget?: BackendTargetRefV1;
  accountSettings: unknown;
}): PermissionMode | null {
  const preferredTarget = opts.backendTarget
    ?? ({ kind: 'builtInAgent', agentId: opts.agentId } as const satisfies BackendTargetRefV1);
  // The Account Settings catalog owns this map's key vocabulary. Building a
  // legacy `agent:`/`acpBackend:` key here would never match the parsed
  // projection, so an Account default the user set would be silently ignored.
  const candidate = readAccountSettingValueForBackendTarget(
    opts.accountSettings,
    'sessionDefaultPermissionModeByTargetKey',
    preferredTarget,
  ) ?? (isBuiltInAgentId(opts.agentId)
    ? readAccountSettingValueForBackendTarget(
      opts.accountSettings,
      'sessionDefaultPermissionModeByTargetKey',
      { kind: 'builtInAgent', agentId: opts.agentId },
    )
    : undefined);
  return normalizePermissionModeForAgentStart({ agentId: opts.agentId, value: candidate });
}

export function resolvePermissionModeSeedForAgentStart(opts: {
  agentId: string;
  backendTarget?: BackendTargetRefV1;
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
    backendTarget: opts.backendTarget,
    accountSettings: opts.accountSettings,
  });
  if (accountDefault) return { mode: accountDefault, source: 'account_default' };

  return { mode: 'default', source: 'fallback' };
}
