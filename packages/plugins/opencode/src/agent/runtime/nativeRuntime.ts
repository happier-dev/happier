import {
  createExecutionRunHostBackendFromSessionRuntime,
  type AgentAcpRuntimeDefinition,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentRuntimeFactory,
  type AgentRuntimeContext,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  resolveOpenCodeBackendMode,
} from './mode.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../systemTool.js';
import { openOpenCodeServerSession } from './server/nativeSession.js';
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

function readOpenCodeNativeMode(request: AgentSessionOpenRequest): 'server' | 'acp' {
  const modeOption = request.configuration?.options.opencodeBackendMode?.value;
  return resolveOpenCodeBackendMode({
    env: request.launchEnvironment?.values,
    accountSettings: typeof modeOption === 'string'
      ? { opencodeBackendMode: modeOption }
      : null,
  });
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
        id: OPEN_CODE_SYSTEM_TOOL_ID,
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
  context: AgentSessionRuntimeContext,
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
          context.workState,
          bindActiveSkillsReader,
        );
    return prepared.bind(session);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}

async function openOpenCodeExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind !== 'create') {
    throw new Error(`OpenCode execution runs do not support ${request.kind}.`);
  }
  const sessionRequest = {
    kind: 'create',
    sessionId: request.runId,
    cwd: request.cwd,
    ...(request.launchEnvironment
      ? { launchEnvironment: request.launchEnvironment }
      : {}),
    ...(request.configuration ? { configuration: request.configuration } : {}),
    ...(request.providerBinding ? { providerBinding: request.providerBinding } : {}),
  } as const;
  return await createExecutionRunHostBackendFromSessionRuntime({
    request,
    openSession: async () => {
      const prepared = await prepareOpenCodeQualifiedConnectedAccounts(sessionRequest, context);
      try {
        if (prepared.isInvalidated()) {
          throw new Error('OpenCode qualified Connected Account launch was invalidated before opening the runtime.');
        }
        const session = readOpenCodeNativeMode(prepared.request) === 'acp'
          ? await openOpenCodeAcpSession(prepared.request, context)
          : await openOpenCodeServerSession(prepared.request, context);
        return prepared.bind(session);
      } catch (error) {
        await prepared.dispose();
        throw error;
      }
    },
    readCheckpointId: (event) => event.kind === 'provider-session-id'
      ? event.providerSessionId
      : null,
  });
}

export const createOpenCodeAgentRuntime: AgentRuntimeFactory = () => {
  const controlsOwner = createOpenCodeNativeSessionControls();
  return {
    toolExecution: { capability: 'observable' },
    sessions: {
      ...controlsOwner.sessions,
      open: (request, context) => openOpenCodeSession(
        request,
        context,
        controlsOwner.bindActiveSkillsReader,
      ),
    },
    executionRuns: { open: openOpenCodeExecutionRun },
    surfaces: {
      handoff: openCodeHandoffSurface,
      fork: {
        resolveReplayChildLaunch: async ({ parentMetadata }) =>
          await resolveOpenCodeReplayChildLaunch({ parentMetadata }),
      },
    },
  };
};
