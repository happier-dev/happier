import type { TerminalHostPreference } from '@happier-dev/agents';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
  type ClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '../../../../agentSettings/definition.js';
import { normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy } from '../../../../protocol/remoteSettings.js';
import { join } from 'node:path';

import { resolveMetadataStringOverrideV1 } from '@happier-dev/agents';

import { isolateClaudeRuntimeAuthEnv } from '../../../auth/services/runtime/env.js';
import { resolveClaudeConfigDirOverride } from '../../../environment.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import {
  DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE,
  normalizeClaudeUnifiedResumeChoice,
  type ClaudeUnifiedResumeChoicePolicy,
} from './resumeChoice/types.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.testkit.js';
import type { ClaudeUnifiedTerminalContext } from './turnOperations.js';
import {
  composeClaudeRuntimeEnvironment,
  type ClaudeRuntimeSessionParams,
} from '../../shared/runtimeHelpers.js';

const DEFAULT_HOST_PREFERENCE: TerminalHostPreference = 'auto';

type ClaudeLegacyUnifiedTerminalContext = ClaudeUnifiedTerminalContext & Readonly<{
  sessions: Readonly<{
    current: ClaudeUnifiedTerminalContext['sessions']['current'] & Readonly<{
      writeAgentState?(request: Readonly<{
        kind: 'update';
        handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
      }>): Promise<void>;
    }>;
  }>;
}>;

type ClaudeLegacyUnifiedSessionParams = ClaudeRuntimeSessionParams & Readonly<{
  sessionId?: string | null;
  permissionMode?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
  resume?: string | null;
}>;

