import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => ([
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
        { id: 'server-c', name: 'Server C', serverUrl: 'https://c.example.test', lastUsedAt: 800 },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
    ]),
}));

type ProbeProps = Readonly<{
    request: Readonly<{
        spawnServerIdParam?: string | null;
    }>;
    onState: (value: ReturnType<typeof useNewSessionServerTargetState>) => void;
}>;

function Probe(props: ProbeProps) {
    const state = useNewSessionServerTargetState({
        settings: {
            serverSelectionGroups: [
                { id: 'grp-dev', name: 'Dev', serverIds: ['server-b', 'server-c'], presentation: 'grouped' },
            ],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp-dev',
        } as any,
        activeServerSnapshot: {
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
    it('preserves listServerProfiles ordering (does not reorder by lastUsedAt)', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await act(async () => {
            renderer.create(
                <Probe
                    request={{}}
                    onState={(state) => captured.push(state)}
                />,
            );
            await Promise.resolve();
        });

        expect(captured.at(-1)!.serverProfiles.map((profile) => profile.id)).toEqual(['server-a', 'server-c', 'server-b']);
    });

    it('derives allowed server ids from the current active settings target and resolves requested server inside that scope', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await act(async () => {
            renderer.create(
                <Probe
                    request={{
                        spawnServerIdParam: 'server-c',
                    }}
                    onState={(state) => captured.push(state)}
                />,
            );
            await Promise.resolve();
        });

        const latest = captured.at(-1)!;
        expect(latest.selectedServerTarget?.kind).toBe('group');
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-c');
        expect(latest.targetServerName).toBe('Server C');
        expect(latest.showServerPickerChip).toBe(true);
    });

    it('falls back to the first allowed group server when requested server is outside current active target scope', async () => {
        const captured: Array<ReturnType<typeof useNewSessionServerTargetState>> = [];

        await act(async () => {
            renderer.create(
                <Probe
                    request={{
                        spawnServerIdParam: 'server-a',
                    }}
                    onState={(state) => captured.push(state)}
                />,
            );
            await Promise.resolve();
        });

        const latest = captured.at(-1)!;
        expect(latest.allowedTargetServerIds).toEqual(['server-b', 'server-c']);
        expect(latest.targetServerId).toBe('server-b');
        expect(latest.targetServerName).toBe('Server B');
        expect(latest.showServerPickerChip).toBe(true);
    });
});
