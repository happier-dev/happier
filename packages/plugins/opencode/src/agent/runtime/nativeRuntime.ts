import {
  type AgentAcpRuntimeDefinition,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentExecutionRunRuntimeContextV1,
  type AgentRuntimeFactory,
  type AgentRuntimeContext,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
  type AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  resolveOpenCodeBackendMode,
} from './mode.js';
import {
  resolveOpenCodeSystemToolId,
} from '../systemTool.js';
import { openOpenCodeServerSession } from './server/nativeSession.js';
import { openCodeTranscriptIdentityCodec } from './server/transcript/committedIdentities.js';
import { openOpenCodeServerExecutionRun } from './server/nativeExecutionRun.js';
import {
  createOpenCodeNativeSessionControls,
  type OpenCodeActiveSkillsReaderRegistrar,
} from './controls.js';
import { withOpenCodeProviderConfigLaunchEnvironment } from '../providerBinding/runtime.js';
import { prepareOpenCodeQualifiedConnectedAccounts } from '../auth/services/qualifiedPurposeLaunch.js';
import { openCodeHandoffSurface } from '../surfaces/sessions/handoff/descriptor.js';
import { resolveOpenCodeReplayChildLaunch } from '../surfaces/sessions/fork/descriptor.js';

export {
  openCodeExternalSessionsContribution,
} from '../surfaces/sessions/external/contribution.js';

const OPEN_CODE_ACP_RUNTIME_DEFINITION = {
  mcp: { policy: 'pass_through' },
  timeouts: {
    initMs: 60_000,
    toolCallMs: 120_000,
    idleMs: 1_500,
    idleWithoutAssistantMessageMs: 10_000,
  },
} satisfies AgentAcpRuntimeDefinition;

function readOpenCodeNativeMode(
  request: Parameters<NonNullable<AgentSessionRuntimeFactory['resolveTerminalPresentation']>>[0],
): 'server' | 'acp' {
  const modeOption = request.configuration?.options.opencodeBackendMode?.value;
  return resolveOpenCodeBackendMode({
    runtimeDescriptorV1: request.runtimeDescriptorV1,
    configuredBackendMode: modeOption,
    env: request.launchEnvironment?.values,
  });
}

function readOpenCodeSystemToolId(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
) {
  return resolveOpenCodeSystemToolId(
    request.configuration?.options.opencodeCliGeneration?.value,
  );
}

async function openOpenCodeAcpExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  const launchRequest = await withOpenCodeProviderConfigLaunchEnvironment(request);
  return await context.protocols.acp.openExecutionRunV1(launchRequest, {
    transport: {
      kind: 'stdio',
      executable: { kind: 'systemTool', id: readOpenCodeSystemToolId(request) },
      args: ['acp'],
      env: { NODE_ENV: 'production', DEBUG: '' },
      timeouts: { initializeMs: 60_000, toolCallMs: 120_000, idleMs: 1_500 },
    },
    definition: OPEN_CODE_ACP_RUNTIME_DEFINITION,
  });
}

async function openOpenCodeExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  const prepared = await prepareOpenCodeQualifiedConnectedAccounts(request, context);
  try {
    if (prepared.isInvalidated()) {
      throw new Error('OpenCode qualified Connected Account launch was invalidated before opening the runtime.');
    }
    const runtime = readOpenCodeNativeMode(prepared.request) === 'acp'
      ? await openOpenCodeAcpExecutionRun(prepared.request, context)
      : await openOpenCodeServerExecutionRun(prepared.request, context);
    if (prepared.isInvalidated()) {
      await runtime.dispose();
      throw new Error('OpenCode qualified Connected Account launch was invalidated while opening the runtime.');
    }
    return prepared.bindExecutionRun(runtime);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}

