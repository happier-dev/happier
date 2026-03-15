import { describe, expect, it } from 'vitest';
import { createReducer } from '../reducer';
import { runAgentStatePermissionsPhase } from './agentStatePermissions';

describe('runAgentStatePermissionsPhase (permission suggestions)', () => {
    it('persists permission suggestions onto newly-created tool permission entries', () => {
        const state = createReducer();
        const changed = new Set<string>();

        const permId = 'perm-1';
        const messageId = 'msg-1';
        const suggestions = [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }];

        runAgentStatePermissionsPhase({
            state,
            agentState: {
                controlledByUser: null,
                requests: {
                    [permId]: {
                        tool: 'ExitPlanMode',
                        arguments: { plan: 'do the thing' },
                        createdAt: 1,
                        permissionSuggestions: suggestions,
                    },
                },
                completedRequests: null,
            } as any,
            incomingToolIds: new Set<string>(),
            changed,
            allocateId: () => messageId,
            enableLogging: false,
        });

        const message = state.messages.get(messageId);
        expect((message?.tool?.permission as any)?.suggestions).toEqual(suggestions);
    });
});
