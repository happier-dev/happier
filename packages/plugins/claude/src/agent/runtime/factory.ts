import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import { prepareClaudeConnectedAccountKeyRequest } from './connectedAccountKeys.js';

export { claudeExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

export const createClaudeAgentRuntime: AgentRuntimeFactory = async context => {
  const { createClaudeAgentRuntime } = await import('./nativeRuntime.js');
  const runtime = await createClaudeAgentRuntime(context);
  const runs = runtime.sessions.executionRunContextV1;
  return { ...runtime, sessions: { ...runtime.sessions,
    open: (request, openContext) => runtime.sessions.open(prepareClaudeConnectedAccountKeyRequest(request), openContext),
    ...(runs ? { executionRunContextV1: { ...runs,
      open: (request, runContext) => runs.open(prepareClaudeConnectedAccountKeyRequest(request), runContext),
      ...(runs.openConversation ? { openConversation: (request, runContext) => runs.openConversation!(prepareClaudeConnectedAccountKeyRequest(request), runContext) } : {}),
    } } : {}),
  } };
};
