import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { renderScreen } from '@/dev/testkit';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const serverProfilesState = vi.hoisted(() => ({
    calls: 0,
    value: [
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
        { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
    ],
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => {
        serverProfilesState.calls += 1;
        return serverProfilesState.value;
    },
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => profile.serverIdentityId ?? profile.id,
}));

type ProbeProps = Readonly<{
    activeServerSnapshot?: Readonly<{
        serverId: string;
        serverUrl: string;
        generation: number;
    }>;
    request: Readonly<{
        spawnServerIdParam?: string | null;
        persistedTargetServerId?: string | null;
    }>;
    settings?: Partial<Settings>;
    onState: (value: ReturnType<typeof useNewSessionServerTargetState>) => void;
}>;

const defaultServerSelectionSettings = {
    serverSelectionGroups: [
        { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' },
    ],
    serverSelectionActiveTargetKind: 'group',
    serverSelectionActiveTargetId: 'grp-dev',
} satisfies Partial<Settings>;

function buildSettings(overrides: Partial<Settings> = defaultServerSelectionSettings): Settings {
    return {
        ...settingsDefaults,
        ...overrides,
    };
}

function Probe(props: ProbeProps) {
    const state = useNewSessionServerTargetState({
        settings: buildSettings(props.settings),
        activeServerSnapshot: props.activeServerSnapshot ?? {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
        request: props.request,
    });
    React.useEffect(() => {
        props.onState(state);
    }, [props, state]);
    return null;
}

describe('useNewSessionServerTargetState', () => {
    beforeEach(() => {
        serverProfilesState.calls = 0;
        serverProfilesState.value = [
            { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
        ];
    });

    it('preserves listServerProfiles ordering (does not reorder by lastUsedAt)', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{}}
                    onState={(state) => captured.push(state)}
                />);

        expect(captured.at(-1)!.serverProfiles.map((profile) => profile.id)).toEqual(['server-a', 'server-c', 'server-b']);
    });

    it('does not reload server profiles when only active server generation changes', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];
        const firstActiveServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
        };

        const screen = await renderScreen(<Probe
                    activeServerSnapshot={firstActiveServerSnapshot}
                    request={{}}
                    onState={(state) => captured.push(state)}
                />);
        expect(serverProfilesState.calls).toBe(1);

        await act(async () => {
            screen.tree.update(<Probe
                        activeServerSnapshot={{
                            ...firstActiveServerSnapshot,
                            generation: 2,
                        }}
                        request={{}}
                        onState={(state) => captured.push(state)}
                    />);
        });

        expect(serverProfilesState.calls).toBe(1);
        expect(captured.at(-1)!.serverProfiles).toBe(captured.at(0)!.serverProfiles);
    });

    it('derives allowed server ids from the current active settings target and resolves requested server inside that scope', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        spawnServerIdParam: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.selectedServerTarget?.kind).toBe('group');
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-c');
        expect(latest.targetServerName).toBe('Server C');
        expect(latest.showServerPickerChip).toBe(true);
    });

    it('falls back to the first allowed group server when requested server is outside current active target scope', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        spawnServerIdParam: 'server-a',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.targetServerName).toBe('Server B');
        expect(latest.showServerPickerChip).toBe(true);
    });

    it('uses the persisted target server when no route server target is present', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        persistedTargetServerId: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-c');
        expect(latest.targetServerName).toBe('Server C');
    });

    it('lets the route server target override the persisted target server', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    request={{
                        spawnServerIdParam: 'server-b',
                        persistedTargetServerId: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.targetServerName).toBe('Server B');
    });

    it('honors an explicit server target without requiring the global active server to switch first', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    settings={{
                        serverSelectionGroups: [
                            { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' },
                        ],
                        serverSelectionActiveTargetKind: 'server',
                        serverSelectionActiveTargetId: 'server-b',
                    }}
                    request={{
                        spawnServerIdParam: 'server-b',
                    }}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.selectedServerTarget?.kind).toBe('server');
        expect(latest.selectedServerTarget?.id).toBe('server-b');
        expect(latest.allowedTargetServerIds).toEqual(['server-b']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.targetServerName).toBe('Server B');
        expect(latest.showServerPickerChip).toBe(false);
    });

    it('targets identity-backed server ids while resolving the profile by its stable profile record', async () => {
        serverProfilesState.value = [
            { id: 'localhost-18829', serverIdentityId: 'srv_identity_a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
        ] as any;
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await renderScreen(<Probe
                    activeServerSnapshot={{
                        serverId: 'srv_identity_a',
                        serverUrl: 'https://a.example.test',
                        generation: 1,
                    }}
                    settings={{
                        serverSelectionGroups: [],
                        serverSelectionActiveTargetKind: 'server',
                        serverSelectionActiveTargetId: 'localhost-18829',
                    }}
                    request={{}}
                    onState={(state) => captured.push(state)}
                />);

        const latest = captured.at(-1)!;
        expect(latest.resolvedSettingsTarget.activeServerId).toBe('srv_identity_a');
        expect(latest.targetServerId).toBe('srv_identity_a');
        expect(latest.targetServerProfile?.id).toBe('localhost-18829');
        expect(latest.targetServerName).toBe('Server A');
    });
});
