import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

const ENV_KEYS = [
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_TIMEOUT_MS',
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS',
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_TARGET_PREPARE_POLL_TIMEOUT_MS',
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_TIMEOUT_MS',
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_INTERVAL_MS',
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABLE_POLLS',
    'EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS',
] as const;

describe('resolveSessionHandoffRuntimeConfig', () => {
    const envBackup = new Map<string, string | undefined>();

    beforeEach(() => {
        envBackup.clear();
        for (const key of ENV_KEYS) {
            envBackup.set(key, process.env[key]);
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            const previous = envBackup.get(key);
            if (previous === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = previous;
            }
        }
    });

    it('returns the default runtime config when env vars are unset', () => {
        expect(resolveSessionHandoffRuntimeConfig()).toEqual({
            machineRpcTimeoutMs: 90_000,
            machineRpcPollTimeoutMs: 10_000,
            targetPreparePollTimeoutMs: 300_000,
            postCommitBindingStabilizationTimeoutMs: 5_000,
            postCommitBindingStabilizationIntervalMs: 250,
            postCommitBindingStablePolls: 2,
            sourceReachabilityProbeTimeoutMs: 2_500,
        });
    });

    it('clamps configured runtime values to their allowed ranges', () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_TIMEOUT_MS = '400000';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS = '500';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_TARGET_PREPARE_POLL_TIMEOUT_MS = '12345';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_TIMEOUT_MS = '100';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_INTERVAL_MS = '9000';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABLE_POLLS = '0';
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_SOURCE_REACHABILITY_PROBE_TIMEOUT_MS = '100';

        expect(resolveSessionHandoffRuntimeConfig()).toEqual({
            machineRpcTimeoutMs: 300_000,
            machineRpcPollTimeoutMs: 1_000,
            targetPreparePollTimeoutMs: 12_345,
            postCommitBindingStabilizationTimeoutMs: 500,
            postCommitBindingStabilizationIntervalMs: 5_000,
            postCommitBindingStablePolls: 1,
            sourceReachabilityProbeTimeoutMs: 250,
        });
    });
});
