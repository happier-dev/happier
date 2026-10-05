import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeFactory,
  AgentTerminalSurface,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import { buildCodexNativeAcpRuntimeOptions } from '../acp/backend.js';
import { resolveCanonicalCodexBackendModeFromCompatInput } from '../lifecycle/backendMode.js';
import { readCanonicalCodexAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { buildCodexTerminalArgs } from './terminal/invocation.js';
import { resolveCodexTerminalPermissionPolicy } from './terminal/permissionPolicy.js';
import {
  openCodexNativeAppServerExecutionRunConversation,
  openCodexNativeAppServerSession,
} from './appServer/native.js';
import { createCodexNativeSessionControls } from './controls.js';
import { createCodexGoalProjection, type CodexGoalProjection } from './appServer/work/goalProjection.js';
import { codexHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';

export {
  codexExternalSessionsContribution,
} from '../surfaces/sessions/external/contribution.js';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function readCodexBackendMode(
  request: Parameters<NonNullable<AgentSessionRuntimeFactory['resolveTerminalPresentation']>>[0],
): 'appServer' | 'acp' {
  const environment = request.launchEnvironment?.values ?? {};
  const resolved = resolveCanonicalCodexBackendModeFromCompatInput({
    runtimeDescriptorV1: request.runtimeDescriptorV1,
    codexBackendMode: request.configuration?.options.codexBackendMode?.value
      ?? environment.HAPPIER_CODEX_BACKEND_MODE
      ?? environment.CODEX_BACKEND_MODE,
  });
  return resolved === 'acp' ? 'acp' : 'appServer';
}

async function openCodexExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  if (readCodexBackendMode(request) === 'acp') {
    return await context.protocols.acp.openExecutionRunV1(
      request,
      buildCodexNativeAcpRuntimeOptions(request),
    );
  }
  return await createExecutionRunHostBackendFromConversationRuntime({
    request: request.kind === 'fork'
      ? {
          ...request,
          kind: 'resume',
          checkpointId: request.checkpointId
            ?? (() => { throw new Error('Codex detached fork requires an exact provider checkpoint.'); })(),
        }
      : request,
    openConversation: async () => await openCodexNativeAppServerExecutionRunConversation(request, context),
    readCheckpointId: (event) => event.kind === 'provider-session-id'
      ? event.providerSessionId
      : null,
  });
}

function requestHasStartupInstructions(request: AgentSessionOpenRequest): boolean {
  return 'startupInstructions' in request && request.startupInstructions !== undefined;
}

async function openCodexSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
  goalProjection: CodexGoalProjection,
): Promise<AgentSessionRuntime> {
  const backendMode = readCodexBackendMode(request);
  if (backendMode === 'acp') {
    if (requestHasStartupInstructions(request)) {
      throw new PluginError({
        code: 'codex_startup_instructions_unsupported_in_acp',
        message: 'Codex ACP does not support Agent session startup instructions. Switch the Codex routing mode to App Server.',
        remediation: { kind: 'openSettings', path: '/settings/agents/codex' },
      });
    }
    if (Object.prototype.hasOwnProperty.call(request, 'providerBinding')) {
      throw new Error('Codex Provider binding is unavailable in ACP mode.');
    }
  }
  const session = backendMode === 'acp'
    ? await context.protocols.acp.open(
        request,
        buildCodexNativeAcpRuntimeOptions(request),
      )
    : await openCodexNativeAppServerSession(request, context, goalProjection);
  return {
    ...session,
    runtimeCapabilities: {
      ...session.runtimeCapabilities,
      localControl: backendMode === 'appServer'
        ? session.runtimeCapabilities?.localControl ?? null
        : null,
      sessionCapabilities: {
        ...session.runtimeCapabilities?.sessionCapabilities,
        sessionListing: 'supported',
        sessionFork: {
          conversation: backendMode === 'appServer' ? 'supported' : 'unsupported',
          fromMessage: 'unsupported',
          ...(backendMode === 'acp' ? { protocol: 'acp' as const } : {}),
        },
        sessionRollback: {
          conversation: backendMode === 'appServer' ? 'supported' : 'unsupported',
        },
      },
    },
  };
}

function createCodexNativeTerminalSurface(): AgentTerminalSurface {
  return {
    resolveLaunch(request) {
      const runtimeDescriptor = request.metadata.runtimeDescriptorV1
        ? readCanonicalCodexAgentRuntimeDescriptorV1(request.metadata.runtimeDescriptorV1)
        : null;
      const permissionMode = request.configuration?.permissionIntent.value ?? 'default';
      return {
        argv: buildCodexTerminalArgs({
          cwd: request.cwd,
          resumeId: runtimeDescriptor?.providerSessionId,
          permissionMode: request.configuration?.workspaceWrites === 'deny' ? 'read-only' : permissionMode,
          resolvePermissionPolicy: (mode) => resolveCodexTerminalPermissionPolicy(mode, request.configuration?.workspaceWrites),
        }),
        process: { stdio: 'inherit', windowsHide: true },
        presentation: {
          onLaunch: { target: 'local', reason: 'codex_terminal_runtime_launcher_start' },
          onExit: { target: 'remote', reason: 'codex_terminal_runtime_launcher_exit' },
        },
      };
    },
  };
}

export const createCodexAgentRuntime: AgentRuntimeFactory = () => {
  const goalProjection = createCodexGoalProjection();
  const controls = createCodexNativeSessionControls(goalProjection);
  return {
    sessions: {
      ...controls,
      async resolveTerminalPresentation(selection) {
        const backendMode = readCodexBackendMode(selection);
        const source = selection.runtimeDescriptorV1;
        const startingMode = selection.requestedHost === 'herdr'
          || selection.requestedHost === 'zellij'
          || selection.requestedHost === 'tmux'
          ? 'terminal' : 'remote';
        return {
          kind: backendMode === 'appServer' ? 'provider_attach' : 'none',
          ...(backendMode === 'appServer' ? { startingMode } : {}),
          runtimeDescriptorV1: {
            ...(source?.agentId === 'codex' ? source : {}), v: 1, agentId: 'codex',
            agent: { ...(source?.agentId === 'codex' ? source.agent : {}), backendMode },
          },
          environmentOverlay: { HAPPIER_CODEX_BACKEND_MODE: backendMode },
        };
      },
      open: async (request, context) => await openCodexSession(request, context, goalProjection),
      executionRunContextV1: {
        open: async (request, context) => await openCodexExecutionRun(request, context),
      },
    },
    surfaces: {
      terminal: createCodexNativeTerminalSurface(),
      handoff: codexHandoffSurface,
    },
  } satisfies AgentRuntime;
};
