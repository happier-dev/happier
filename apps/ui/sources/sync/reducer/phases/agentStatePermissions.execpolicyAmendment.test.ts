import { describe, expect, it } from 'vitest';
import { createReducer } from '../reducer';
import { runAgentStatePermissionsPhase } from './agentStatePermissions';

function createToolMessage(params: {
  id: string;
  permissionId: string;
  toolName: string;
  input: unknown;
  createdAt?: number;
}) {
  const createdAt = params.createdAt ?? 1;
  return {
    id: params.id,
    realID: null,
    role: 'agent' as const,
    createdAt,
    text: null,
    event: null,
    tool: {
      name: params.toolName,
      state: 'running' as const,
      input: params.input,
      createdAt,
      startedAt: null,
      completedAt: null,
      description: null,
      result: undefined,
      permission: {
        id: params.permissionId,
        status: 'pending' as const,
      },
    },
  };
}

describe('runAgentStatePermissionsPhase (execpolicy amendment freshness)', () => {
  it('does not drop late-arriving proposed_execpolicy_amendment when agentState still has older args', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm-1';
    const messageId = 'msg-1';

    state.toolIdToMessageId.set(permId, messageId);
    state.messages.set(
      messageId,
      createToolMessage({
        id: messageId,
        permissionId: permId,
        toolName: 'execute',
        input: {
          command: 'pwd',
          proposed_execpolicy_amendment: ['allow', 'read'],
        },
      }) as any,
    );

    const agentState = {
      requests: {
        [permId]: {
          tool: 'execute',
          arguments: {
            command: 'pwd',
          },
          createdAt: 1,
        },
      },
    };

    runAgentStatePermissionsPhase({
      state,
      agentState: agentState as any,
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => 'alloc',
      enableLogging: false,
    });

    const updated = state.messages.get(messageId);
    expect((updated?.tool as any)?.input?.proposed_execpolicy_amendment).toEqual(['allow', 'read']);
  });
});
