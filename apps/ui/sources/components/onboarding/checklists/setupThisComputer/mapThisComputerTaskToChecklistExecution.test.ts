import { describe, expect, it } from 'vitest';

import { mapThisComputerTaskToChecklistExecution } from './mapThisComputerTaskToChecklistExecution';

describe('mapThisComputerTaskToChecklistExecution', () => {
    it('maps snapshot events into row-scoped logs and running statuses', () => {
        const execution = mapThisComputerTaskToChecklistExecution({
            taskId: 'task-1',
            status: 'running',
            currentStepId: 'setup.thisComputer.configureRelay',
            latestMessage: 'Connecting to relay',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 10,
                    type: 'step',
                    stepId: 'setup.thisComputer.resolveRelay',
                    message: 'Checking relay',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 20,
                    type: 'progress',
                    stepId: 'setup.thisComputer.configureRelay',
                    message: 'Connecting to relay',
                },
            ],
            result: null,
        });

        expect(execution['setup.thisComputer.resolveRelay']?.status).toBe('done');
        expect(execution['setup.thisComputer.resolveRelay']?.logs).toEqual([
            { ts: 10, level: 'info', message: 'Checking relay' },
        ]);
        expect(execution['setup.thisComputer.configureRelay']?.status).toBe('running');
        expect(execution['setup.thisComputer.configureRelay']?.logs).toEqual([
            { ts: 20, level: 'info', message: 'Connecting to relay' },
        ]);
        expect(execution['setup.thisComputer.installService']?.status).toBe('queued');
        expect(execution['setup.thisComputer.installTailscale']?.status).toBe('running');
    });

    it('marks the current row as error when the task fails', () => {
        const execution = mapThisComputerTaskToChecklistExecution({
            taskId: 'task-1',
            status: 'failed',
            currentStepId: 'setup.thisComputer.installService',
            latestMessage: 'install failed',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 10,
                    type: 'step',
                    stepId: 'setup.thisComputer.installService',
                    message: 'Installing service',
                },
            ],
            result: {
                protocolVersion: 1,
                taskId: 'task-1',
                ok: false,
                error: {
                    code: 'daemon_service_not_ready',
                    message: 'Service did not become ready',
                },
            },
        });

        expect(execution['setup.thisComputer.installService']?.status).toBe('error');
        expect(execution['setup.thisComputer.installService']?.error).toEqual({
            title: 'daemon_service_not_ready',
            message: 'Service did not become ready',
            raw: {
                code: 'daemon_service_not_ready',
                message: 'Service did not become ready',
            },
        });
        expect(execution['setup.thisComputer.installTailscale']?.status).toBe('idle');
    });
});
