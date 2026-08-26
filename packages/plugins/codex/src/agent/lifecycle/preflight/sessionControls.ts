import type { AgentPassiveRealtimeSetupResultV1 } from '@happier-dev/plugin-sdk/agents';
import type {
  AgentPreflightSessionControlsContributionV1,
  AgentPreflightSessionControlsProbeContextV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { classifyCodexConnectedServiceAuthFailure } from '../../auth/services/runtime/auth/failure.js';
import {
  CODEX_OPERATION_ABORTED,
  inspectCodexRealtimeFeature,
  waitForCodexOperationOrAbort,
} from '../../runtime/appServer/realtimeFeatureInspection.js';
import {
  readCodexAppServerSessionControls,
  type CodexAppServerSessionControlsSnapshot,
} from '../../runtime/appServer/state/controls.js';
import { resolveCodexSessionBackendMode } from '../backendMode.js';

export const CODEX_PREFLIGHT_RUNTIME_DIAGNOSTIC_ENV_KEYS = Object.freeze([
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
] as const);

const CODEX_PREFLIGHT_JSON_RPC_COMMAND = Object.freeze({
  toolId: 'codex-cli',
  args: Object.freeze(['app-server', '--listen', 'stdio://']),
  environmentExcludeKeys: CODEX_PREFLIGHT_RUNTIME_DIAGNOSTIC_ENV_KEYS,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSupportedPassiveCodexAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'apiKey') return true;
  return value.type === 'chatgpt'
    && (typeof value.email === 'string' || value.email === null)
    && typeof value.planType === 'string';
}

function isCodexAuthenticationError(error: unknown): boolean {
  const classification = classifyCodexConnectedServiceAuthFailure({
    providerErrorPath: true,
    error,
    serviceId: 'openai-codex',
    profileId: null,
    groupId: null,
  });
  return classification?.kind === 'auth_expired'
    || classification?.kind === 'account_changed'
    || classification?.kind === 'refresh_failed';
}

function readPassiveCodexAccountAuthentication(value: unknown): 'authenticated' | 'authentication_required' | 'unavailable' {
  const record = isRecord(value) ? value : null;
  if (!record || typeof record.requiresOpenaiAuth !== 'boolean') return 'unavailable';
  if (record.account === null || record.account === undefined) return 'authentication_required';
  return isSupportedPassiveCodexAccount(record.account) ? 'authenticated' : 'unavailable';
}

function passiveRealtimeResult(
  status: AgentPassiveRealtimeSetupResultV1['status'],
): AgentPassiveRealtimeSetupResultV1 {
  return { v: 1, status };
}

function usesCodexAppServer(context: AgentPreflightSessionControlsProbeContextV1): boolean {
  const backendMode = resolveCodexSessionBackendMode({
    accountSettings: context.accountSettings,
  }) ?? 'appServer';
  return backendMode === 'appServer';
}

function readCodexPreflightAuthMethod(
  context: AgentPreflightSessionControlsProbeContextV1,
): 'api_key_env' | null {
  return context.environment.OPENAI_API_KEY === true || context.environment.CODEX_API_KEY === true
    ? 'api_key_env'
    : null;
}

async function readCodexPreflightSessionControls(
  context: AgentPreflightSessionControlsProbeContextV1,
): Promise<CodexAppServerSessionControlsSnapshot | null> {
  if (!usesCodexAppServer(context)) return null;
  return await context.withDeclaredJsonRpcClient(
    CODEX_PREFLIGHT_JSON_RPC_COMMAND,
    async (client) => await readCodexAppServerSessionControls({
      client,
      authMethod: readCodexPreflightAuthMethod(context),
    }),
  );
}

async function probeCodexPassiveRealtimeSetup(
  context: AgentPreflightSessionControlsProbeContextV1,
): Promise<AgentPassiveRealtimeSetupResultV1> {
  if (!usesCodexAppServer(context)) return passiveRealtimeResult('unavailable');
  try {
    return await context.withDeclaredJsonRpcClient(
      CODEX_PREFLIGHT_JSON_RPC_COMMAND,
      async (client, signal) => {
        const accountOutcome = await waitForCodexOperationOrAbort(
          client.request('account/read', { refreshToken: false }),
          signal,
        );
        if (accountOutcome === CODEX_OPERATION_ABORTED) return passiveRealtimeResult('unavailable');
        const accountAuthentication = readPassiveCodexAccountAuthentication(accountOutcome);
        if (accountAuthentication !== 'authenticated') {
          return passiveRealtimeResult(accountAuthentication);
        }

        const featureInspection = await inspectCodexRealtimeFeature({
          client,
          isAuthenticationError: isCodexAuthenticationError,
          signal,
        });
        if (featureInspection.status === 'enabled') return passiveRealtimeResult('ready');
        switch (featureInspection.code) {
          case 'feature_not_advertised':
          case 'feature_missing':
            return passiveRealtimeResult('runtime_incompatible');
          case 'authentication_required':
            return passiveRealtimeResult('authentication_required');
          case 'feature_disabled':
            return passiveRealtimeResult('feature_disabled');
          case 'inspection_aborted':
          case 'currentness_lost':
          case 'feature_list_unavailable':
          case 'feature_list_invalid':
          case 'feature_state_invalid':
          case 'feature_state_ambiguous':
          case 'feature_pagination_invalid':
          case 'feature_pagination_incomplete':
            return passiveRealtimeResult('unavailable');
        }
      },
    );
  } catch (error) {
    return passiveRealtimeResult(
      isCodexAuthenticationError(error) ? 'authentication_required' : 'unavailable',
    );
  }
}

export const CODEX_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  jsonRpcCommand: CODEX_PREFLIGHT_JSON_RPC_COMMAND,
  resolveProbeVariant: ({ accountSettings }) => {
    const backendMode = resolveCodexSessionBackendMode({ accountSettings }) ?? 'appServer';
    return `codex:${backendMode}`;
  },
  probeModels: async (context) => (await readCodexPreflightSessionControls(context))?.availableModels ?? null,
  probeModes: async (context) => (await readCodexPreflightSessionControls(context))?.availableModes ?? null,
  probeConfigOptions: async (context) => (await readCodexPreflightSessionControls(context))?.configOptions ?? null,
  probePassiveRealtimeSetup: probeCodexPassiveRealtimeSetup,
} satisfies AgentPreflightSessionControlsContributionV1);
