import type { PermissionMode } from '@/api/types';
import {
  getAgentSessionModesKind,
  type AgentId,
} from '@happier-dev/agents';

import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';

export type ParsedSessionStartArgs = {
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
  sessionModeId: string | undefined;
  sessionModeUpdatedAt: number | undefined;
  modelId: string | undefined;
  modelUpdatedAt: number | undefined;
};

export function parseSessionStartArgs(args: string[]): ParsedSessionStartArgs {
  const firstArg = args[0];
  const parsed = partitionProviderSessionArgs({
    args,
    providerSubcommand: typeof firstArg === 'string' && !firstArg.startsWith('-') ? firstArg : null,
  });

  return {
    startedBy: parsed.startedBy,
    permissionMode: parsed.permissionMode,
    permissionModeUpdatedAt: parsed.permissionModeUpdatedAt,
    sessionModeId: parsed.sessionModeId,
    sessionModeUpdatedAt: parsed.sessionModeUpdatedAt,
    modelId: parsed.modelId,
    modelUpdatedAt: parsed.modelUpdatedAt,
  };
}

export function readOptionalFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

export function readOptionalFlagValueFromAliases(args: string[], flags: readonly string[]): string | undefined {
  let resolved: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!flags.includes(arg)) continue;
    const value = args[i + 1];
    if (!value || value.startsWith('-')) continue;
    resolved = value;
  }
  return resolved;
}

export function applyDeprecatedSessionStartAliasesForAgent(params: {
  agentId: AgentId;
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
  sessionModeId: string | undefined;
  sessionModeUpdatedAt: number | undefined;
  modelId: string | undefined;
  modelUpdatedAt: number | undefined;
}): {
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
  sessionModeId: string | undefined;
  sessionModeUpdatedAt: number | undefined;
  modelId: string | undefined;
  modelUpdatedAt: number | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];

  let permissionMode = params.permissionMode;
  let permissionModeUpdatedAt = params.permissionModeUpdatedAt;
  let sessionModeId = params.sessionModeId;
  let sessionModeUpdatedAt = params.sessionModeUpdatedAt;
  const modelId = params.modelId;
  const modelUpdatedAt = params.modelUpdatedAt;

  // Back-compat: historically "plan" was treated as a permission mode in some CLIs.
  // For agents where "plan" is an agent/session mode (e.g. OpenCode plan/build, Claude plan/build), map it to --agent-mode.
  const sessionModesKind = getAgentSessionModesKind(params.agentId);
  const supportsAgentModeAlias = sessionModesKind === 'acpAgentModes' || sessionModesKind === 'staticAgentModes';
  if (supportsAgentModeAlias && !sessionModeId && permissionMode === 'plan') {
    warnings.push(`Deprecated: use --agent-mode plan instead of --permission-mode plan for ${params.agentId}.`);
    sessionModeId = 'plan';
    sessionModeUpdatedAt = sessionModeUpdatedAt ?? permissionModeUpdatedAt;
    // "plan" is no longer a permission intent. Treat it as read-only for safety.
    permissionMode = 'read-only';
    // permissionModeUpdatedAt is preserved: it still serves as a monotonic seed for arbitration.
  }

  return {
    startedBy: params.startedBy,
    permissionMode,
    permissionModeUpdatedAt,
    sessionModeId,
    sessionModeUpdatedAt,
    modelId,
    modelUpdatedAt,
    warnings,
  };
}
