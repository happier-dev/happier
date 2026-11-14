import type {
  AgentAcpRuntimeDefinition,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeContextV1,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { prepareOhMyPiQualifiedAccounts } from '../auth/services/preparation.js';
import { OH_MY_PI_SYSTEM_TOOL_ID } from '../systemTool.js';
import { OH_MY_PI_ACP_COMMAND } from '../preflight/models.js';
import { ohMyPiProviderLaunch, ohMyPiProviderModelControls } from '../providerBinding.js';

export {
  ohMyPiExternalSessionsContribution,
} from '../surfaces/sessions/external/contribution.js';

const OH_MY_PI_ACP_RUNTIME_DEFINITION = Object.freeze({
  acceptsVerifiedImageInput: true,
  modelConfigOptionId: 'model',
  mcp: { policy: 'pass_through' as const },
}) satisfies AgentAcpRuntimeDefinition;

async function openOhMyPiExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  const prepared = await prepareOhMyPiQualifiedAccounts(request, context);
  try {
    if (prepared.isInvalidated()) {
      throw new Error('Oh My Pi qualified Connected Account launch was invalidated before opening the runtime.');
    }
    const providerLaunch = ohMyPiProviderLaunch(prepared.request.providerBinding);
    const run = await context.protocols.acp.openExecutionRunV1(
      prepared.request,
      {
        requiredFiles: providerLaunch.requiredFiles,
        transport: {
          kind: 'stdio',
          executable: {
            kind: 'systemTool',
            id: OH_MY_PI_SYSTEM_TOOL_ID,
          },
          args: [...OH_MY_PI_ACP_COMMAND.args, ...providerLaunch.args],
        },
        definition: { ...OH_MY_PI_ACP_RUNTIME_DEFINITION, models: ohMyPiProviderModelControls(prepared.request.providerBinding, prepared.nativeModelProvider) },
      },
    );
    return prepared.bindExecutionRun(run);
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
}

async function openOhMyPiSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentSessionRuntime> {
  const prepared = await prepareOhMyPiQualifiedAccounts(request, context);
  try {
    if (prepared.isInvalidated()) {
      throw new Error('Oh My Pi qualified Connected Account launch was invalidated before opening the runtime.');
    }
    const providerLaunch = ohMyPiProviderLaunch(prepared.request.providerBinding);
    const session = await context.protocols.acp.open(prepared.request, {
      requiredFiles: providerLaunch.requiredFiles,
      transport: {
        kind: 'stdio',
        executable: {
          kind: 'systemTool',
          id: OH_MY_PI_SYSTEM_TOOL_ID,
        },
        args: [...OH_MY_PI_ACP_COMMAND.args, ...providerLaunch.args],
      },
      definition: { ...OH_MY_PI_ACP_RUNTIME_DEFINITION, models: ohMyPiProviderModelControls(prepared.request.providerBinding, prepared.nativeModelProvider) },
    });
    return prepared.bind(session);
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
}

export const createOhMyPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openOhMyPiSession,
    executionRunContextV1: { open: openOhMyPiExecutionRun },
  },
});
