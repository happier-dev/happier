import {
  type AgentAcpRuntimeDefinition,
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
    const boundSession = prepared.bind(session);
    return {
      ...boundSession,
      runtimeCapabilities: {
        ...boundSession.runtimeCapabilities,
        localControl: mode === 'server'
          ? {
            supported: true,
            topology: 'shared',
            attachStrategy: 'provider_attach',
            remoteWritable: true,
          }
          : null,
        sessionCapabilities: {
          ...boundSession.runtimeCapabilities?.sessionCapabilities,
          sessionListing: 'supported',
          sessionFork: {
            conversation: 'supported',
            fromMessage: mode === 'server' ? 'supported' : 'unsupported',
            ...(mode === 'acp' ? { protocol: 'acp' as const } : {}),
          },
          sessionRollback: { conversation: 'unsupported' },
        },
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
      ...controlsOwner.sessions,
      open: (request, context) => openOpenCodeSession(
        request,
        context,
        controlsOwner.bindActiveSkillsReader,
      ),
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
