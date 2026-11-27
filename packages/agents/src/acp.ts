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
  /** Advertise ACP form elicitation (`elicitation/create`) and answer it as structured questions. */
  formElicitation?: boolean;
  /** A mode id, or ordered candidates resolved against advertised modes. Null means no override. */
  permissionModeMapping?: Readonly<Partial<Record<PermissionMode, string | readonly string[] | null>>>;
  /**
   * Native modes that change what kind of turn runs (for example `plan`), declared when every other
   * advertised mode is an approval level owned by `permissionModeMapping`. Mode then offers Build
   * (the mapped permission mode) plus these; without it, Mode lists every advertised mode.
   */
  agentModeIds?: readonly string[];
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
    // The CLI provider adds the profile (`--gemini-dir`) and, for connected accounts, file token storage.
    launcher: { command: providerLauncherCommand('agy'), args: ['acp'] },
    transportProfile: 'generic',
    supportsLoadSession: true,
    supportsModes: 'auto',
    supportsModels: 'auto',
    promptImageSupport: 'auto',
    mcpServers: 'pass',
    // agy 1.5.18 `ask_question` sends form elicitations; without the capability it prints the options as text.
    formElicitation: true,
    // agy 1.5.18 always advertises default, accept-edits and plan; auto only on eligible accounts.
    // It has no read-only or bypass mode: read-only keeps its asking mode, and yolo takes the most
    // permissive advertised mode while the provider-enforced handler approves the remaining prompts.
    permissionModeMapping: {
      default: null,
      'read-only': 'default',
      'safe-yolo': ['auto', 'accept-edits'],
      yolo: ['auto', 'accept-edits'],
      plan: 'plan',
    },
    // Its default/accept-edits/auto modes are approval levels; Plan is the one agent mode.
    agentModeIds: ['plan'],
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
      // FX 0.0.14 renamed 0.0.13's automatic-review mode from code to auto.
      'safe-yolo': ['auto', 'code'],
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

/** Resolve a preset's native id without inventing an unadvertised candidate. */
export function resolveAcpPermissionModeId(
  mapping: string | ReadonlyArray<string> | null | undefined,
  availableModes: ReadonlyArray<Readonly<{ id: string }>>,
): string | null {
  if (typeof mapping === 'string') return mapping;
  return mapping?.find((id) => availableModes.some((mode) => mode.id === id)) ?? null;
}

/**
 * Happier's agent mode for a catalog ACP agent. An agent that declares `agentModeIds` keeps only
 * those native ids as agent modes; any other id (a persisted approval-level override from older
 * builds, or a clear) is Build, the mode the permission mapping chooses. Agents without the
 * declaration keep raw native ids, which Mode offers alongside the permission mapping.
 */
export function resolveAcpAgentModeId(agentId: AgentId, modeId: string | null | undefined): string | null {
  const id = typeof modeId === 'string' ? modeId.trim() : '';
  if (!id) return null;
  const agentModeIds = BUILT_IN_ACP_CONFIG[agentId]?.agentModeIds;
  return !agentModeIds || agentModeIds.includes(id) ? id : null;
}

export type AcpSessionModeResolution =
  | Readonly<{ kind: 'mode'; modeId: string }>
  /** Leave the provider's own policy in place; a null mapping is not a native reset token. */
  | Readonly<{ kind: 'provider-policy' }>
  /** The permission mapping names candidates the session does not advertise. */
  | Readonly<{ kind: 'unavailable' }>;

/** The one rule deriving a catalog ACP agent's native mode from its agent mode and permission mode. */
export function resolveAcpSessionMode(params: Readonly<{
  agentId: AgentId;
  agentModeId: string | null | undefined;
  permissionMode: PermissionMode;
  availableModes: ReadonlyArray<Readonly<{ id: string }>>;
}>): AcpSessionModeResolution {
  const agentModeId = resolveAcpAgentModeId(params.agentId, params.agentModeId);
  if (agentModeId) return { kind: 'mode', modeId: agentModeId };
  const mapping = BUILT_IN_ACP_CONFIG[params.agentId]?.permissionModeMapping?.[params.permissionMode] ?? null;
  if (mapping === null) return { kind: 'provider-policy' };
  const modeId = resolveAcpPermissionModeId(mapping, params.availableModes);
  return modeId ? { kind: 'mode', modeId } : { kind: 'unavailable' };
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
