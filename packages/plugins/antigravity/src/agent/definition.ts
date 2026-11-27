import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_BINARY_NAME,
} from './install/cliRuntime.js';
import { antigravityConnectedAccountLaunch } from './connectedServices/continuity.js';

export const AGENT_STATE_SHARING_DESCRIPTOR = antigravityConnectedAccountLaunch.stateSharingDescriptor;

// Models are negotiated by native `agy acp` when the Session opens; there is
// no static fallback catalog.
export const AGENT_DEFINITION = Object.freeze({
  id: ANTIGRAVITY_AGENT_ID,
  acpRegistryIds: ['antigravity-acp'] as const,
  core: {
    id: ANTIGRAVITY_AGENT_ID,
    backendDefinition: false,
    cliSubcommand: ANTIGRAVITY_AGENT_ID,
    detectKey: ANTIGRAVITY_BINARY_NAME,
    flavorAliases: [ANTIGRAVITY_BINARY_NAME],
    cloudConnect: null,
    connectedServices: null,
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'antigravitySessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
      usageLimitRecovery: { checkNow: 'supported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: {
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'terminal_host',
    },
    // Keep Happier-provided MCP tools experimental until an authenticated
    // Antigravity Session exercises them end to end.
    tools: { delivery: 'native_mcp', support: 'experimental' },
  },
  settingsBackendId: ANTIGRAVITY_BACKEND_ID,
  ownedBackendIds: [ANTIGRAVITY_BACKEND_ID],
  // Released accounts persisted the Agents enable/disable toggle under the
  // concrete backend ids Antigravity used to own. The declarative ACP runtime
  // replaced those runtimes, but their persisted state must keep projecting
  // through the one compatibility reader instead of silently re-enabling a
  // disabled Agent. These ids name settings keys only; no runtime is restored.
  enablementCompatibilityBackendIds: ['antigravity-localharness', 'antigravity-terminal'],
  // Its default/accept-edits/auto modes are approval levels owned by permissions; Plan is the one agent mode.
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode', agentModeIds: ['plan'] },
  sessionModesKind: 'acpAgentModes',
} as const);
