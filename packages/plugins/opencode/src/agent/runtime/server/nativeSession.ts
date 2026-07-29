import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import { readOpenCodeServerEndpoint } from './endpoint.js';
import { createOpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeActiveSkillsReaderRegistrar } from '../controls.js';

function readModelsService(
  context: AgentRuntimeContext,
): AgentSessionRuntimeContext['session']['services']['models'] | null {
  const session = context.session as
    | AgentSessionRuntimeContext['session']
    | Readonly<{ id: string }>
    | undefined;
  return session && 'services' in session ? session.services.models : null;
}

export async function openOpenCodeServerSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
  workState?: AgentSessionRuntimeContext['workState'],
  bindActiveSkillsReader?: OpenCodeActiveSkillsReaderRegistrar,
): Promise<AgentSessionRuntime> {
  const runtimeContext = createOpenCodeRuntimeContext(request, context, workState);
  const models = readModelsService(context);
  const env = request.launchEnvironment?.values ?? {};
  const assembly = await createOpenCodeServerRuntimeAssembly({
    ctx: runtimeContext,
    directory: request.cwd,
    happierSessionId: request.sessionId,
    endpoint: readOpenCodeServerEndpoint(runtimeContext, { env }),
    env,
    permissionMode: request.configuration?.permissionIntent.value ?? null,
    mcpServers: request.mcpServers,
    request,
    ...(models ? { models } : {}),
    ...(bindActiveSkillsReader ? { bindActiveSkillsReader } : {}),
  });
  return assembly.runtime;
}
