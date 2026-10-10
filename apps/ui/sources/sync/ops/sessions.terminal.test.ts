import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';

const machineRPC = vi.hoisted(() => vi.fn());
// Capture only the Socket.IO transport; account routing and payload construction stay real.
vi.mock('socket.io-client', async () => {
    const { createSocketHarness } = await import('@/dev/testkit/harness/socketHarness');
    const { createSocketIoManagerBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => ({
        ...createSocketHarness<Record<string, unknown>>(),
        io: createSocketIoManagerBoundaryStub(),
        connected: true,
        id: 'terminal-settings-socket',
        connect() {},
        disconnect() {},
        emitWithAck: machineRPC,
        timeout() { return { emitWithAck: machineRPC }; },
    }) };
});

import { ensureSessionRuntimeForPendingInput, resumeSession } from './sessions';

describe('session resume terminal settings', () => {
    const originalState = storage.getState();
    let serverId: string;
    beforeEach(async () => {
        machineRPC.mockReset().mockResolvedValue({ ok: true, result: { type: 'success', sessionId: 'session-1' } });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `header.${btoa(JSON.stringify({ sub: 'terminal-account' }))}.signature`,
        });
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            const body = url.includes('/v1/machines/')
                ? { machine: { id: 'machine-1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }
                : createRootLayoutFeaturesResponse();
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }));
        serverId = (await upsertServerProfile({ serverUrl: 'https://terminal-settings.example.test' })).id;
        storage.setState({
            sessions: { 'session-1': createSessionFixture() },
            machines: { 'machine-1': createMachineFixture() },
            settings: { ...settingsDefaults, sessionUseTmux: true, sessionTmuxSessionName: '', sessionTmuxIsolated: true },
        });
    });
    afterEach(async () => {
        await serverScopedRpcSocketPool.stopAll();
        storage.getState().clearSessionResuming('session-1');
        storage.setState(originalState);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const options = {
        sessionId: 'session-1',
        machineId: 'requested-machine',
        directory: '/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        accountSettingsVersionHint: 0,
    } as const;

    it.each([
        ['explicit resume', resumeSession],
        ['pending input', ensureSessionRuntimeForPendingInput],
    ] as const)('honors account tmux settings for %s', async (_label, resume) => {
        expect(await resume({ ...options, serverId })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(machineRPC).toHaveBeenCalledWith('rpc-call', expect.objectContaining({
            method: 'machine-1:spawn-happy-session',
            params: expect.objectContaining({
                type: 'resume-session',
                terminal: { mode: 'tmux', tmux: { sessionName: '', isolated: true, tmpDir: null } },
            }),
        }));
    });

    it('uses the resolved machine override instead of the stale requested machine', async () => {
        storage.setState({ settings: {
            ...storage.getState().settings,
            sessionTmuxByMachineId: {
                'machine-1': { useTmux: true, sessionName: ' work ', isolated: false, tmpDir: ' /tmp/work ' },
                'requested-machine': { useTmux: false, sessionName: '', isolated: true, tmpDir: null },
            },
        } });
        expect(await resumeSession({ ...options, serverId })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(machineRPC.mock.calls[0]?.[1].params.terminal).toEqual({
            mode: 'tmux', tmux: { sessionName: 'work', isolated: false, tmpDir: '/tmp/work' },
        });
    });

    it('omits terminal when the resolved machine disables tmux', async () => {
        storage.setState({ settings: {
            ...storage.getState().settings,
            sessionTmuxByMachineId: {
                'machine-1': { useTmux: false, sessionName: '', isolated: true, tmpDir: null },
            },
        } });
        expect(await resumeSession({ ...options, serverId })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(machineRPC.mock.calls[0]?.[1].params).not.toHaveProperty('terminal');
    });

    it('uses the exact Account settings when another Account is focused', async () => {
        const scope = { serverId, accountId: 'terminal-account' };
        saveAccountSettings(scope, { ...settingsDefaults, sessionUseTmux: true, sessionTmuxSessionName: 'scoped-account' }, 1);
        storage.setState({
            settingsScope: { serverId, accountId: 'focused-account' },
            settings: { ...settingsDefaults, sessionUseTmux: true, sessionTmuxSessionName: 'focused-account' },
        });
        expect(await ensureSessionRuntimeForPendingInput({
            ...options, serverId, machineId: 'machine-1',
            accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        })).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(machineRPC.mock.calls[0]?.[1].params.terminal).toEqual({
            mode: 'tmux', tmux: { sessionName: 'scoped-account', isolated: true, tmpDir: null },
        });
        expect(storage.getState().sessions['session-1']?.resumingAt ?? null).toBeNull();
    });
});
