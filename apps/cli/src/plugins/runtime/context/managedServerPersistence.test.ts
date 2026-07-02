import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
    releaseManagedServerForSwitchFromState,
    resolveManagedServerStatePath,
    type ManagedServerPersistentState,
} from './managedServerPersistence';

function hashCommandLine(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function buildState(overrides: Partial<ManagedServerPersistentState> = {}): ManagedServerPersistentState {
    return {
        v: 2,
        baseUrl: 'http://127.0.0.1:43111',
        pid: 777,
        startedAtMs: 100,
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine('provider serve --hostname=127.0.0.1 --port=43111'),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
        ...overrides,
    };
}

describe('managedServerPersistence', () => {
    it('scopes the default managed-server state path by fingerprint input without exposing raw secrets', () => {
        const env = { HOME: '/Users/example' };
        const secret = 'raw-provider-token';
        const statePath = resolveManagedServerStatePath({
            env,
            overrideEnvKey: 'HAPPIER_TEST_MANAGED_SERVER_STATE_PATH',
            namespace: 'provider',
            fingerprintInput: {
                HOME: env.HOME,
                SECRET: secret,
            },
        });

        expect(statePath).toContain('managed-servers');
        expect(statePath).not.toContain(secret);
    });

    it('releases a validated prior managed server for a selection switch', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState(),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'provider serve --hostname=127.0.0.1 --port=43111', startedAtMs: 2_501 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'owner-token-a',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 1,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: true, reason: 'released' });
        expect(killPid).toHaveBeenCalledWith(777, 9_000);
        expect(removeState).toHaveBeenCalledTimes(1);
    });

    it('keeps the managed server when another tracked session still claims it', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState(),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'provider serve --hostname=127.0.0.1 --port=43111', startedAtMs: 2_500 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'owner-token-a',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 2,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: false, reason: 'tracked_session_claimed' });
        expect(killPid).not.toHaveBeenCalled();
        expect(removeState).not.toHaveBeenCalled();
    });

    it('drops stale state without signaling when owner token mismatches', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState(),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'provider serve --hostname=127.0.0.1 --port=43111', startedAtMs: 2_500 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'another-owner-token',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 1,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: false, reason: 'owner_token_mismatch' });
        expect(killPid).not.toHaveBeenCalled();
        expect(removeState).toHaveBeenCalledTimes(1);
    });

    it('drops stale state without signaling when process identity validation fails', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState(),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'python unrelated-worker.py', startedAtMs: 2_500 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'owner-token-a',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 1,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: false, reason: 'process_identity_mismatch' });
        expect(killPid).not.toHaveBeenCalled();
        expect(removeState).toHaveBeenCalledTimes(1);
    });

    it('drops untrusted pre-v2 state files without signaling', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState({ v: undefined, ownerToken: undefined, expectedCmdlineHash: undefined }),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'provider serve --hostname=127.0.0.1 --port=43111', startedAtMs: 2_500 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'owner-token-a',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 1,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: false, reason: 'state_untrusted' });
        expect(killPid).not.toHaveBeenCalled();
        expect(removeState).toHaveBeenCalledTimes(1);
    });

    it('drops stale state when active server dir does not match', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState({ activeServerDir: '/tmp/happy/servers/another' }),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'provider serve --hostname=127.0.0.1 --port=43111', startedAtMs: 2_500 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'owner-token-a',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 1,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: false, reason: 'active_server_dir_mismatch' });
        expect(killPid).not.toHaveBeenCalled();
        expect(removeState).toHaveBeenCalledTimes(1);
    });

    it('drops stale state when daemon instance id does not match', async () => {
        const killPid = vi.fn(async () => true);
        const removeState = vi.fn(async () => {});

        const result = await releaseManagedServerForSwitchFromState({
            readState: async () => buildState({ daemonInstanceId: 'other-daemon' }),
            removeState,
            isPidAlive: () => true,
            readProcessInfo: async () => ({ command: 'provider serve --hostname=127.0.0.1 --port=43111', startedAtMs: 2_500 }),
            killPid,
            isExpectedProcessCommand: (command) => command.includes('provider serve'),
            expectedOwnerToken: 'owner-token-a',
            expectedActiveServerDir: '/tmp/happy/servers/cloud',
            expectedDaemonInstanceId: 'cloud',
            drainMs: 9_000,
            trackedClaimCount: 1,
            allowCurrentSessionClaim: true,
        });

        expect(result).toEqual({ released: false, reason: 'daemon_instance_mismatch' });
        expect(killPid).not.toHaveBeenCalled();
        expect(removeState).toHaveBeenCalledTimes(1);
    });
});
