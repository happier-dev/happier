import type {
  AgentRuntime,
  AgentRuntimeFactory,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentTerminalSurface,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

import { buildCodexNativeAcpRuntimeOptions } from '../acp/backend.js';
import { resolveCanonicalCodexBackendModeFromCompatInput } from '../lifecycle/backendMode.js';
import { readCanonicalCodexAgentRuntimeDescriptorV1 } from '../../protocol/runtimeDescriptorV1.js';
import { buildCodexTerminalArgs } from './terminal/invocation.js';
import { resolveCodexTerminalPermissionPolicy } from './terminal/permissionPolicy.js';
import { openCodexNativeAppServerSession } from './appServer/native.js';
import { createCodexNativeSessionControls } from './controls.js';
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

function readCodexBackendMode(request: AgentSessionOpenRequest): 'appServer' | 'acp' {
  const environment = request.launchEnvironment?.values ?? {};
  const resolved = resolveCanonicalCodexBackendModeFromCompatInput({
    backendMode: request.configuration?.mode.value,
    codexBackendMode: request.configuration?.options.codexBackendMode?.value
      ?? environment.HAPPIER_CODEX_BACKEND_MODE
      ?? environment.CODEX_BACKEND_MODE,
  });
  return resolved === 'acp' ? 'acp' : 'appServer';
}

function requestHasStartupInstructions(request: AgentSessionOpenRequest): boolean {
  return 'startupInstructions' in request && request.startupInstructions !== undefined;
}

async function openCodexSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
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
    : await openCodexNativeAppServerSession(request, context);
  return {
    ...session,
    runtimeCapabilities: {
      ...session.runtimeCapabilities,
      localControl: backendMode === 'appServer'
        ? { supported: true, topology: 'exclusive', attachStrategy: 'terminal_host' }
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
          permissionMode,
          resolvePermissionPolicy: resolveCodexTerminalPermissionPolicy,
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
  const controls = createCodexNativeSessionControls();
  return {
    sessions: { ...controls, open: openCodexSession },
    surfaces: {
      terminal: createCodexNativeTerminalSurface(),
      handoff: codexHandoffSurface,
    },
  } satisfies AgentRuntime;
};
