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
            sessionSpawnPicker: async () => ({}),
            workspacesListRecent: async () => ({ items: [] }),
            pathsListRecent: async () => ({ items: [] }),
            machinesList: async () => ({ items: [] }),
            serversList: async () => ({ items: [] }),
            agentsBackendsList: async () => ({ items: [] }),
            agentsModelsList: async () => ({ items: [] }),
            sessionSendMessage: async () => ({}),
            sessionPermissionRespond: async () => ({}),
            sessionTargetPrimarySet: async () => ({}),
            sessionTargetTrackedSet: async () => ({}),
            sessionList: async () => ({}),
            sessionActivityGet: async () => ({}),
            sessionRecentMessagesGet: async () => ({}),
            resetGlobalVoiceAgent: async () => {},
            daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
            daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
            daemonMemoryEnsureUpToDate: async () => ({ ok: true }),
            isActionEnabled: (actionId: ActionId, ctx: any) => !(actionId === 'review.start' && ctx?.surface === 'voice_tool'),
        });

        const res = await executor.execute('review.start' as ActionId, {}, { surface: 'voice_tool' } as any);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.errorCode).toBe('action_disabled');
        }
    });
});
