import type { AgentId, PermissionMode } from './types.js';
import { AGENTS_CORE } from './manifest.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';

export type BuiltInAcpTransportProfile = 'generic' | 'kiro';
export type BuiltInAcpYesNoAuto = 'yes' | 'no' | 'auto';

export type BuiltInAcpConfig = Readonly<{
  agentId: AgentId;
  launcher: Readonly<{
    command: string;
    args: ReadonlyArray<string>;
  }>;
  transportProfile: BuiltInAcpTransportProfile;
  supportsLoadSession: boolean;
  supportsModes: BuiltInAcpYesNoAuto;
  supportsModels: BuiltInAcpYesNoAuto;
  promptImageSupport: BuiltInAcpYesNoAuto;
  /** Whether Happier's MCP server list is passed to the ACP session/new request. */
  mcpServers?: 'pass' | 'drop';
  /** Provider ACP mode selected for each explicit Happier permission intent. Null means no override. */
  permissionModeMapping?: Readonly<Partial<Record<PermissionMode, string | null>>>;
}>;

function providerLauncherCommand(agentId: AgentId): string {
  return getProviderCliRuntimeSpec(agentId).binaryName;
}

export const BUILT_IN_ACP_CONFIG: Readonly<Partial<Record<AgentId, BuiltInAcpConfig>>> = Object.freeze({
  customAcp: {
    agentId: 'customAcp',
    launcher: {
      command: providerLauncherCommand('customAcp'),
      args: [],
    },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'auto',
    supportsModels: 'auto',
    promptImageSupport: 'auto',
  },
  kiro: {
    agentId: 'kiro',
    launcher: {
      command: providerLauncherCommand('kiro'),
      args: ['acp'],
    },
    transportProfile: 'kiro',
    supportsLoadSession: true,
    supportsModes: 'yes',
    supportsModels: 'yes',
    promptImageSupport: 'yes',
  },
  devin: {
    agentId: 'devin',
    launcher: {
      command: providerLauncherCommand('devin'),
      args: ['acp'],
    },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'yes',
    supportsModels: 'yes',
    promptImageSupport: 'yes',
    // Devin 3000.10.31 ignores standard ACP MCP descriptors; the CLI adapter materializes its native config instead.
    mcpServers: 'drop',
    permissionModeMapping: {
      // Preserve the user's configured Devin permission mode unless Happier explicitly overrides it.
      default: null,
      'read-only': 'normal',
      'safe-yolo': 'accept-edits',
      yolo: 'dangerous',
      // Devin has no read-only planning mode; do not send an invalid ACP mode id.
      plan: null,
    },
  },
  agy: {
    agentId: 'agy',
    // The interactive CLI remains `agy`; the CLI catalog replaces this launch
    // command with the ensured managed registry artifact for ACP sessions.
    launcher: { command: providerLauncherCommand('agy'), args: [] },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'auto',
    supportsModels: 'auto',
    promptImageSupport: 'auto',
    mcpServers: 'pass',
  },
  fx: {
    agentId: 'fx',
    launcher: { command: providerLauncherCommand('fx'), args: ['acp'] },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'yes',
    supportsModels: 'yes',
    promptImageSupport: 'yes',
    mcpServers: 'pass',
    permissionModeMapping: {
      default: null,
      'read-only': 'ask',
      'safe-yolo': 'code',
    },
  },
  droid: {
    agentId: 'droid',
    launcher: { command: providerLauncherCommand('droid'), args: ['exec', '--output-format', 'acp'] },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'yes',
    supportsModels: 'yes',
    promptImageSupport: 'auto',
    mcpServers: 'pass',
  },
  kimi: {
    agentId: 'kimi',
    launcher: { command: providerLauncherCommand('kimi'), args: ['acp'] },
    transportProfile: 'generic',
    supportsLoadSession: true,
    // Do not expose automatic approval modes until authenticated live behavior is verified.
    supportsModes: 'no',
    supportsModels: 'yes',
    promptImageSupport: 'yes',
    mcpServers: 'pass',
  },
  codebuddy: {
    agentId: 'codebuddy',
    launcher: { command: providerLauncherCommand('codebuddy'), args: ['--acp'] },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'yes',
    supportsModels: 'yes',
    promptImageSupport: 'yes',
    mcpServers: 'pass',
    // Mode ids accepted by CodeBuddy Code 2.162.0 `session/set_mode`.
    permissionModeMapping: {
      default: null,
      // `dontAsk` runs safe read-only actions and denies everything that would prompt; the
      // generic ACP permission handler relays prompts and does not deny writes on its own.
      'read-only': 'dontAsk',
      'safe-yolo': 'auto',
      yolo: 'bypassPermissions',
      plan: 'plan',
    },
  },
});

export function hasBuiltInAcpConfig(agentId: AgentId): boolean {
  return BUILT_IN_ACP_CONFIG[agentId] != null;
}

export function getBuiltInAcpConfig(agentId: AgentId): BuiltInAcpConfig | null {
  return BUILT_IN_ACP_CONFIG[agentId] ?? null;
}

/**
 * Static policy for offering ACP `session/list` as a resume source. The manifest is the single leaf
 * declaration for both generic and provider-owned ACP backends; it permits offering the surface and
 * never certifies it. The live ACP handshake stays the runtime authority and must fail clearly before
 * `session/list` when it disagrees.
 */
export function isAcpSessionListingDeclared(agentId: AgentId): boolean {
  const capabilities = AGENTS_CORE[agentId].sessionCapabilities;
  return capabilities?.sessionListing === 'supported'
    && 'sessionListingSource' in capabilities
    && capabilities.sessionListingSource === 'acp';
}

/** @deprecated Use `isAcpSessionListingDeclared`; retained for package compatibility. */
export function isBuiltInAcpSessionListingDeclared(agentId: AgentId): boolean {
  return isAcpSessionListingDeclared(agentId);
}
