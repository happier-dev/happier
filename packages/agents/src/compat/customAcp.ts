import type { BuiltInAcpConfig, BuiltInAcpYesNoAuto } from '../acp.js';
import type { AgentLocalCliConfig, AgentCliLaunchCommand, AgentCliSupportKind } from '../localCli.js';
import type { AgentModelConfig } from '../models.js';
import type { AgentCliRuntimeSpec } from '../cli/runtime.js';
import type { AgentSessionModeDescriptor } from '../sessionModes.js';
import type { AgentCore, BundledAgentId } from '../types.js';
import { isBundledAgentId } from '../types.js';

export const LEGACY_CUSTOM_ACP_AGENT_ID = 'customAcp' as const;

export function isLegacyCustomAcpAgentId(value: unknown): value is typeof LEGACY_CUSTOM_ACP_AGENT_ID {
  return value === LEGACY_CUSTOM_ACP_AGENT_ID;
}

export const LEGACY_COMPAT_AGENT_IDS = [LEGACY_CUSTOM_ACP_AGENT_ID] as const;
export type LegacyCompatAgentId = (typeof LEGACY_COMPAT_AGENT_IDS)[number];
export type AgentCompatId = LegacyCompatAgentId;
export type AgentLookupId = BundledAgentId | AgentCompatId;

export function isAgentLookupId(value: unknown): value is AgentLookupId {
  return isBundledAgentId(value) || isLegacyCustomAcpAgentId(value);
}

export type LegacyCompatAgentCliRuntimeSpec = Readonly<
  Omit<AgentCliRuntimeSpec, 'id'> & {
    id: LegacyCompatAgentId;
  }
>;

export type LegacyCompatAgentLocalCliConfig = Readonly<
  Omit<AgentLocalCliConfig, 'agentId'> & {
    agentId: LegacyCompatAgentId;
  }
>;

export type LegacyCompatBuiltInAcpConfig = Readonly<
  Omit<BuiltInAcpConfig, 'agentId'> & {
    agentId: LegacyCompatAgentId;
  }
>;

export type LegacyCompatAgentCore = Readonly<
  Omit<AgentCore, 'id' | 'cliSubcommand'> & {
    id: LegacyCompatAgentId;
    cliSubcommand: LegacyCompatAgentId;
  }
>;

export const LEGACY_CUSTOM_ACP_FLAVOR_ALIASES = Object.freeze([
  LEGACY_CUSTOM_ACP_AGENT_ID.toLowerCase(),
  'custom-acp',
] as const);

const LEGACY_CUSTOM_ACP_SUPPORTS_MODES: BuiltInAcpYesNoAuto = 'auto';
const LEGACY_CUSTOM_ACP_SUPPORTS_MODELS: BuiltInAcpYesNoAuto = 'auto';
const LEGACY_CUSTOM_ACP_PROMPT_IMAGE_SUPPORT: BuiltInAcpYesNoAuto = 'auto';

export function resolveLegacyCustomAcpCompatAgentIdFromFlavor(
  flavor: string,
): typeof LEGACY_CUSTOM_ACP_AGENT_ID | null {
  const normalized = flavor.trim().toLowerCase();
  return LEGACY_CUSTOM_ACP_FLAVOR_ALIASES.includes(normalized as (typeof LEGACY_CUSTOM_ACP_FLAVOR_ALIASES)[number])
    ? LEGACY_CUSTOM_ACP_AGENT_ID
    : null;
}

function readLegacyConfiguredAcpBackendIdFromFlavor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized.startsWith('acp:')) {
    return null;
  }
  const backendId = normalized.slice('acp:'.length).trim();
  return backendId.length > 0 && backendId !== LEGACY_CUSTOM_ACP_AGENT_ID ? backendId : null;
}

export function readLegacyCustomAcpCompatBackendIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return readLegacyConfiguredAcpBackendIdFromFlavor((metadata as { flavor?: unknown }).flavor);
}

const LEGACY_CUSTOM_ACP_AGENT_CLI_RUNTIME_SPEC = Object.freeze({
  id: LEGACY_CUSTOM_ACP_AGENT_ID,
  title: 'Custom ACP',
  binaryName: 'custom-acp',
  knownUserBinDirSuffixes: null,
  sourcePreferenceDefault: 'system-first',
  managedInstall: null,
  manualInstallKind: 'none',
  manualInstallRecipes: null,
  acceptsJavaScriptFileOverride: false,
  docsUrl: null,
} satisfies LegacyCompatAgentCliRuntimeSpec);

