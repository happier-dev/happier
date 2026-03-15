import { describe, expect, it } from 'vitest';
import { createReducer } from '../reducer';
import { runAgentStatePermissionsPhase } from './agentStatePermissions';

describe('runAgentStatePermissionsPhase (updatedPermissions allowlist)', () => {
  it('derives allowedTools from completed updatedPermissions addRules when allowedTools is missing', () => {
    const state = createReducer();
    const changed = new Set<string>();

    const permId = 'perm-1';
    const messageId = 'msg-1';

    runAgentStatePermissionsPhase({
      state,
      agentState: {
        controlledByUser: null,
        requests: null,
        completedRequests: {
          [permId]: {
            tool: 'Bash',
            arguments: { command: 'pwd' },
            createdAt: 1,
            completedAt: 2,
            status: 'approved',
            reason: null,
            mode: null,
            allowedTools: null,
            decision: null,
            updatedPermissions: [
              {
                type: 'addRules',
                behavior: 'allow',
                destination: 'session',
                rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
              },
            ],
          },
        },
      } as any,
      incomingToolIds: new Set<string>(),
      changed,
      allocateId: () => messageId,
      enableLogging: false,
    });

    const message = state.messages.get(messageId);
    expect(message?.tool?.permission?.allowedTools).toEqual(['Bash(pwd)']);
  });
});
