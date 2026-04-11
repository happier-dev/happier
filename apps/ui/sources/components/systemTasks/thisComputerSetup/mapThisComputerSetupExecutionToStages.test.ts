import { describe, expect, it } from 'vitest';

import { mapThisComputerSetupExecutionToStages } from './mapThisComputerSetupExecutionToStages';

describe('mapThisComputerSetupExecutionToStages', () => {
    it('maps low-level setup steps into high-level running stages', () => {
        const execution = mapThisComputerSetupExecutionToStages({
            taskId: 'task-1',
            status: 'running',
            currentStepId: 'setup.thisComputer.configureRelay',
            latestMessage: 'Connecting this computer',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 5,
                    type: 'progress',
                    stepId: 'setup.thisComputer.ensureCli',
                    message: 'Installing Happier tools',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 10,
                    type: 'step',
                    stepId: 'setup.thisComputer.resolveRelay',
                    message: 'Resolving server configuration',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 20,
                    type: 'progress',
                    stepId: 'setup.thisComputer.checkAuth',
                    message: 'Checking authentication',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 30,
                    type: 'progress',
                    stepId: 'setup.thisComputer.configureRelay',
                    message: 'Connecting this computer',
                },
            ],
            result: null,
        });

        expect(execution['setup.thisComputer.stage.installTools']?.status).toBe('done');
        expect(execution['setup.thisComputer.stage.installTools']?.logs).toEqual([
            { ts: 5, level: 'info', message: 'Installing Happier tools' },
        ]);
        expect(execution['setup.thisComputer.stage.useRelay']?.status).toBe('running');
        expect(execution['setup.thisComputer.stage.useRelay']?.logs).toEqual([
            { ts: 10, level: 'info', message: 'Resolving server configuration' },
            { ts: 20, level: 'info', message: 'Checking authentication' },
            { ts: 30, level: 'info', message: 'Connecting this computer' },
        ]);
        expect(execution['setup.thisComputer.stage.registerComputer']?.status).toBe('queued');
        expect(execution['setup.thisComputer.stage.backgroundService']?.status).toBe('queued');
    });

    it('maps background-service prompts into the service-ownership stage', () => {
        const execution = mapThisComputerSetupExecutionToStages({
            taskId: 'task-1',
            status: 'running',
            currentStepId: 'setup.thisComputer.preflight.serviceConflict',
            latestMessage: 'Replace background services?',
            awaitingInput: true,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 10,
                    type: 'progress',
                    stepId: 'setup.thisComputer.resolveRelay',
                    message: 'Resolving server configuration',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 20,
                    type: 'progress',
                    stepId: 'setup.thisComputer.preflight.serviceConflict',
                    message: 'Replace background services?',
                },
            ],
            result: null,
        });

        expect(execution['setup.thisComputer.stage.backgroundService']?.status).toBe('running');
        expect(execution['setup.thisComputer.stage.backgroundService']?.logs).toEqual([
            { ts: 20, level: 'info', message: 'Replace background services?' },
        ]);
    });

    it('does not mark the optional background-service stage done after success when installService was not selected', () => {
        const execution = mapThisComputerSetupExecutionToStages({
            taskId: 'task-1',
            status: 'succeeded',
            currentStepId: null,
            latestMessage: 'Setup complete',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 5,
                    type: 'progress',
                    stepId: 'setup.thisComputer.ensureCli',
                    message: 'Installing Happier tools',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 10,
                    type: 'progress',
                    stepId: 'setup.thisComputer.configureRelay',
                    message: 'Connecting this computer',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 15,
                    type: 'progress',
                    stepId: 'setup.thisComputer.auth.wait',
                    message: 'Waiting for this computer',
                },
            ],
            result: {
                ok: true,
                protocolVersion: 1,
                taskId: 'task-1',
                data: { machineId: 'machine-local-1' },
            },
        }, ['setup.thisComputer.ensureCli', 'setup.thisComputer.resolveRelay', 'setup.thisComputer.checkAuth', 'setup.thisComputer.configureRelay', 'setup.thisComputer.auth.request', 'setup.thisComputer.auth.wait']);

        expect(execution['setup.thisComputer.stage.installTools']?.status).toBe('done');
        expect(execution['setup.thisComputer.stage.useRelay']?.status).toBe('done');
        expect(execution['setup.thisComputer.stage.registerComputer']?.status).toBe('done');
        expect(execution['setup.thisComputer.stage.backgroundService']?.status).toBe('idle');
    });

    it('marks the optional background-service stage done after success when installService was selected', () => {
        const execution = mapThisComputerSetupExecutionToStages({
            taskId: 'task-1',
            status: 'succeeded',
            currentStepId: null,
            latestMessage: 'Setup complete',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 20,
                    type: 'progress',
                    stepId: 'setup.thisComputer.installService',
                    message: 'Installing background service',
                },
            ],
            result: {
                ok: true,
                protocolVersion: 1,
                taskId: 'task-1',
                data: { machineId: 'machine-local-1' },
            },
        }, ['setup.thisComputer.installService', 'setup.thisComputer.startService', 'setup.thisComputer.verifyService']);

        expect(execution['setup.thisComputer.stage.backgroundService']?.status).toBe('done');
    });
});
