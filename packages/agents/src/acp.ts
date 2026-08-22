import { AGENT_IDS, type AgentId, type BundledAgentId } from './types.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './generated/bundledAgentDefinitions.js';

export type BuiltInAcpTransportProfile = 'generic' | 'kiro';
export type BuiltInAcpYesNoAuto = 'yes' | 'no' | 'auto';

export type BuiltInAcpConfig = Readonly<{
  agentId: BundledAgentId;
  launcher: Readonly<{
    command: string;
    args: ReadonlyArray<string>;
  }>;
  transportProfile: BuiltInAcpTransportProfile;
  supportsLoadSession: boolean;
  supportsModes: BuiltInAcpYesNoAuto;
  supportsModels: BuiltInAcpYesNoAuto;
  promptImageSupport: BuiltInAcpYesNoAuto;
}>;

export const BUILT_IN_ACP_CONFIG: Readonly<Partial<Record<AgentId, BuiltInAcpConfig>>> = Object.freeze(
  Object.fromEntries(
    AGENT_IDS.flatMap((agentId): ReadonlyArray<readonly [AgentId, BuiltInAcpConfig]> => {
      const config = BUNDLED_AGENT_DEFINITIONS_BY_ID[agentId]?.builtInAcpConfig;
      return config ? [[agentId, config]] : [];
    }),
  ) as Partial<Record<AgentId, BuiltInAcpConfig>>,
);

export function hasBuiltInAcpConfig(agentId: AgentId): boolean {
  return BUILT_IN_ACP_CONFIG[agentId] != null;
}

export function getBuiltInAcpConfig(agentId: AgentId): BuiltInAcpConfig | null {
  return BUILT_IN_ACP_CONFIG[agentId] ?? null;
}
