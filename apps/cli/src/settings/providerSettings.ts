import type { AgentId } from '@happier-dev/agents';
import { getProviderSettingsDefinition } from '@happier-dev/agents';

function hasTruthyEnv(name: string): boolean {
  const raw = typeof process.env[name] === 'string' ? process.env[name] : '';
  return Boolean(raw && raw.trim().length > 0);
}

export function resolveProviderOutgoingMessageMetaExtras(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
  session: unknown;
}>): Record<string, unknown> {
  const def = getProviderSettingsDefinition(params.agentId);
  if (!def?.buildOutgoingMessageMetaExtras) return {};
  try {
    const extras = def.buildOutgoingMessageMetaExtras({
      agentId: params.agentId,
      settings: params.settings,
      session: params.session,
    }) as unknown;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return {};
    return extras as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function applyProviderSpawnExtrasToProcessEnv(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
}>): void {
  const def = getProviderSettingsDefinition(params.agentId);
  if (!def?.resolveSpawnExtras) return;

  let extras: Record<string, unknown>;
  try {
    extras = def.resolveSpawnExtras({ agentId: params.agentId, settings: params.settings }) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return;

  // Current mapping: Codex backend routing flags.
  // Precedence: explicit env overrides always win, so we only set when env is unset.
  if (extras.experimentalCodexAcp === true) {
    if (!hasTruthyEnv('HAPPIER_EXPERIMENTAL_CODEX_ACP')) process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';
  }
  if (extras.experimentalCodexResume === true) {
    if (!hasTruthyEnv('HAPPIER_EXPERIMENTAL_CODEX_RESUME')) process.env.HAPPIER_EXPERIMENTAL_CODEX_RESUME = '1';
  }
}
