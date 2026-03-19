import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHookAndCollectValues } from '@/hooks/server/serverFeatureHookHarness.testHelpers';
import { getStorage } from '@/sync/domains/state/storage';
import { useSessionSubagents } from './useSessionSubagents';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();
const directSessionRuntimeState = {
    directSessionLink: null as null | {
        v: 1;
        providerId: string;
        machineId: string;
        remoteSessionId: string;
        source: 'provider';
    },
    status: null as null | { runnerActive?: boolean },
    refreshNow: vi.fn(async () => null),
};

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/useSessionRunningExecutionRuns', () => ({
    useSessionRunningExecutionRuns: () => [],
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => directSessionRuntimeState,
}));

beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    directSessionRuntimeState.directSessionLink = null;
    directSessionRuntimeState.status = null;
});

describe('useSessionSubagents', () => {
    it('returns an empty subagent model without crashing when execution runs are disabled', async () => {
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: null,
                messages: [],
            }),
        );

        expect(seen.at(-1)).toEqual({
            subagents: [],
            participantTargets: [],
            sidechainIds: [],
        });
    });

    it('downgrades execution-run send and stop capabilities for linked direct sessions that are not locally controlled', async () => {
        directSessionRuntimeState.directSessionLink = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-session-1',
            source: 'provider',
        };
        directSessionRuntimeState.status = { runnerActive: false };

        const now = Date.now();
        const seen = await renderHookAndCollectValues(() =>
            useSessionSubagents({
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    metadata: {
                        flavor: 'claude',
                        directSessionV1: directSessionRuntimeState.directSessionLink,
                    },
                } as any,
                messages: [{
                    kind: 'tool-call',
                    id: 'tool-call-1',
                    localId: null,
                    createdAt: now,
                    tool: {
                        id: 'toolu_run_1',
                        name: 'SubAgentRun',
                        state: 'running',
                        input: { runId: 'run_1' },
                        createdAt: now,
                        startedAt: now,
                        completedAt: null,
                        description: null,
                    },
                    children: [],
                }],
            }),
        );

        expect(seen.at(-1)).toEqual({
            subagents: [expect.objectContaining({
                id: 'execution_run:run_1',
                capabilities: expect.objectContaining({
                    canSend: false,
                    canStop: false,
                }),
            })],
            participantTargets: [],
            sidechainIds: ['toolu_run_1'],
        });
    });
});
