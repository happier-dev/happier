import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentRuntimeContext,
  AgentSessionModelsSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import { readOpenCodeServerEndpoint } from './endpoint.js';
import { createOpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeActiveSkillsReaderRegistrar } from '../controls.js';

function readSessionServices(
  context: AgentRuntimeContext,
): AgentSessionRuntimeContext['session']['services'] | null {
  const session = context.session as
    | AgentSessionRuntimeContext['session']
    | Readonly<{ id: string }>
    | undefined;
  return session && 'services' in session ? session.services : null;
}

export async function openOpenCodeServerSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
  workState?: AgentSessionRuntimeContext['workState'],
  bindActiveSkillsReader?: OpenCodeActiveSkillsReaderRegistrar,
  catalogConfidence?: AgentSessionModelsSnapshot['catalogConfidence'],
): Promise<AgentSessionRuntime> {
  const sessionServices = readSessionServices(context);
  const runtimeContext = createOpenCodeRuntimeContext(
    request,
    context,
    workState,
    sessionServices?.subagents,
    sessionServices?.transcripts,
  );
  const env = request.launchEnvironment?.values ?? {};
  const assembly = await createOpenCodeServerRuntimeAssembly({
    ctx: runtimeContext,
    directory: request.cwd,
    happierSessionId: request.sessionId,
    endpoint: readOpenCodeServerEndpoint(runtimeContext, {
      env, kind: request.kind, runtimeDescriptorV1: request.runtimeDescriptorV1,
      configuration: request.configuration,
    }),
    env,
    permissionMode: request.configuration?.permissionIntent.value ?? null,
    mcpServers: request.mcpServers,
    request,
    ...(catalogConfidence === undefined ? {} : { catalogConfidence }),
    ...(sessionServices ? { models: sessionServices.models, modes: sessionServices.modes, mcpService: sessionServices.mcp } : {}),
    ...(sessionServices?.inputFiles ? { inputFiles: sessionServices.inputFiles } : {}),
    ...(bindActiveSkillsReader ? { bindActiveSkillsReader } : {}),
  });
  return assembly.runtime;
}
