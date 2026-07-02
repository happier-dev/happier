import type { TerminalHostPreference } from '@happier-dev/agents';
import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type {
  BundledSessionRuntimeCreateResultV1,
  InternalRuntimeTurnOperationsEnvelopeV1,
} from '@happier-dev/plugin-sdk/internal/runtime/session';

import { resolveMetadataStringOverrideV1 } from '@happier-dev/agents';

import { isolateClaudeRuntimeAuthEnv } from '../../../auth/services/runtime/env.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.js';

const DEFAULT_HOST_PREFERENCE: TerminalHostPreference = 'auto';

type HostSessionRuntimeFactoryParams = Readonly<{
  directory?: string;
  metadata?: Readonly<Record<string, unknown>>;
  session?: Readonly<{ sessionId?: string }>;
  getPermissionMode?: () => unknown;
  setThinking?: (thinking: boolean) => void;
}>;

type ClaudeUnifiedTerminalSessionPlan = Readonly<{
  kind: 'hostSessionRuntimePlan';
  providerId: typeof CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID;
  opts: Readonly<Record<string, unknown>>;
  config: Readonly<{
    flavor: 'claude';
    policyAgentId: typeof CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID;
    backendDisplayName: 'Claude';
    uiLogPrefix: '[claude]';
    providerName: 'Claude';
    waitingForCommandLabel: 'Claude';
    agentMessageType: 'claude';
    supportsMcpServers: true;
    machineMetadata: Readonly<Record<string, unknown>>;
    terminalDisplay: () => null;
    shouldRenderTerminalDisplay: () => false;
    formatPromptErrorMessage: (error: unknown) => string;
    resolveKeepAliveMode: () => 'terminal';
    startRuntimeBeforeFirstPrompt: true;
    createSessionRuntime: (params: HostSessionRuntimeFactoryParams) => Promise<InternalRuntimeTurnOperationsEnvelopeV1>;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDirectory(sessionParams: CreateSessionRuntimeParamsV1): string {
  return readString(sessionParams.cwd)
    ?? readString(sessionParams.directory)
    ?? process.cwd();
}

function readHostCredentials(sessionParams: CreateSessionRuntimeParamsV1): unknown {
  return (sessionParams as CreateSessionRuntimeParamsV1 & Readonly<{
    credentials?: unknown;
  }>).credentials;
}

function readSessionId(sessionParams: CreateSessionRuntimeParamsV1): string {
  return readString(sessionParams.sessionId) ?? `claude-${Date.now().toString(36)}`;
}

function readEnv(sessionParams: CreateSessionRuntimeParamsV1): Readonly<Record<string, string>> {
  const source = sessionParams.isolation?.env ?? sessionParams.env ?? {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  return isolateClaudeRuntimeAuthEnv(env);
}

function readUnifiedTerminalHostPreference(raw: unknown): TerminalHostPreference {
  return raw === 'tmux' || raw === 'zellij' || raw === 'auto'
    ? raw
    : DEFAULT_HOST_PREFERENCE;
}

function resolveHostPreference(params: Readonly<{
  initialMetadata?: Readonly<Record<string, unknown>> | null;
  runtimeMetadata?: Readonly<Record<string, unknown>> | null;
}>): TerminalHostPreference {
  return readUnifiedTerminalHostPreference(
    params.runtimeMetadata?.claudeUnifiedTerminalHost
      ?? params.initialMetadata?.claudeUnifiedTerminalHost,
  );
}

const ACP_SESSION_MODE_OVERRIDE_KEY = 'acpSessionModeOverrideV1';

/**
 * Reads the agent/session mode id (e.g. `plan`) from a metadata snapshot. The mode is persisted
 * as `metadata.acpSessionModeOverrideV1 = { v: 1, updatedAt, modeId }`; the runtime snapshot wins
 * over the initial spawn metadata when both are present (latest intent).
 */
function readAgentModeId(params: Readonly<{
  runtimeMetadata?: Readonly<Record<string, unknown>> | null;
  initialMetadata?: Readonly<Record<string, unknown>> | null;
}>): string | null {
  const fromRuntime = resolveMetadataStringOverrideV1(
    params.runtimeMetadata ?? null,
    ACP_SESSION_MODE_OVERRIDE_KEY,
    'modeId',
  );
  if (fromRuntime?.value) return fromRuntime.value;
  const fromInitial = resolveMetadataStringOverrideV1(
    params.initialMetadata ?? null,
    ACP_SESSION_MODE_OVERRIDE_KEY,
    'modeId',
  );
  return fromInitial?.value ?? null;
}

/**
 * Resolves the permission mode actually handed to the Claude unified terminal, honoring the
 * `plan` agent mode. Without this the `agentModeId='plan'` intent was dropped on the unified path
 * (only `permissionMode` was forwarded), so a session that should launch in plan launched in the
 * raw permission mode (e.g. safe-yolo→auto) instead. Plan wins over the raw permission mode.
 */
export function resolveUnifiedTerminalPermissionMode(params: Readonly<{
  permissionMode: string | null;
  runtimeMetadata?: Readonly<Record<string, unknown>> | null;
  initialMetadata?: Readonly<Record<string, unknown>> | null;
}>): string | null {
  const agentModeId = readAgentModeId({
    runtimeMetadata: params.runtimeMetadata,
    initialMetadata: params.initialMetadata,
  });
  if (!agentModeId && params.permissionMode === null) return null;
  return resolveClaudePermissionModeFromRuntimeMode({
    permissionMode: params.permissionMode ?? 'default',
    agentModeId,
  });
}

function formatPromptErrorMessage(error: unknown): string {
  if (error instanceof Error && readString(error.message)) {
    return error.message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted]');
  }
  return 'Claude prompt failed';
}

export async function bindClaudeUnifiedTerminalSession(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<BundledSessionRuntimeCreateResultV1> {
  const directory = readDirectory(params.sessionParams);
  const happierSessionId = readSessionId(params.sessionParams);
  const launchEnv = readEnv(params.sessionParams);
  const initialMetadata = isRecord(params.sessionParams.metadata) ? params.sessionParams.metadata : null;
  const credentials = readHostCredentials(params.sessionParams);

  return {
    kind: 'hostSessionRuntimePlan',
    providerId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
    opts: {
      directory,
      backendId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      ...(credentials === undefined ? {} : { credentials }),
    },
    config: {
      flavor: 'claude',
      policyAgentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      backendDisplayName: 'Claude',
      uiLogPrefix: '[claude]',
      providerName: 'Claude',
      waitingForCommandLabel: 'Claude',
      agentMessageType: 'claude',
      supportsMcpServers: true,
      machineMetadata: {},
      terminalDisplay: () => null,
      shouldRenderTerminalDisplay: () => false,
      formatPromptErrorMessage,
      resolveKeepAliveMode: () => 'terminal',
      startRuntimeBeforeFirstPrompt: true,
      createSessionRuntime: async (runtimeParams) => createClaudeUnifiedTerminalTurnOperations({
        ctx: params.ctx,
        directory: readString(runtimeParams.directory) ?? directory,
        happierSessionId: readString(runtimeParams.session?.sessionId) ?? happierSessionId,
        hostPreference: resolveHostPreference({
          initialMetadata,
          runtimeMetadata: isRecord(runtimeParams.metadata) ? runtimeParams.metadata : null,
        }),
        launchEnv,
        permissionMode: resolveUnifiedTerminalPermissionMode({
          permissionMode: readString(runtimeParams.getPermissionMode?.()) ?? readString(params.sessionParams.permissionMode),
          runtimeMetadata: isRecord(runtimeParams.metadata) ? runtimeParams.metadata : null,
          initialMetadata,
        }),
        setThinking: runtimeParams.setThinking,
      }),
    },
  } satisfies ClaudeUnifiedTerminalSessionPlan;
}
