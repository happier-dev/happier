import { describe, expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol';

import { createActionExecutor } from '@happier-dev/protocol';

describe('createActionExecutor', () => {
    it('rejects disabled actions before executing', async () => {
        const executor = createActionExecutor({
            executionRunStart: async () => ({}),
            executionRunList: async () => ({}),
            executionRunGet: async () => ({}),
            executionRunSend: async () => ({}),
            executionRunStop: async () => ({}),
            executionRunAction: async () => ({}),
            sessionOpen: async () => ({}),
            sessionSpawnNew: async () => ({}),
            sessionSendMessage: async () => ({}),
            sessionPermissionRespond: async () => ({}),
            sessionTargetPrimarySet: async () => ({}),
            sessionTargetTrackedSet: async () => ({}),
            sessionList: async () => ({}),
            sessionActivityGet: async () => ({}),
            sessionRecentMessagesGet: async () => ({}),
            resetGlobalVoiceAgent: async () => {},
            isActionEnabled: (actionId: ActionId) => actionId !== 'review.start',
        });

        const res = await executor.execute('review.start' as ActionId, {});
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errorCode).toBe('action_disabled');
        }
    });
});
