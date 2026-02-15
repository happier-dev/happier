import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchAndApplyMachinesMock = vi.hoisted(() => vi.fn(async (_params: any) => {}));
const getCredentialsForServerUrlMock = vi.hoisted(() =>
    vi.fn<(serverUrl: string) => Promise<{ token: string; secret: string } | null>>(async (_serverUrl: string) => null)
);
const createEncryptionFromAuthCredentialsMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        listServerProfiles: () => ([
            { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
        ]),
    };
});

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: getCredentialsForServerUrlMock,
    },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: createEncryptionFromAuthCredentialsMock,
}));

vi.mock('@/sync/engine/machines/syncMachines', () => ({
    fetchAndApplyMachines: fetchAndApplyMachinesMock,
}));

type ProbeProps = Readonly<{
    allowedServerIds: string[];
    activeServerId: string;
    activeMachines: Machine[];
    refreshToken?: number;
    onGroups: (groups: ReturnType<typeof useServerScopedMachineOptions>) => void;
}>;

function Probe(props: ProbeProps) {
    const groups = useServerScopedMachineOptions({
        allowedServerIds: props.allowedServerIds,
        activeServerId: props.activeServerId,
        activeMachines: props.activeMachines,
        refreshToken: props.refreshToken,
    });
    React.useEffect(() => {
        props.onGroups(groups);
    }, [groups, props]);
    return null;
}

function createMachine(id: string): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: id,
            displayName: id,
            homeDir: '/home/me',
            platform: 'darwin',
            happyHomeDir: '/home/me/.happier',
            happyCliVersion: '0.0.0-test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('useServerScopedMachineOptions', () => {
    it('keeps active server machines and uses server-scoped machine cache for non-active servers (no extra fetch)', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];
        const activeMachine = createMachine('machine-a');
        const remoteCachedMachine = createMachine('machine-cache');
        const remoteFetchedMachine = createMachine('machine-fetch');

        getCredentialsForServerUrlMock.mockReset();
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'token', secret: 'secret' });
        createEncryptionFromAuthCredentialsMock.mockReset();
        createEncryptionFromAuthCredentialsMock.mockResolvedValue({} as any);
        fetchAndApplyMachinesMock.mockReset();
        fetchAndApplyMachinesMock.mockImplementation(async (params: any) => {
            params.applyMachines([remoteFetchedMachine], true);
        });

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': [remoteCachedMachine],
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'idle',
                },
            }));
        });

        await act(async () => {
            renderer.create(
                <Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[activeMachine]}
                    onGroups={(groups) => captured.push(groups)}
                />,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        const latest = captured.at(-1) ?? [];
        const activeGroup = latest.find((group) => group.serverId === 'server-a');
        const remoteGroup = latest.find((group) => group.serverId === 'server-b');
        expect(activeGroup?.machines.map((m) => m.id)).toEqual(['machine-a']);
        expect(remoteGroup?.machines.map((m) => m.id)).toEqual(['machine-cache']);
        expect(remoteGroup?.loading).toBe(false);
        expect(fetchAndApplyMachinesMock).not.toHaveBeenCalled();
    });

    it('marks server as signed out when no scoped credentials exist', async () => {
        const captured: Array<ReturnType<typeof useServerScopedMachineOptions>> = [];

        getCredentialsForServerUrlMock.mockReset();
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        fetchAndApplyMachinesMock.mockReset();

        act(() => {
            storage.setState((state) => ({
                ...state,
                machineListByServerId: {
                    ...state.machineListByServerId,
                    'server-b': null,
                },
                machineListStatusByServerId: {
                    ...state.machineListStatusByServerId,
                    'server-b': 'signedOut',
                },
            }));
        });

        await act(async () => {
            renderer.create(
                <Probe
                    allowedServerIds={['server-a', 'server-b']}
                    activeServerId="server-a"
                    activeMachines={[createMachine('machine-a')]}
                    onGroups={(groups) => captured.push(groups)}
                />,
            );
            await Promise.resolve();
            await Promise.resolve();
        });

        const latest = captured.at(-1) ?? [];
        const remoteGroup = latest.find((group) => group.serverId === 'server-b');
        expect(remoteGroup?.signedOut).toBe(true);
        expect(remoteGroup?.machines).toEqual([]);
        expect(fetchAndApplyMachinesMock).not.toHaveBeenCalled();
    });
});