const LEGACY_CUSTOM_ACP_AGENT_MODEL_CONFIG = Object.freeze({
  supportsSelection: true,
  supportsFreeform: true,
  nonAcpApplyScope: 'next_prompt',
  acpApplyBehavior: 'set_model',
  acpModelConfigOptionId: 'model',
  dynamicProbe: 'auto',
  defaultMode: 'default',
  allowedModes: ['default'],
} satisfies AgentModelConfig);

export function getLegacyCustomAcpAgentCliRuntimeSpec(): LegacyCompatAgentCliRuntimeSpec {
  return LEGACY_CUSTOM_ACP_AGENT_CLI_RUNTIME_SPEC;
}

export function getLegacyCustomAcpAgentModelConfig(): AgentModelConfig {
  return LEGACY_CUSTOM_ACP_AGENT_MODEL_CONFIG;
}

export const LEGACY_CUSTOM_ACP_SESSION_MODE_DESCRIPTOR = Object.freeze({
  source: 'acp',
  semantics: 'agent-modes',
  runtimeSwitch: 'acp-setSessionMode',
} satisfies AgentSessionModeDescriptor);

export function getLegacyCustomAcpSessionModeDescriptor(): AgentSessionModeDescriptor {
  return LEGACY_CUSTOM_ACP_SESSION_MODE_DESCRIPTOR;
}

export const LEGACY_CUSTOM_ACP_LOCAL_CLI_CONFIG_INPUT = Object.freeze({
  machineLoginKey: 'custom-acp',
  supportKind: 'unsupported',
  loginLaunch: null,
} satisfies Readonly<{
  machineLoginKey: string;
  supportKind: AgentCliSupportKind;
  loginLaunch: AgentCliLaunchCommand | null;
}>);

function createLegacyCustomAcpAgentLocalCliConfig(params: Readonly<{
  detectKey: string;
}>): LegacyCompatAgentLocalCliConfig {
  return {
    agentId: LEGACY_CUSTOM_ACP_AGENT_ID,
    detectKey: params.detectKey,
    machineLoginKey: LEGACY_CUSTOM_ACP_LOCAL_CLI_CONFIG_INPUT.machineLoginKey,
    supportKind: LEGACY_CUSTOM_ACP_LOCAL_CLI_CONFIG_INPUT.supportKind,
    loginLaunch: LEGACY_CUSTOM_ACP_LOCAL_CLI_CONFIG_INPUT.loginLaunch,
  };
}

export function getLegacyCustomAcpAgentLocalCliConfig(): LegacyCompatAgentLocalCliConfig {
  return createLegacyCustomAcpAgentLocalCliConfig({
    detectKey: getLegacyCustomAcpAgentCliRuntimeSpec().binaryName,
  });
}

export function createLegacyCustomAcpBuiltInAcpConfig(params: Readonly<{
  command: string;
}>): LegacyCompatBuiltInAcpConfig {
  return {
    agentId: LEGACY_CUSTOM_ACP_AGENT_ID,
    launcher: {
      command: params.command,
      args: [],
    },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: LEGACY_CUSTOM_ACP_SUPPORTS_MODES,
    supportsModels: LEGACY_CUSTOM_ACP_SUPPORTS_MODELS,
    promptImageSupport: LEGACY_CUSTOM_ACP_PROMPT_IMAGE_SUPPORT,
  };
}

function createLegacyCustomAcpAgentCore(params: Readonly<{
  detectKey: string;
}>): LegacyCompatAgentCore {
  return {
    id: LEGACY_CUSTOM_ACP_AGENT_ID,
    backendDefinition: false,
    cliSubcommand: LEGACY_CUSTOM_ACP_AGENT_ID,
    detectKey: params.detectKey,
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'unsupported' },
    sessionStorage: { direct: true, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    tools: { delivery: 'native_mcp', support: 'supported' },
  };
}

export function getLegacyCustomAcpAgentCore(): LegacyCompatAgentCore {
  return createLegacyCustomAcpAgentCore({
    detectKey: getLegacyCustomAcpAgentLocalCliConfig().detectKey,
  });
}