export function createClaudeLegacyActiveInputStatusPublisher(
  ctx: ClaudeLegacyUnifiedTerminalContext,
): Pick<AgentSessionRuntimeContext['session']['services']['activeInput'], 'publishStatus'> {
  return {
    publishStatus(status) {
      const writeAgentState = ctx.sessions.current.writeAgentState;
      if (typeof writeAgentState !== 'function') return;
      void writeAgentState({
        kind: 'update',
        handler: (current) => ({
          ...current,
          capabilities: {
            ...(current.capabilities && typeof current.capabilities === 'object'
              ? current.capabilities as Readonly<Record<string, unknown>>
              : {}),
            inFlightSteerAvailable: status.steerAvailable,
            inFlightSteerUnavailableReason: status.steerUnavailableReason,
            inFlightSteerStateAt: status.stateUpdatedAtMs,
            terminalComposerDraftPresent: status.terminalComposerDraftPresent,
            terminalComposerClearSupported: status.terminalComposerClearSupported,
            inFlightConfigApplySupported: status.inFlightConfigurationApplySupported,
            pendingInputInterruptAndRunLocalId: status.pendingInputInterruptAndRunLocalId,
            pendingInputInterruptAndRunStateAt: status.pendingInputInterruptAndRunStateAt,
          },
        }),
      }).catch((error) => {
        ctx.logger.debug('[ClaudeUnifiedTerminal] active-input status compatibility publish failed', { error });
      });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDirectory(sessionParams: ClaudeLegacyUnifiedSessionParams): string {
  return readString(sessionParams.cwd)
    ?? readString(sessionParams.directory)
    ?? process.cwd();
}

function readSessionId(sessionParams: ClaudeLegacyUnifiedSessionParams): string {
  return readString(sessionParams.sessionId) ?? `claude-${Date.now().toString(36)}`;
}

function readEnv(sessionParams: ClaudeLegacyUnifiedSessionParams): Readonly<Record<string, string>> {
  const source = composeClaudeRuntimeEnvironment({
    isolationEnvironment: sessionParams.isolation?.env,
    environment: sessionParams.env,
    unsetEnvKeys: sessionParams.isolation?.unsetEnvKeys,
  });
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

function readActiveTerminalHostPreference(metadata: Readonly<Record<string, unknown>> | null | undefined): TerminalHostPreference | null {
  const terminal = isRecord(metadata?.terminal) ? metadata.terminal : null;
  const mode = terminal?.mode;
  return mode === 'tmux' || mode === 'zellij' ? mode : null;
}

function resolveExternalSessionTranscriptPath(params: Readonly<{
  metadata: Readonly<Record<string, unknown>> | null;
  providerSessionId: string;
}>): string | null {
  const externalSession = isRecord(params.metadata?.externalSessionV1)
    ? params.metadata.externalSessionV1
    : null;
  const source = isRecord(externalSession?.source) ? externalSession.source : null;
  if (!source || source.kind !== 'claudeConfig') return null;
  const configDir = readString(source.configDir);
  const projectId = readString(source.projectId);
  if (!configDir || !projectId) return null;
  return join(configDir, 'projects', projectId, `${params.providerSessionId}.jsonl`);
}

function resolveKnownClaudeTranscriptBinding(params: Readonly<{
  directory: string;
  launchEnv: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, unknown>> | null;
}>): Readonly<{ providerSessionId: string; transcriptPath: string }> | null {
  const providerSessionId = readString(params.metadata?.claudeSessionId);
  if (!providerSessionId) return null;

  const transcriptPath =
    resolveExternalSessionTranscriptPath({ metadata: params.metadata, providerSessionId })
    ?? readString(params.metadata?.claudeTranscriptPath)
    ?? join(
      getClaudeProjectPath(
        params.directory,
        resolveClaudeConfigDirOverride({ ...params.launchEnv }),
      ),
      `${providerSessionId}.jsonl`,
    );

  return { providerSessionId, transcriptPath };
}

function resolveExplicitResumeTranscriptBinding(params: Readonly<{
  directory: string;
  launchEnv: Readonly<Record<string, string>>;
  providerSessionId: string | null;
}>): Readonly<{ providerSessionId: string; transcriptPath: string }> | null {
  if (!params.providerSessionId) return null;

  return {
    providerSessionId: params.providerSessionId,
    transcriptPath: join(
      getClaudeProjectPath(
        params.directory,
        resolveClaudeConfigDirOverride({ ...params.launchEnv }),
      ),
      `${params.providerSessionId}.jsonl`,
    ),
  };
}

function resolveHostPreference(params: Readonly<{
  initialMetadata?: Readonly<Record<string, unknown>> | null;
  runtimeMetadata?: Readonly<Record<string, unknown>> | null;
}>): TerminalHostPreference {
  const activeHost =
    readActiveTerminalHostPreference(params.runtimeMetadata)
    ?? readActiveTerminalHostPreference(params.initialMetadata);
  if (activeHost) return activeHost;

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

export function resolveUnifiedTerminalResumeChoice(params: Readonly<{
  runtimeMetadata?: Readonly<Record<string, unknown>> | null;
  initialMetadata?: Readonly<Record<string, unknown>> | null;
}>): ClaudeUnifiedResumeChoicePolicy {
  return normalizeClaudeUnifiedResumeChoice(params.runtimeMetadata?.claudeUnifiedTerminalResumeChoice)
    ?? normalizeClaudeUnifiedResumeChoice(params.initialMetadata?.claudeUnifiedTerminalResumeChoice)
    ?? DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE;
}

export function resolveUnifiedTerminalWorkspaceTrustPolicy(params: Readonly<{
  runtimeMetadata?: Readonly<Record<string, unknown>> | null;
  initialMetadata?: Readonly<Record<string, unknown>> | null;
}>): ClaudeUnifiedTerminalWorkspaceTrustPolicy {
  return normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(
    params.runtimeMetadata?.claudeUnifiedTerminalWorkspaceTrust,
  )
    ?? normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(
      params.initialMetadata?.claudeUnifiedTerminalWorkspaceTrust,
    )
    ?? DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY;
}

export async function bindClaudeUnifiedTerminalSession(params: Readonly<{
  ctx: ClaudeLegacyUnifiedTerminalContext;
  sessionParams: ClaudeLegacyUnifiedSessionParams;
}>) {
  const directory = readDirectory(params.sessionParams);
  const happierSessionId = readSessionId(params.sessionParams);
  const launchEnv = readEnv(params.sessionParams);
  const initialMetadata = isRecord(params.sessionParams.metadata) ? params.sessionParams.metadata : null;
  const explicitResumeSessionId = readString(
    (params.sessionParams as Readonly<Record<string, unknown>>).resume,
  );

  const explicitResumeBinding = resolveExplicitResumeTranscriptBinding({
    directory,
    launchEnv,
    providerSessionId: explicitResumeSessionId,
  });
  const launchIntent = explicitResumeBinding
    ? { kind: 'resume_native' as const, providerSessionId: explicitResumeBinding.providerSessionId }
    : { kind: 'new_session' as const };

  return createClaudeUnifiedTerminalTurnOperations({
    ctx: params.ctx,
    activeInput: createClaudeLegacyActiveInputStatusPublisher(params.ctx),
    directory,
    happierSessionId,
    hostPreference: resolveHostPreference({
      initialMetadata,
      runtimeMetadata: null,
    }),
    launchEnv,
    permissionMode: resolveUnifiedTerminalPermissionMode({
      permissionMode: readString(params.sessionParams.permissionMode),
      runtimeMetadata: null,
      initialMetadata,
    }),
    initialWorkflowActivityHeadline: initialMetadata?.sessionWorkflowActivityHeadlineV1,
    // Its agent-scoped half. Both keys are written in one metadata update, and only this one names
    // the agents a killed process left running — without it crash recovery is count-only.
    initialAgentActivityHeadline: initialMetadata?.sessionAgentActivityHeadlineV1,
    knownProviderSession: explicitResumeBinding
      ?? resolveKnownClaudeTranscriptBinding({
        directory,
        launchEnv,
        metadata: initialMetadata,
      }),
    launchIntent,
    resumeChoice: resolveUnifiedTerminalResumeChoice({
      runtimeMetadata: null,
      initialMetadata,
    }),
    workspaceTrustPolicy: resolveUnifiedTerminalWorkspaceTrustPolicy({
      runtimeMetadata: null,
      initialMetadata,
    }),
  });
}
