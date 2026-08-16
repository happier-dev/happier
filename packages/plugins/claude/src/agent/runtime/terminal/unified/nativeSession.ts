import {
  AgentRuntimeJsonValueSchema,
  type AgentSessionOpenRequest,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { TerminalHostPreference } from '@happier-dev/agents';
import { join } from 'node:path';
import {
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
  normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from '@happier-dev/agents';

import { isolateClaudeRuntimeAuthEnv } from '../../../auth/services/runtime/env.js';
import { createClaudeNativePermissionEngine } from '../../../permissions/nativePermissionEngine.js';
import type { ClaudePermissionDecision } from '../../../permissions/createClaudePermissionEngine.js';
import {
  getClaudeProjectPath,
  resolveClaudeConfigDirOverride,
} from '../../../surfaces/sessions/handoff/path.js';
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
} from '../../launchSettings.js';
import {
  isClaudeUltracodeSupportedModelId,
  resolveClaudeEffortForModel,
} from '../../reasoningEffort.js';

const CLAUDE_UNIFIED_TERMINAL_HOST_SETTING_KEY = 'claudeUnifiedTerminalHost';
const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_SETTING_KEY = 'claudeUnifiedTerminalResumeChoice';
const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_SETTING_KEY = 'claudeUnifiedTerminalWorkspaceTrust';

async function readSetting(context: AgentSessionRuntimeContext, key: string): Promise<unknown> {
  try {
    return await context.services.settings.get(key);
  } catch {
    return null;
  }
}

function readHostPreference(value: unknown): TerminalHostPreference {
  return value === 'tmux' || value === 'zellij' || value === 'auto' ? value : 'auto';
}

function readUpdatedPermissions(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  return Array.isArray(value)
    && value.every((entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    ? value as readonly Readonly<Record<string, unknown>>[]
    : undefined;
}

function createNativePermissionDecisionAdapter(context: AgentSessionRuntimeContext) {
  const engine = createClaudeNativePermissionEngine(context);
  return {
    async requestDecision(
      request: Readonly<Record<string, unknown>>,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ClaudePermissionDecision> {
      const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : '';
      if (!toolName) return { decision: 'denied', rationale: 'Claude supplied an invalid tool request.' };
      const requestId = typeof request.requestId === 'string' ? request.requestId : null;
      const toolUseId = typeof request.toolCallId === 'string' ? request.toolCallId : null;
      const result = await engine.canCallTool(toolName, request.input, {
        requestId,
        toolUseId,
        signal: options?.signal,
      });
      const updatedPermissions = result.behavior === 'allow'
        ? readUpdatedPermissions(result.updatedPermissions)
        : undefined;
      return result.behavior === 'allow'
        ? {
            decision: 'approved',
            updatedInput: result.updatedInput,
            ...(updatedPermissions ? { updatedPermissions } : {}),
          }
        : {
            decision: 'denied',
            rationale: result.message,
          };
    },
  };
}

function createClaudeNativeUnifiedTerminalContext(
  context: AgentSessionRuntimeContext,
): ClaudeUnifiedTerminalContext {
  const terminalHost = context.session.services.terminalHost;
  if (!terminalHost) {
    throw new Error('Claude Unified Terminal requires the host terminal service.');
  }
  const sdkContext = createClaudeNativeAgentSdkContext(context, context);
  return {
    logger: sdkContext.logger,
    features: context.session.services.features,
    storage: {
      session: {
        async get<T = unknown>(key: string): Promise<T | null> {
          return await context.services.storage.session.get(key) as T | null;
        },
        async set(key, value) {
          await context.services.storage.session.set(key, AgentRuntimeJsonValueSchema.parse(value));
        },
      },
    },
    agentRuntime: {
      terminalHost,
      sessionHooks: sdkContext.agentRuntime.sessionHooks,
      transcripts: sdkContext.agentRuntime.transcripts,
      accountUsage: sdkContext.agentRuntime.accountUsage,
    },
    sessions: {
      current: {
        ...sdkContext.sessions.current,
        permissions: createNativePermissionDecisionAdapter(context),
      },
    },
  };
}

type ClaudeNativeUnifiedTerminalSessionInput = Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  supportsEffort?: boolean;
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
  const [hostSetting, resumeChoiceSetting, workspaceTrustSetting] = await Promise.all([
    readSetting(input.context, CLAUDE_UNIFIED_TERMINAL_HOST_SETTING_KEY),
    readSetting(input.context, CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE_SETTING_KEY),
    readSetting(input.context, CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_SETTING_KEY),
  ]);
  const launchSettings = await resolveClaudeNativeLaunchSettings({
    settings: input.context.services.settings,
    launchEnv: isolateClaudeRuntimeAuthEnv(resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: input.request.launchEnvironment,
      processEnv: process.env,
    })),
    includeAdvancedOptions: false,
  });
  const launchEnv = launchSettings.launchEnv;
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
    ctx: createClaudeNativeUnifiedTerminalContext(input.context),
    activeInput: input.context.session.services.activeInput,
    directory: input.request.cwd,
    happierSessionId: input.request.sessionId,
    hostPreference: readHostPreference(hostSetting),
    launchEnv,
    supportsEffort: input.supportsEffort === true,
    initialModelId,
    ...(initialEffort ? { initialEffort } : {}),
    ...(initialUltracode ? { initialUltracode: true } : {}),
    ...(input.request.providerBinding
      ? { providerModel: input.request.providerBinding.model }
      : {}),
    permissionMode: resolvePermissionMode(input),
    knownProviderSession: resume.knownProviderSession,
    launchIntent: resume.launchIntent,
    resumeChoice: normalizeClaudeUnifiedResumeChoice(resumeChoiceSetting)
      ?? DEFAULT_CLAUDE_UNIFIED_RESUME_CHOICE,
    workspaceTrustPolicy: normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(workspaceTrustSetting)
      ?? DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
    publishGoalWorkState: createClaudeNativeGoalWorkStatePublisher(input.context),
  });
}
