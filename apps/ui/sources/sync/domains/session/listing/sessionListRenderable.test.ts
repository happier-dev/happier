import { describe, expect, it } from 'vitest';

import { derivePendingRequestFlagsFromAgentState } from './sessionListRenderable';

describe('derivePendingRequestFlagsFromAgentState', () => {
    it('treats legacy AskUserQuestion requests without kind as user actions', () => {
        const flags = derivePendingRequestFlagsFromAgentState({
            requests: {
                req1: {
                    tool: 'AskUserQuestion',
                    arguments: {},
                    createdAt: 1,
                },
            },
            completedRequests: {},
        } as any);

        expect(flags).toEqual({
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: true,
        });
    });
});
