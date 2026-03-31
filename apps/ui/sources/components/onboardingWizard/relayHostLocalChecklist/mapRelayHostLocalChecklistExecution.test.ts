import { describe, expect, it } from 'vitest';

import type { SystemTaskRunState } from '@/components/systemTasks/types';

import { buildRelayHostLocalChecklistItems } from './buildRelayHostLocalChecklistItems';
import { mapRelayHostLocalChecklistExecution } from './mapRelayHostLocalChecklistExecution';

function createSnapshot(overrides: Partial<SystemTaskRunState> = {}): SystemTaskRunState {
    return {
        taskId: 'task_1',
        status: 'running',
        currentStepId: 'relay.install',
        latestMessage: 'Installing relay runtime',
        awaitingInput: false,
        cancelRequested: false,
        events: [
            {
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 100,
                type: 'progress',
                stepId: 'relay.install',
                message: 'Installing relay runtime',
            },
        ],
        result: null,
        ...overrides,
    };
}

describe('mapRelayHostLocalChecklistExecution', () => {
    it('maps running install events onto the correct row logs', () => {
        const items = buildRelayHostLocalChecklistItems({
            runtimeStatus: {
                installed: false,
                version: null,
                relayUrl: 'http://localhost:53288',
                healthy: false,
                service: { active: false, enabled: false },
            },
            currentRelayUrl: 'http://localhost:53288',
            currentShareableUrl: null,
        });

        const execution = mapRelayHostLocalChecklistExecution({
            items,
            selectedIds: ['installRelayRuntime', 'startRelayRuntime', 'enableSecureAccess'],
            activeItemId: 'installRelayRuntime',
            activeSnapshot: createSnapshot(),
            completedItemIds: [],
            failedItemIds: [],
            logsById: {},
            errorById: {},
        });

        expect(execution.installRelayRuntime.status).toBe('running');
        expect(execution.installRelayRuntime.logs).toHaveLength(1);
        expect(execution.installRelayRuntime.logs[0]?.message).toBe('Installing relay runtime');
        expect(execution.startRelayRuntime.status).toBe('queued');
        expect(execution.enableSecureAccess.status).toBe('queued');
    });

    it('marks completed rows as done and failed rows as error', () => {
        const items = buildRelayHostLocalChecklistItems({
            runtimeStatus: {
                installed: true,
                version: '1.2.3',
                relayUrl: 'http://localhost:53288',
                healthy: false,
                service: { active: false, enabled: false },
            },
            currentRelayUrl: 'http://localhost:53288',
            currentShareableUrl: null,
        });

        const execution = mapRelayHostLocalChecklistExecution({
            items,
            selectedIds: ['enableSecureAccess'],
            activeItemId: 'enableSecureAccess',
            activeSnapshot: createSnapshot({
                currentStepId: 'tailscale.serveEnable',
                latestMessage: 'Enabling secure access',
                events: [
                    {
                        protocolVersion: 1,
                        taskId: 'task_1',
                        tsMs: 100,
                        type: 'progress',
                        stepId: 'tailscale.serveEnable',
                        message: 'Enabling secure access',
                    },
                ],
                result: {
                    protocolVersion: 1,
                    taskId: 'task_1',
                    ok: false,
                    error: { code: 'prompt_required', message: 'Need approval' },
                } as never,
            }),
            completedItemIds: ['installRelayRuntime'],
            failedItemIds: ['startRelayRuntime'],
            logsById: {},
            errorById: {
                startRelayRuntime: 'Need approval',
            },
        });

        expect(execution.installRelayRuntime.status).toBe('done');
        expect(execution.startRelayRuntime.status).toBe('error');
        expect(execution.enableSecureAccess.status).toBe('running');
        expect(execution.enableSecureAccess.errorMessage).toBeNull();
    });
});
