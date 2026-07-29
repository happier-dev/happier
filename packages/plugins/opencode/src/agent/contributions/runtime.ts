import {
  buildOpenCodeAttachHealthUrl,
  createOpenCodeAttachArgs,
  resolveOpenCodeAttachTarget,
} from '../surfaces/sessions/attach/descriptor.js';
import {
  isOpenCodeManagedServerCommand,
  OPENCODE_MANAGED_SERVER_STATE_PATH_ENV_KEY,
  resolveOpenCodeManagedServerStateFingerprintInput,
} from '../runtime/server/managedServerState.js';
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
import { readOpenCodeSessionMetadataRuntimeDescriptor } from '../identity/runtimeDescriptor.js';
import { resolveOpenCodeSessionRuntimePreferences } from '../preferences/session.js';
import { OPENCODE_SESSION_CONTROL_ADAPTER } from '../surfaces/sessions/controls/adapter.js';
import { extractOpenCodeSessionHandoffAgentBundleRecords } from '../surfaces/sessions/handoff/exportRecords.js';
import { createOpenCodeHandoffSurfaceForExec } from '../surfaces/sessions/handoff/descriptor.js';
import { resolveOpenCodeReplayChildLaunch } from '../surfaces/sessions/fork/descriptor.js';
import {
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
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
  sessionControlAdapter: OPENCODE_SESSION_CONTROL_ADAPTER,
  runtimeDescriptorReader: readOpenCodeSessionMetadataRuntimeDescriptor,
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
    surface: ({ exec }: Readonly<{ exec: Parameters<
      typeof createOpenCodeHandoffSurfaceForExec
    >[0] }>) => createOpenCodeHandoffSurfaceForExec(exec),
    agentBundleRecords: {
      extract: extractOpenCodeSessionHandoffAgentBundleRecords,
    },
    resolveReplayChildLaunch: async ({ parentMetadata }: Readonly<{
      parentMetadata: Readonly<Record<string, unknown>>;
    }>) => await resolveOpenCodeReplayChildLaunch({ parentMetadata }),
  },
  managedServer: {
    namespace: 'opencode',
    statePathEnvKey: OPENCODE_MANAGED_SERVER_STATE_PATH_ENV_KEY,
    resolveStateFingerprintInput: resolveOpenCodeManagedServerStateFingerprintInput,
    isExpectedProcessCommand: isOpenCodeManagedServerCommand,
    buildHealthUrl: buildOpenCodeAttachHealthUrl,
    logLabel: 'OpenCode',
    timeouts: {
      authSwitchDrainMsEnvKey: 'HAPPIER_OPENCODE_MANAGED_SERVER_AUTH_SWITCH_DRAIN_TIMEOUT_MS',
      authSwitchDrainMsDefault: 9_000,
      healthProbeMsEnvKey: 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_HEALTH_TIMEOUT_MS',
      healthProbeMsDefault: 750,
      shutdownGraceMsEnvKey: 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_GRACE_TIMEOUT_MS',
      shutdownGraceMsDefault: 5_000,
      forceKillWaitMsEnvKey: 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_FORCE_WAIT_TIMEOUT_MS',
      forceKillWaitMsDefault: 500,
      pollIntervalMsEnvKey: 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_POLL_INTERVAL_MS',
      pollIntervalMsDefault: 50,
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
        origin: 'https://api.anthropic.com',
        headerNames: Object.freeze(['authorization']),
      }),
    }), Object.freeze({
      purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
      materialization: Object.freeze({
        kind: 'httpHeaders' as const,
        origin: 'https://chatgpt.com',
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

export {
  OPENCODE_SESSION_CONTROL_ADAPTER,
  readOpenCodeSessionMetadataRuntimeDescriptor,
};
