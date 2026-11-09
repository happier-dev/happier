import { readAccountSettingValueForBackendTarget } from '@happier-dev/protocol/account/settings/accountSettings';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AGENT_IDS, getAgentSessionModeDescriptor, normalizePermissionModeForSessionDescriptor, parsePermissionIntentAlias, type AgentId, type AgentSessionModeDescriptor, type PermissionMode } from '@happier-dev/agents';

export type PermissionModeSeedSource = 'explicit' | 'inferred' | 'account_default' | 'fallback';

export type PermissionModeSeed = Readonly<{
  mode: PermissionMode;
  source: PermissionModeSeedSource;
}>;

function isBuiltInAgentId(agentId: string): agentId is AgentId {
  return (AGENT_IDS as readonly string[]).includes(agentId);
}

export function normalizePermissionModeForAgentStart(opts: { agentId: string; value: unknown; sessionModeDescriptor?: AgentSessionModeDescriptor | null }): PermissionMode | null {
  const normalized = parsePermissionIntentAlias(opts.value);
  if (!normalized) return null;
  return normalizePermissionModeForSessionDescriptor({
    mode: normalized,
    descriptor: opts.sessionModeDescriptor === undefined ? getAgentSessionModeDescriptor(opts.agentId) : opts.sessionModeDescriptor,
  });
}

export function resolveAccountDefaultPermissionModeFromAccountSettings(opts: {
  agentId: string;
  sessionModeDescriptor?: AgentSessionModeDescriptor | null;
  backendTarget?: BackendTargetRefV2Input;
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
  return normalizePermissionModeForAgentStart({ ...opts, value: candidate });
}

export function resolvePermissionModeSeedForAgentStart(opts: {
  agentId: string;
  sessionModeDescriptor?: AgentSessionModeDescriptor | null;
  backendTarget?: BackendTargetRefV2Input;
  explicitPermissionMode: unknown;
  inferredPermissionMode?: unknown;
  accountSettings: unknown;
}): PermissionModeSeed {
  const explicit = normalizePermissionModeForAgentStart({ ...opts, value: opts.explicitPermissionMode });
  if (explicit) return { mode: explicit, source: 'explicit' };

  const inferred = normalizePermissionModeForAgentStart({ ...opts, value: opts.inferredPermissionMode });
  if (inferred) return { mode: inferred, source: 'inferred' };

  const accountDefault = resolveAccountDefaultPermissionModeFromAccountSettings({
    agentId: opts.agentId,
    sessionModeDescriptor: opts.sessionModeDescriptor,
    backendTarget: opts.backendTarget,
    accountSettings: opts.accountSettings,
  });
  if (accountDefault) return { mode: accountDefault, source: 'account_default' };

  return { mode: 'default', source: 'fallback' };
}
