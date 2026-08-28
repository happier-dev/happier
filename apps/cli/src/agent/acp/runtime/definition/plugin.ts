import { PluginAgentRuntimeAcpV2Schema } from '@happier-dev/protocol';
import type {
  PluginAgentAcpDefinitionV2,
  PluginAgentAcpTransport,
} from '@happier-dev/protocol';

const NEUTRAL_ACP_MCP_POLICY = Object.freeze({
  policy: 'drop' as const,
});

export type NormalizedPluginDeclarativeAcpRuntime = Readonly<{
  transport: PluginAgentAcpTransport;
  definition?: Readonly<
    Omit<PluginAgentAcpDefinitionV2, 'mcp'>
    & { mcp: NonNullable<PluginAgentAcpDefinitionV2['mcp']> }
  >;
}>;

/**
 * Normalizes the one strict Protocol declaration into the existing public ACP
 * composer options. Omitted MCP policy deliberately keeps the composer's
 * neutral no-delivery behavior.
 */
export function normalizePluginDeclarativeAcpRuntime(
  runtime: unknown,
): NormalizedPluginDeclarativeAcpRuntime {
  const parsed = PluginAgentRuntimeAcpV2Schema.parse(runtime);
  const definition = parsed.definition
    ? Object.freeze({
      ...(parsed.definition.modelConfigOptionId
        ? { modelConfigOptionId: parsed.definition.modelConfigOptionId }
        : {}),
      ...(parsed.definition.stderrRules
        ? { stderrRules: parsed.definition.stderrRules }
        : {}),
      mcp: parsed.definition.mcp ?? NEUTRAL_ACP_MCP_POLICY,
    }) satisfies NonNullable<NormalizedPluginDeclarativeAcpRuntime['definition']>
    : undefined;

  return Object.freeze({
    transport: parsed.transport,
    ...(definition ? { definition } : {}),
  });
}
