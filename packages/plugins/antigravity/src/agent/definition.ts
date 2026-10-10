import {
  ANTIGRAVITY_AGENT_ID,
  ANTIGRAVITY_BACKEND_ID,
  ANTIGRAVITY_BINARY_NAME,
} from './install/cliRuntime.js';
import { antigravityConnectedAccountLaunch } from './connectedServices/continuity.js';

export const AGENT_STATE_SHARING_DESCRIPTOR = antigravityConnectedAccountLaunch.stateSharingDescriptor;

// The ACP agent declaration carries no static model fallback: Happier ACP
// sessions run the managed `agy_acp_server`, whose models are negotiated on the
// live ACP session. Interactive `agy` CLI model output is a separate identity
// and is never borrowed as a default here.
export const AGENT_DEFINITION = Object.freeze({
  id: ANTIGRAVITY_AGENT_ID,
  core: {
    id: ANTIGRAVITY_AGENT_ID,
    backendDefinition: false,
    cliSubcommand: ANTIGRAVITY_AGENT_ID,
    detectKey: ANTIGRAVITY_BINARY_NAME,
    flavorAliases: [ANTIGRAVITY_BINARY_NAME],
    cloudConnect: null,
    connectedServices: {
      supportedServiceIds: ['gemini'],
    },
    resume: { vendorResume: 'supported' as const, vendorResumeIdField: 'antigravitySessionId' },
    sessionStorage: { direct: false, persisted: true },
    sessionCapabilities: {
      sessionListing: 'unsupported',
      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },
      sessionRollback: { conversation: 'unsupported' },
    },
    handoff: { vendorStateTransfer: 'unsupported' },
    localControl: {
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'terminal_host',
    },
    // The declarative ACP runtime passes Happier's session MCP descriptors to
    // `agy_acp_server`. Keep support experimental until an authenticated live
    // Antigravity session has exercised a Happier-provided MCP tool end to end.
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
  sessionModeDescriptor: { source: 'acp', semantics: 'agent-modes', runtimeSwitch: 'acp-setSessionMode' },
  sessionModesKind: 'acpAgentModes',
} as const);
