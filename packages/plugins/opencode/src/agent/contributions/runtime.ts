import {
  buildOpenCodeAttachHealthUrl,
  createOpenCodeAttachArgs,
  resolveOpenCodeAttachTarget,
} from '../surfaces/sessions/attach/descriptor.js';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from '../preflight/models.js';
import {
  detectOpenCodeCliAuthStatus,
  resolveOpenCodeCliAuthProbeTimeoutMs,
} from '../cli/auth.js';
import {
  createOpenCodeAuthMaterializationInput,
  OPEN_CODE_SUPPORTED_AUTH_SERVICE_IDS,
  readOpenCodeConnectedServiceId,
} from '../auth/services/selection.js';
import { materializeOpenCodeAuthEnvironment } from '../auth/services/materialize.js';
import { resolveOpenCodeResumeReachabilityUnsupported } from '../auth/services/resumeReachability.js';
import { OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR } from '../auth/services/stateSharing.js';
import {
  OPENCODE_RESTART_REMATERIALIZE_REQUIRED_REASON,
  shouldOpenCodeRestartForServiceSwitch,
} from '../auth/services/switchContinuity.js';
import {
  classifyOpenCodeUsageLimitError,
  OPEN_CODE_USAGE_LIMIT_RECOVERY,
} from '../auth/services/usageLimit.js';
import { resolveOpenCodeSessionRuntimePreferences } from '../preferences/session.js';
import { extractOpenCodeSessionHandoffAgentBundleRecords } from '../surfaces/sessions/handoff/exportRecords.js';
import {
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS,
} from '../auth/services/requestAuth/purposes.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../systemTool.js';

const OPENCODE_CONNECTED_SERVICE_STATE_SHARING_DESCRIPTOR = Object.freeze({
  providerId: OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR.providerId,
  providerSupportStatus: OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR.providerSupportStatus.supportLevel,
  config: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    unavailableReason: 'not_implemented',
  },
  state: {
    supported: false,
    modes: ['isolated'],
    entries: [],
    symlinkUnavailableDegradePolicy: 'block_continuity',
    unavailableReason: 'not_implemented',
  },
  authIsolation: {
    mode: OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR.authIsolation.mode,
    secretEntries: [...OPEN_CODE_AUTH_SERVICE_SHARING_DESCRIPTOR.authIsolation.secretEntries],
  },
} as const);

export const OPENCODE_AGENT_RUNTIME_CONTRIBUTION = Object.freeze({
  agentId: 'opencode',
  builtInAcpCatalog: true,
  agentCliSystemTool: {
    toolId: OPEN_CODE_SYSTEM_TOOL_ID,
  },
  cliSessionCommand: {
    backendIdForSessionRuntime: 'opencode',
    agentIdForAccountSettings: 'opencode',
    providerInfoCommandPrefixes: [['providers', 'list']],
  },
  cliAuth: {
    detectAuthStatus: async (params: Readonly<{
      env: Readonly<Record<string, string | undefined>>;
      runCommand: (
        args: readonly string[],
        options?: Readonly<{ timeoutMs?: number }>,
      ) => Promise<Readonly<{ ok: boolean; stdout: string }>>;
    }>) => detectOpenCodeCliAuthStatus({
      runAuthList: async () => params.runCommand(['auth', 'list'], {
        timeoutMs: resolveOpenCodeCliAuthProbeTimeoutMs(params.env),
      }),
      readOauthRefreshToken: () => null,
      probeOauthRefreshToken: async () => 'unknown',
    }),
  },
  sessionRuntimePreferences: {
    resolve: resolveOpenCodeSessionRuntimePreferences,
  },
  sessionHandoff: {
    agentBundleRecords: {
      extract: extractOpenCodeSessionHandoffAgentBundleRecords,
    },
  },
  attach: {
    resolveTarget: resolveOpenCodeAttachTarget,
    createArgs: createOpenCodeAttachArgs,
    buildHealthUrl: buildOpenCodeAttachHealthUrl,
  },
  connectedServices: {
    serviceIds: OPEN_CODE_SUPPORTED_AUTH_SERVICE_IDS,
    requestAuthUses: Object.freeze([Object.freeze({
      purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS.anthropic,
        headerNames: Object.freeze(['authorization']),
      }),
    }), Object.freeze({
      purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS.openai,
        headerNames: Object.freeze(['authorization', 'chatgpt-account-id']),
      }),
    })]),
    readConnectedServiceId: readOpenCodeConnectedServiceId,
    createAuthMaterializationInput: createOpenCodeAuthMaterializationInput,
    materializeAuthEnvironment: materializeOpenCodeAuthEnvironment,
    stateSharingDescriptor: OPENCODE_CONNECTED_SERVICE_STATE_SHARING_DESCRIPTOR,
    shouldRestartForServiceSwitch: shouldOpenCodeRestartForServiceSwitch,
    restartRematerializeRequiredReason: OPENCODE_RESTART_REMATERIALIZE_REQUIRED_REASON,
    resolveResumeReachabilityUnsupported: resolveOpenCodeResumeReachabilityUnsupported,
    classifyUsageLimitError: classifyOpenCodeUsageLimitError,
    runtimeAuthAdapter: false,
    recoveryCapabilities: {
      predictiveSoftSwitch: { mode: 'unsupported' },
      generationApplicationScope: 'request_time_auth',
    },
    usageLimitRecovery: OPEN_CODE_USAGE_LIMIT_RECOVERY,
  },
  preflightSessionControls: OPENCODE_PREFLIGHT_SESSION_CONTROLS,
} as const);
