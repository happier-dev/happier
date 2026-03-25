import type { AgentId } from '@happier-dev/agents';
import { getProviderSettingsDefinition } from '@happier-dev/agents';
import { normalizeCodexBackendMode, type CodexBackendMode } from '@happier-dev/protocol';

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

export function resolveProviderSpawnExtras(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
}>): Record<string, unknown> {
  const def = getProviderSettingsDefinition(params.agentId);
  if (!def?.resolveSpawnExtras) return {};

  try {
    const extras = def.resolveSpawnExtras({ agentId: params.agentId, settings: params.settings }) as unknown;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return {};
    return extras as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasExplicitCodexAcpEnvOverride(processEnv: NodeJS.ProcessEnv): boolean {
  const raw = processEnv.HAPPIER_EXPERIMENTAL_CODEX_ACP;
  return typeof raw === 'string' && raw.trim().length > 0;
}

function readExplicitCodexBackendModeFromEnv(processEnv: NodeJS.ProcessEnv): CodexBackendMode | null {
  return normalizeCodexBackendMode(processEnv.HAPPIER_CODEX_BACKEND_MODE);
}

export function resolveProviderSpawnExtrasForRuntime(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
}>): Record<string, unknown> {
  if (params.agentId === 'codex') {
    const explicitCodexBackendMode = readExplicitCodexBackendModeFromEnv(params.processEnv);
    if (explicitCodexBackendMode) {
      return { codexBackendMode: explicitCodexBackendMode };
    }
  }

  const extras = resolveProviderSpawnExtras({
    agentId: params.agentId,
    settings: params.settings,
  });

  if (params.agentId === 'codex' && hasExplicitCodexAcpEnvOverride(params.processEnv)) {
    const { experimentalCodexAcp: _ignored, codexBackendMode: _ignoredBackendMode, ...rest } = extras;
    return rest;
  }

  if (params.agentId === 'codex') {
    const normalized = normalizeCodexBackendMode(extras.codexBackendMode);
    if (normalized) return { codexBackendMode: normalized };
  }

  return extras;
}