async function openOpenCodeAcpSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
) {
  const launchRequest = await withOpenCodeProviderConfigLaunchEnvironment(request);
  return context.protocols.acp.open(launchRequest, {
    transport: {
      kind: 'stdio',
      executable: {
        kind: 'systemTool',
        id: readOpenCodeSystemToolId(request),
      },
      args: ['acp'],
      env: {
        NODE_ENV: 'production',
        DEBUG: '',
      },
      timeouts: {
        initializeMs: 60_000,
        toolCallMs: 120_000,
        idleMs: 1_500,
      },
    },
    definition: OPEN_CODE_ACP_RUNTIME_DEFINITION,
  });
}

async function openOpenCodeSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
  bindActiveSkillsReader: OpenCodeActiveSkillsReaderRegistrar,
): Promise<AgentSessionRuntime> {
  const prepared = await prepareOpenCodeQualifiedConnectedAccounts(request, context);
  try {
    if (prepared.isInvalidated()) {
      throw new Error('OpenCode qualified Connected Account launch was invalidated before opening the runtime.');
    }
    const mode = readOpenCodeNativeMode(prepared.request);
    const session = mode === 'acp'
      ? await openOpenCodeAcpSession(prepared.request, context)
      : await openOpenCodeServerSession(
          prepared.request,
          context,
          (context as Partial<AgentSessionRuntimeContext>).workState,
          bindActiveSkillsReader,
        );
    if (prepared.isInvalidated()) {
      await session.dispose('runtime_recovery');
      throw new Error('OpenCode qualified Connected Account launch was invalidated while opening the runtime.');
    }
    const boundSession = prepared.bindSession(session);
    return {
      ...boundSession,
      ...(mode === 'acp' && typeof boundSession.compact !== 'function'
        ? {
            compact: async () => ({
              status: 'unsupported' as const,
              diagnostic: {
                code: 'opencode_acp_compaction_unsupported',
                severity: 'error' as const,
              },
              retryable: false,
            }),
          }
        : {}),
      runtimeCapabilities: {
        ...boundSession.runtimeCapabilities,
        ...(mode === 'acp'
          ? { tools: { delivery: 'native_mcp' as const, support: 'supported' as const } }
          : {}),
        localControl: mode === 'server'
          ? {
            supported: true,
            topology: 'shared',
            attachStrategy: 'provider_attach',
            remoteWritable: true,
          }
          : null,
      },
    };
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}

export const createOpenCodeAgentRuntime: AgentRuntimeFactory = () => {
  const controlsOwner = createOpenCodeNativeSessionControls();
  return {
    toolExecution: { capability: 'observable' },
    sessions: {
      transcriptIdentity: openCodeTranscriptIdentityCodec,
      ...controlsOwner.sessions,
      async resolveTerminalPresentation(selection) {
        const backendMode = readOpenCodeNativeMode(selection);
        const source = selection.runtimeDescriptorV1;
        const startingMode = selection.requestedHost === 'herdr'
          || selection.requestedHost === 'zellij'
          || selection.requestedHost === 'tmux'
          ? 'terminal' : 'remote';
        return {
          kind: backendMode === 'server' ? 'provider_attach' : 'none',
          ...(backendMode === 'server' ? { startingMode } : {}),
          runtimeDescriptorV1: {
            ...(source?.agentId === 'opencode' ? source : {}), v: 1, agentId: 'opencode',
            agent: { ...(source?.agentId === 'opencode' ? source.agent : {}), backendMode },
          },
          environmentOverlay: { HAPPIER_OPENCODE_BACKEND_MODE: backendMode },
        };
      },
      open: (request, context) => openOpenCodeSession(
        request,
        context,
        controlsOwner.bindActiveSkillsReader,
      ),
      executionRunContextV1: {
        open: (request, context) => openOpenCodeExecutionRun(request, context),
      },
    },
    surfaces: {
      handoff: openCodeHandoffSurface,
      fork: {
        resolveReplayChildLaunch: async ({ parentMetadata }) =>
          await resolveOpenCodeReplayChildLaunch({ parentMetadata }),
      },
    },
  };
};
