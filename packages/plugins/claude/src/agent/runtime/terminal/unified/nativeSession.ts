import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionOpenRequest,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveClaudeUnifiedTerminalResponseLocations } from '@happier-dev/protocol/agents/claude/settings-policy';
import type { TerminalHostPreference } from '@happier-dev/plugin-sdk/agents/runtime';
import { join } from 'node:path';
import {
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
} from '../../../../agentSettings/definition.js';
import {
  normalizeClaudeUnifiedTerminalHost,
  normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '../../../../protocol/remoteSettings.js';

import { isolateClaudeRuntimeAuthEnv } from '../../../auth/services/runtime/env.js';
import { resolveClaudeConfigDirOverride } from '../../../environment.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';
import {
  createClaudeNativeAgentSdkContext,
  createClaudeNativeGoalWorkStatePublisher,
} from '../../nativeServices.js';
import { resolveClaudePermissionModeFromRuntimeMode } from '../../permissionMode.js';
import {
  DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE,
  normalizeClaudeUnifiedResumeChoice,
} from './resumeChoice/types.js';
import {
  createClaudeUnifiedTerminalTurnOperations,
  type ClaudeUnifiedTerminalContext,
} from './turnOperations.js';
import {
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeNativeLaunchSettings,
  resolveClaudeUnifiedTerminalLaunchEnvironment,
} from '../../launchSettings.js';
import {
  isClaudeUltracodeSupportedModelId,
  resolveClaudeEffortForModel,
} from '../../reasoningEffort.js';
import { readClaudeTerminalRuntimeSelection } from './selection.js';

const CLAUDE_UNIFIED_TERMINAL_HOST_SETTING_KEY = 'claudeUnifiedTerminalHost';
const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_SETTING_KEY = 'claudeUnifiedTerminalResumeChoice';
const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_SETTING_KEY = 'claudeUnifiedTerminalWorkspaceTrust';

async function readSetting(context: AgentSessionRuntimeContext, key: string): Promise<unknown> {
  try {
    return await context.services.settings.forScope({ kind: 'account' }).get(key);
  } catch {
    return null;
  }
}

function readHostPreference(value: unknown): TerminalHostPreference {
  return normalizeClaudeUnifiedTerminalHost(value) ?? 'auto';
}

function createClaudeNativeUnifiedTerminalContext(
  context: AgentSessionRuntimeContext,
): ClaudeUnifiedTerminalContext {
  const terminalHost = context.session.services.terminalHost;
  if (!terminalHost) {
    throw new Error('Claude Unified Terminal requires the host terminal service.');
  }
  const sdkContext = createClaudeNativeAgentSdkContext(context);
  return {
    logger: sdkContext.logger,
    features: context.session.services.features,
    storage: {
      daemonSession: {
        async get<T = unknown>(key: string): Promise<T | null> {
          return await context.services.storage.daemonSession.get(key) as T | null;
        },
        async set(key, value) {
          await context.services.storage.daemonSession.set(key, AgentRuntimeJsonValueSchema.parse(value));
        },
      },
    },
    agentRuntime: {
      terminalHost,
      sessionHooks: sdkContext.agentRuntime.sessionHooks,
      transcripts: sdkContext.agentRuntime.transcripts,
      accountUsage: sdkContext.agentRuntime.accountUsage,
      ...(sdkContext.agentRuntime.nativeHome ? { nativeHome: sdkContext.agentRuntime.nativeHome } : {}),
      toolExecution: sdkContext.agentRuntime.toolExecution,
      modes: sdkContext.agentRuntime.modes,
    },
    sessions: sdkContext.sessions,
  };
}

type ClaudeNativeUnifiedTerminalSessionInput = Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  supportsEffort?: boolean;
  supportsSystemPromptSnapshotOff?: boolean;
}>;

function resolvePermissionMode(input: ClaudeNativeUnifiedTerminalSessionInput) {
  const permissionMode = input.request.configuration?.permissionIntent.value ?? null;
  const agentModeId = input.request.configuration?.mode.value ?? null;
  if (permissionMode === null && agentModeId === null) return null;
  return resolveClaudePermissionModeFromRuntimeMode({
    permissionMode: permissionMode ?? 'default',
    agentModeId,
  });
}

export function resolveClaudeNativeUnifiedResume(input: Readonly<{
  request: AgentSessionOpenRequest;
  launchEnv: Readonly<Record<string, string>>;
}>): Readonly<{
  knownProviderSession: Readonly<{
    providerSessionId: string;
    transcriptPath: string;
  }> | null;
  launchIntent:
    | Readonly<{ kind: 'new_session' }>
    | Readonly<{ kind: 'resume_native'; providerSessionId: string }>;
}> {
  if (input.request.kind !== 'resume') {
    return {
      knownProviderSession: null,
      launchIntent: { kind: 'new_session' },
    };
  }
  const providerSessionId = input.request.providerSessionId;
  return {
    knownProviderSession: {
      providerSessionId,
      transcriptPath: join(
        getClaudeProjectPath(
          input.request.cwd,
          resolveClaudeConfigDirOverride({ ...input.launchEnv }),
        ),
        `${providerSessionId}.jsonl`,
      ),
    },
    launchIntent: {
      kind: 'resume_native',
      providerSessionId,
    },
  };
}

