import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { prepareCodexConnectedAccountKeyRequest } from './connectedAccountKeys.js';

export { codexExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

export const createCodexAgentRuntime: AgentRuntimeFactory = async context => {
  const { createCodexAgentRuntime } = await import('./engine.js');
  const runtime = await createCodexAgentRuntime(context);
  if (!runtime.sessions) return runtime;
  const runs = runtime.sessions.executionRunContextV1;
  return { ...runtime, sessions: { ...runtime.sessions,
    open: (request, openContext) => runtime.sessions.open(prepareCodexConnectedAccountKeyRequest(request), openContext),
    ...(runs ? { executionRunContextV1: { ...runs,
      open: (request, runContext) => runs.open(prepareCodexConnectedAccountKeyRequest(request), runContext),
      ...(runs.openConversation ? { openConversation: (request, runContext) => runs.openConversation!(prepareCodexConnectedAccountKeyRequest(request), runContext) } : {}),
    } } : {}),
  } };
};
