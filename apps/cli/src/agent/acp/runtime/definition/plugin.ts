import { PluginAgentRuntimeAcpV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import type { PluginAgentAcpTransport } from '@happier-dev/protocol';
import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildAcpModelSuffixOptionControls } from './modelSuffixOption';

const NEUTRAL_ACP_MCP_POLICY = Object.freeze({
  policy: 'drop' as const,
});

export type NormalizedPluginDeclarativeAcpRuntime = Readonly<{
  transport: PluginAgentAcpTransport;
  definition?: AgentAcpRuntimeDefinition;
}>;

/**
 * Normalizes the one strict Protocol declaration into the existing public ACP
 * composer options. Omitted MCP policy deliberately keeps the composer's
 * neutral no-delivery behavior.
 *
 * Declared model projection is compiled here, at the one owner both the
 * in-daemon registry and the out-of-process Session runner call, so a
 * host-declarative Agent behaves identically on both paths without loading
 * plugin code.
 */
export function normalizePluginDeclarativeAcpRuntime(
  runtime: unknown,
): NormalizedPluginDeclarativeAcpRuntime {
  const parsed = PluginAgentRuntimeAcpV2Schema.parse(runtime);
  const definition = parsed.definition
    ? Object.freeze({
      ...(parsed.definition.auth
        ? { auth: parsed.definition.auth }
        : {}),
      ...(parsed.definition.modelConfigOptionId
        ? { modelConfigOptionId: parsed.definition.modelConfigOptionId }
        : {}),
      ...(parsed.definition.stderrRules
        ? { stderrRules: parsed.definition.stderrRules }
        : {}),
      ...(parsed.definition.permissionModeMapping
        ? { permissionModeMapping: parsed.definition.permissionModeMapping }
        : {}),
      ...(parsed.definition.permissionModeArgv
        ? { permissionModeArgv: parsed.definition.permissionModeArgv }
        : {}),
      ...(parsed.definition.models
        ? {
          models: buildAcpModelSuffixOptionControls(
            parsed.definition.models.suffixOption,
          ),
        }
        : {}),
      mcp: parsed.definition.mcp ?? NEUTRAL_ACP_MCP_POLICY,
    }) satisfies AgentAcpRuntimeDefinition
    : undefined;

  return Object.freeze({
    transport: parsed.transport,
    ...(definition ? { definition } : {}),
  });
}
