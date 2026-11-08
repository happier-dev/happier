import {
  createExecutionRunHostBackendFromConversationRuntime,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

export type AgentExecutionRunSessionAdapterOptions = Readonly<{
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' | 'resume' }>;
  sessionId: string;
  openSession(
    request: Extract<AgentSessionOpenRequest, { kind: 'create' | 'resume' }>,
  ): AgentSessionRuntime | Promise<AgentSessionRuntime>;
  readCheckpointId?: (event: AgentSessionRuntimeEvent) => string | null;
  observeSessionUsage?: (
    event: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' | 'skill-usage' }>,
  ) => void;
}>;

/** Session identity and opening belong to the host; Run lifecycle stays in the SDK. */
export async function createExecutionRunHostBackendFromSessionRuntime(
  options: AgentExecutionRunSessionAdapterOptions,
): Promise<AgentExecutionRunRuntime> {
  const { request, sessionId } = options;
  const common = {
    sessionId,
    cwd: request.cwd,
    ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
    ...(request.configuration ? { configuration: request.configuration } : {}),
    ...(request.providerBinding ? { providerBinding: request.providerBinding } : {}),
    ...(request.stateSharing ? { stateSharing: request.stateSharing } : {}),
    ...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
    ...(request.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: request.mcpServersStrictMode } : {}),
    ...(request.mcpToolPolicy ? { mcpToolPolicy: request.mcpToolPolicy } : {}),
    ...(request.skills ? { skills: request.skills } : {}),
  };
  const sessionRequest = request.kind === 'resume'
    ? { ...common, kind: 'resume' as const, providerSessionId: request.checkpointId }
    : { ...common, kind: 'create' as const };
  return await createExecutionRunHostBackendFromConversationRuntime<AgentSessionRuntimeEvent>({
    request,
    openConversation: async () => await options.openSession(sessionRequest),
    ...(options.readCheckpointId ? { readCheckpointId: options.readCheckpointId } : {}),
    ...(options.observeSessionUsage ? { observeUsage: options.observeSessionUsage } : {}),
  });
}