export async function openClaudeNativeUnifiedTerminalSession(
  input: ClaudeNativeUnifiedTerminalSessionInput,
) {
  if (input.request.kind === 'fork') {
    throw new Error(`Claude Unified Terminal native ${input.request.kind} opening is not yet available.`);
  }
  const [hostSetting, resumeChoiceSetting, workspaceTrustSetting, questionLocation, permissionLocation] = await Promise.all([
    readSetting(input.context, CLAUDE_UNIFIED_TERMINAL_HOST_SETTING_KEY),
    readSetting(input.context, CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_SETTING_KEY),
    readSetting(input.context, CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_SETTING_KEY),
    readSetting(input.context, 'claudeUnifiedTerminalQuestionResponseLocation'),
    readSetting(input.context, 'claudeUnifiedTerminalPermissionResponseLocation'),
  ]);
  const launchSettings = await resolveClaudeNativeLaunchSettings({
    settings: input.context.services.settings.forScope({ kind: 'account' }),
    launchEnv: isolateClaudeRuntimeAuthEnv(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: input.request.launchEnvironment,
      processEnv: process.env,
    })),
    includeAdvancedOptions: false,
    providerBinding: input.request.providerBinding,
  });
  const launchEnv = resolveClaudeUnifiedTerminalLaunchEnvironment(launchSettings.launchEnv);
  const initialModelId = input.request.providerBinding?.model.id
    ?? input.request.configuration?.model.value
    ?? null;
  const providerModel = input.request.providerBinding?.model;
  const requestedEffort = input.request.configuration?.options.reasoning_effort?.value;
  const initialEffort = input.supportsEffort === true ? resolveClaudeEffortForModel({
    modelId: initialModelId,
    effort: requestedEffort,
    ...(providerModel ? { providerModel } : {}),
  }) : null;
  const requestedUltracode = input.request.configuration?.options.ultracode?.value;
  const initialUltracode = input.supportsEffort === true
    && (requestedUltracode === true || requestedUltracode === 'true')
    && isClaudeUltracodeSupportedModelId(initialModelId, providerModel);
  const resume = resolveClaudeNativeUnifiedResume({
    request: input.request,
    launchEnv,
  });
  return createClaudeUnifiedTerminalTurnOperations({
    ctx: createClaudeNativeUnifiedTerminalContext(
      input.context,
    ),
    activeInput: input.context.session.services.activeInput,
    directory: input.request.cwd,
    happierSessionId: input.request.sessionId,
    hostPreference: readClaudeTerminalRuntimeSelection(input.request.runtimeDescriptorV1)?.host
      ?? readHostPreference(hostSetting),
    launchEnv,
    skills: input.request.skills,
    mcpToolPolicy: input.request.mcpToolPolicy,
    mcpServers: input.request.mcpServers,
    helperModelEnv: launchSettings.helperModelEnv,
    settingSources: launchSettings.settingSources,
    supportsEffort: input.supportsEffort === true,
    supportsSystemPromptSnapshotOff: input.supportsSystemPromptSnapshotOff === true,
    ...(input.request.startupInstructions
      ? { startupInstructions: input.request.startupInstructions.instructions } : {}),
    initialModelId,
    ...(initialEffort ? { initialEffort } : {}),
    ...(initialUltracode ? { initialUltracode: true } : {}),
    ...(input.request.providerBinding
      ? { providerModel: input.request.providerBinding.model }
      : {}),
    permissionMode: resolvePermissionMode(input),
    responseLocations: resolveClaudeUnifiedTerminalResponseLocations({
      claudeUnifiedTerminalQuestionResponseLocation: questionLocation,
      claudeUnifiedTerminalPermissionResponseLocation: permissionLocation,
    }),
    allowedTools: input.request.configuration?.allowedTools,
    unlistedTools: input.request.configuration?.unlistedTools,
    workspaceWrites: input.request.configuration?.workspaceWrites,
    knownProviderSession: resume.knownProviderSession,
    launchIntent: resume.launchIntent,
    resumeChoice: normalizeClaudeUnifiedResumeChoice(resumeChoiceSetting)
      ?? DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE,
    workspaceTrustPolicy: normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(workspaceTrustSetting)
      ?? DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
    publishGoalWorkState: createClaudeNativeGoalWorkStatePublisher(input.context),
  });
}
