import type { AgentPassiveRealtimeSetupResultV1 } from '@happier-dev/plugin-sdk/agents';
import type {
  AgentPreflightSessionControlsContributionV1,
  AgentPreflightSessionControlsProbeContextV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { classifyCodexConnectedServiceAuthFailure } from '../../auth/services/runtime/auth/failure.js';
import {
  buildCodexAppServerBaseArgs,
  initializeCodexAppServerClient,
} from '../../runtime/appServer/connection.js';
import {
  CODEX_OPERATION_ABORTED,
  inspectCodexRealtimeFeature,
  waitForCodexOperationOrAbort,
} from '../../runtime/appServer/realtimeFeatureInspection.js';
import {
  readCodexAppServerSessionControls,
  type CodexAppServerSessionControlsSnapshot,
} from '../../runtime/appServer/state/controls.js';
import { listCodexAppServerSkills } from '../../runtime/appServer/catalog/index.js';
import { resolveCodexSessionBackendMode } from '../backendMode.js';

// Codex rust-v0.163.0 / 83086188ae0614bd882818ff1aa23f3194962012:
// protocol/src/user_input.rs MAX_USER_INPUT_TEXT_CHARS; app-server-protocol
// protocol/v2/turn.rs text_char_count counts only Text items in scalar values.
// independently of model context/output tokens. Native refusal remains authoritative.
// https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/protocol/src/user_input.rs#L10
const CODEX_MAX_INPUT_UNICODE_CHARACTERS = 1 << 20;

export const CODEX_PREFLIGHT_RUNTIME_DIAGNOSTIC_ENV_KEYS = Object.freeze([
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH',
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_MAX_BYTES',
  'HAPPIER_CODEX_APP_SERVER_RPC_LOG_ROTATE_COUNT',
] as const);

const CODEX_PREFLIGHT_JSON_RPC_COMMAND = Object.freeze({
  toolId: 'codex-cli',
  args: buildCodexAppServerBaseArgs(false),
  environmentExcludeKeys: CODEX_PREFLIGHT_RUNTIME_DIAGNOSTIC_ENV_KEYS,
});
const CODEX_PREFLIGHT_ACP_COMMAND = Object.freeze({
  executable: Object.freeze({ kind: 'managedDependency' as const, id: 'codex-acp' }),
  args: Object.freeze([]),
});
const CODEX_REALTIME_PREFLIGHT_JSON_RPC_COMMAND = Object.freeze({
  ...CODEX_PREFLIGHT_JSON_RPC_COMMAND,
  args: buildCodexAppServerBaseArgs(true),
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

function usesCodexAppServer(context: Pick<AgentPreflightSessionControlsProbeContextV1, 'accountSettings' | 'runtimeDescriptorV1' | 'runtimeKindOverride'>): boolean {
  const backendMode = resolveCodexSessionBackendMode({
    accountSettings: context.accountSettings,
    runtimeDescriptorV1: context.runtimeDescriptorV1,
    runtimeKindOverride: context.runtimeKindOverride,
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

async function readCodexAcpPreflightSessionControls(context: AgentPreflightSessionControlsProbeContextV1) {
  const authenticationMethodId = context.nonblankEnvironment?.OPENAI_API_KEY === true
    ? 'openai-api-key' : context.nonblankEnvironment?.CODEX_API_KEY === true ? 'codex-api-key' : undefined;
  return await context.probeDeclaredAcpSessionControls?.({ ...CODEX_PREFLIGHT_ACP_COMMAND,
    ...(authenticationMethodId ? { authenticationMethodId } : {}) }) ?? null;
}

async function readCodexPreflightSessionControls(
  context: AgentPreflightSessionControlsProbeContextV1,
): Promise<CodexAppServerSessionControlsSnapshot | null> {
  if (!usesCodexAppServer(context)) return null;
  return await context.withDeclaredJsonRpcClient(
    CODEX_PREFLIGHT_JSON_RPC_COMMAND,
    async (client, signal) => {
      const initialized = await waitForCodexOperationOrAbort(
        initializeCodexAppServerClient(client),
        signal,
      );
      if (initialized === CODEX_OPERATION_ABORTED) return null;
      return await readCodexAppServerSessionControls({
        client,
        authMethod: readCodexPreflightAuthMethod(context),
      });
    },
  );
}

async function probeCodexPassiveRealtimeSetup(
  context: AgentPreflightSessionControlsProbeContextV1,
): Promise<AgentPassiveRealtimeSetupResultV1> {
  if (!usesCodexAppServer(context)) return passiveRealtimeResult('unavailable');
  try {
    return await context.withDeclaredJsonRpcClient(
      CODEX_REALTIME_PREFLIGHT_JSON_RPC_COMMAND,
      async (client, signal) => {
        const initialized = await waitForCodexOperationOrAbort(
          initializeCodexAppServerClient(client),
          signal,
        );
        if (initialized === CODEX_OPERATION_ABORTED) return passiveRealtimeResult('unavailable');
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
  resolveMaxInputUnicodeCharacters: input => usesCodexAppServer(input) ? CODEX_MAX_INPUT_UNICODE_CHARACTERS : null,
  jsonRpcCommands: Object.freeze([
    CODEX_PREFLIGHT_JSON_RPC_COMMAND,
    CODEX_REALTIME_PREFLIGHT_JSON_RPC_COMMAND,
    CODEX_PREFLIGHT_ACP_COMMAND,
  ]),
  resolveProbeVariant: ({ accountSettings, runtimeDescriptorV1, runtimeKindOverride }) => {
    const backendMode = resolveCodexSessionBackendMode({ accountSettings, runtimeDescriptorV1, runtimeKindOverride }) ?? 'appServer';
    return `codex:${backendMode}`;
  },
  probeModels: async (context) => {
    if (!usesCodexAppServer(context)) {
      const controls = await readCodexAcpPreflightSessionControls(context);
      return controls?.refreshError
        ? { availableModels: controls.models ?? [], refreshError: true, source: controls.models === null ? 'unavailable' : 'dynamic',
          ...(controls.observedAt === undefined ? {} : { observedAt: controls.observedAt }),
          ...(controls.refreshErrorMessage === undefined ? {} : { refreshErrorMessage: controls.refreshErrorMessage }) }
        : controls?.models ?? null;
    }
    const controls = await readCodexPreflightSessionControls(context);
    if (!controls?.modelsObserved) return null;
    if (!controls.availableModels.length) return [];
    return [{ id: 'default', name: 'Default' }, ...controls.availableModels.filter(model => model.id !== 'default')];
  },
  probeModes: async (context) => usesCodexAppServer(context)
    ? (await readCodexPreflightSessionControls(context))?.availableModes ?? null
    : (await readCodexAcpPreflightSessionControls(context))?.modes ?? null,
  probeConfigOptions: async (context) => usesCodexAppServer(context)
    ? (await readCodexPreflightSessionControls(context))?.configOptions ?? null
    : await readCodexAcpPreflightSessionControls(context),
  probeCatalogs: async (context) => {
    if (!usesCodexAppServer(context)) {
      const authenticationMethodId = context.nonblankEnvironment?.OPENAI_API_KEY === true
        ? 'openai-api-key'
        : context.nonblankEnvironment?.CODEX_API_KEY === true ? 'codex-api-key' : undefined;
      return await context.probeDeclaredAcpCatalogs({
        ...CODEX_PREFLIGHT_ACP_COMMAND,
        ...(authenticationMethodId ? { authenticationMethodId } : {}),
      });
    }
    return await context.withDeclaredJsonRpcClient(
      CODEX_PREFLIGHT_JSON_RPC_COMMAND,
      async (client, signal) => {
        const initialized = await waitForCodexOperationOrAbort(
          initializeCodexAppServerClient(client), signal,
        );
        if (initialized === CODEX_OPERATION_ABORTED) return { commands: null, skills: null };
        const result = await waitForCodexOperationOrAbort(
          listCodexAppServerSkills({ client, cwd: context.cwd }), signal,
        );
        if (result === CODEX_OPERATION_ABORTED) return { commands: null, skills: null };
        return {
          commands: null,
          skills: result.supported ? result.skills : null,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        };
      },
    );
  },
  probePassiveRealtimeSetup: probeCodexPassiveRealtimeSetup,
} satisfies AgentPreflightSessionControlsContributionV1);
