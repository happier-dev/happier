import { describe, expect, it } from 'vitest';

import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol';

import {
    readStaleSessionRunnerRuntimeState,
    readSessionRunnerRuntimeStateFromMetadata,
} from './sessionRunnerRuntimeStatus';

const staleRuntimeState = {
    v: 1,
    sessionId: 's1',
    machineId: 'm1',
    daemonId: 'd1',
    observedAtMs: 1_700_000_000_000,
    runner: {
        pid: 123,
        runtimeId: 'runner-runtime-old',
        cliVersion: '1.0.0',
        entrypointVersion: 'entry-old',
        processCommandHash: 'hash-old',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
    },
    daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'runner-runtime-new',
        currentEntrypointSource: 'packaged_runtime',
    },
    versionState: 'stale',
    statusSource: 'daemon_tracking',
    plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
    },
} as const;

describe('session runner runtime status reader', () => {
    it('parses the typed runtime.sessionRunner metadata field', () => {
        const parsed = readSessionRunnerRuntimeStateFromMetadata({
            [SESSION_RUNNER_RUNTIME_METADATA_KEY]: staleRuntimeState,
        });

        expect(parsed?.sessionId).toBe('s1');
        expect(parsed?.runner.processCommandHash).toBe('hash-old');
    });

    it('fails closed for absent or malformed metadata', () => {
        expect(readSessionRunnerRuntimeStateFromMetadata(null)).toBeNull();
        expect(readSessionRunnerRuntimeStateFromMetadata({
            [SESSION_RUNNER_RUNTIME_METADATA_KEY]: {
                ...staleRuntimeState,
                versionState: 'stale',
                plannedRestart: { supported: false, eligible: true },
            },
        })).toBeNull();
    });

    it('keeps canonical stale state visible when restart is busy or unavailable', () => {
        expect(readStaleSessionRunnerRuntimeState({
            metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: staleRuntimeState },
            sessionId: 's1',
            machineId: 'm1',
        })?.runner.pid).toBe(123);

        expect(readStaleSessionRunnerRuntimeState({
            metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: { ...staleRuntimeState, versionState: 'current' } },
            sessionId: 's1',
            machineId: 'm1',
        })).toBeNull();
        expect(readStaleSessionRunnerRuntimeState({
            metadata: {
                [SESSION_RUNNER_RUNTIME_METADATA_KEY]: {
                    ...staleRuntimeState,
                    plannedRestart: { supported: true, eligible: false, disabledReason: 'turn_in_progress' },
                },
            },
            sessionId: 's1',
            machineId: 'm1',
        })?.plannedRestart).toEqual({
            supported: true,
            eligible: false,
            disabledReason: 'turn_in_progress',
        });
        expect(readStaleSessionRunnerRuntimeState({
            metadata: {
                [SESSION_RUNNER_RUNTIME_METADATA_KEY]: {
                    ...staleRuntimeState,
                    plannedRestart: { supported: false, eligible: false, disabledReason: 'unsupported_backend' },
                },
            },
            sessionId: 's1',
            machineId: 'm1',
        })?.plannedRestart.disabledReason).toBe('unsupported_backend');
        expect(readStaleSessionRunnerRuntimeState({
            metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: staleRuntimeState },
            sessionId: 'other-session',
            machineId: 'm1',
        })).toBeNull();
        expect(readStaleSessionRunnerRuntimeState({
            metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: { ...staleRuntimeState, machineId: null } },
            sessionId: 's1',
            machineId: 'm1',
        })).toBeNull();
        expect(readStaleSessionRunnerRuntimeState({
            metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: { ...staleRuntimeState, machineId: 'other-machine' } },
            sessionId: 's1',
            machineId: 'm1',
        })).toBeNull();
    });

    it('keeps an exact daemon-owned stale runner actionable after the server session becomes inactive', () => {
        expect(readStaleSessionRunnerRuntimeState({
            metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: staleRuntimeState },
            sessionId: 's1',
            machineId: 'm1',
        })?.runner.pid).toBe(123);
    });

    it('fails closed when daemon-published identity guards are incomplete', () => {
        const cases = [
            { ...staleRuntimeState, machineId: null },
            {
                ...staleRuntimeState,
                runner: { ...staleRuntimeState.runner, pid: null },
            },
            {
                ...staleRuntimeState,
                runner: { ...staleRuntimeState.runner, processCommandHash: null },
            },
            {
                ...staleRuntimeState,
                runner: { ...staleRuntimeState.runner, runtimeId: null },
            },
            {
                ...staleRuntimeState,
                runner: { ...staleRuntimeState.runner, entrypointSource: 'unknown' },
            },
            {
                ...staleRuntimeState,
                daemon: { ...staleRuntimeState.daemon, currentEntrypointVersion: null },
            },
            {
                ...staleRuntimeState,
                daemon: { ...staleRuntimeState.daemon, currentEntrypointSource: 'unknown' },
            },
        ] as const;

        for (const state of cases) {
            expect(readStaleSessionRunnerRuntimeState({
                metadata: { [SESSION_RUNNER_RUNTIME_METADATA_KEY]: state },
                sessionId: 's1',
            })).toBeNull();
        }
    });
});
