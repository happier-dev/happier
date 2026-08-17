import { describe, expect, it } from 'vitest';

import { resolvePluginEventAutomationTarget } from './pluginEventAutomationTarget';

describe('resolvePluginEventAutomationTarget', () => {
    it('keeps each target arm strict and derives its assignment only from that arm', () => {
        expect(resolvePluginEventAutomationTarget({
            kind: 'newSession',
            newSessionSpawn: {
                executionTarget: { serverId: 'server-new', machineId: 'machine-new' },
                directory: '/workspace/new',
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                },
            },
        })).toEqual({
            target: expect.objectContaining({ kind: 'newSession' }),
            assignmentMachineId: 'machine-new',
        });

        expect(resolvePluginEventAutomationTarget({
            kind: 'existingSession',
            existingSession: {
                sessionId: 'session-existing',
                availability: {
                    kind: 'ready',
                    machineId: 'machine-existing',
                },
            },
        })).toEqual({
            target: { kind: 'existingSession', sessionId: 'session-existing' },
            assignmentMachineId: 'machine-existing',
        });

        expect(resolvePluginEventAutomationTarget({
            kind: 'executionRun',
            executionRun: {
                machineId: 'machine-run',
                request: {
                    intent: 'task',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    permissionMode: 'no_tools',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                },
            },
        })).toEqual({
            target: expect.objectContaining({ kind: 'executionRun' }),
            assignmentMachineId: 'machine-run',
        });
    });

    it('fails closed when an existing target is no longer eligible or a detached request carries a prompt', () => {
        expect(resolvePluginEventAutomationTarget({
            kind: 'existingSession',
            existingSession: {
                sessionId: 'session-existing',
                availability: { kind: 'blocked' },
            },
        })).toBeNull();

        expect(resolvePluginEventAutomationTarget({
            kind: 'executionRun',
            executionRun: {
                machineId: 'machine-run',
                request: {
                    intent: 'task',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    instructions: 'must not persist',
                },
            },
        })).toBeNull();
    });
});
