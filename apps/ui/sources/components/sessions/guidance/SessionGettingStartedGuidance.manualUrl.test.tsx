import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { installSessionGuidanceCommonModuleMocks } from './sessionGuidanceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.hoisted(() => vi.fn(async () => null as string | null));
const connectWithUrlSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async (_text: string) => {}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: null, manifest: null },
}));

vi.mock('expo-updates', () => ({
    channel: null,
    releaseChannel: null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props, null),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({
        connectTerminal: vi.fn(),
        connectWithUrl: connectWithUrlSpy,
        isLoading: false,
    }),
}));

vi.mock('@/hooks/session/useVisibleSessionListSummaryState', () => ({
    useVisibleSessionListSummaryState: () => ({
        selection: {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        },
        summary: {
            sessionsReady: true,
            sessionCount: 0,
        },
    }),
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 1,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        listServerProfiles: () => [{ id: 's1', name: 'cloud', serverUrl: 'https://api.happier.dev' }],
    };
});

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-local',
        },
    }),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props, null),
}));

vi.mock('@/config', () => ({
    config: { variant: 'production', cliNpmDistTag: undefined },
}));

installSessionGuidanceCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { prompt: promptSpy },
        }).module;
    },
});

describe('SessionGettingStartedGuidance manual URL action', () => {
    beforeEach(() => {
        promptSpy.mockReset();
        promptSpy.mockResolvedValue(null);
        connectWithUrlSpy.mockClear();
    });

    it('prompts for a terminal URL and connects with the trimmed value', async () => {
        promptSpy.mockResolvedValueOnce('  happier://terminal?key=abc123  ');
        const { SessionGettingStartedGuidance } = await import('./SessionGettingStartedGuidance');

        const screen = await renderScreen(<SessionGettingStartedGuidance variant="phone" />);
        const manualButton = screen.findAllByType('RoundButton' as any)
            .find((node) => node.props.title === 'Enter URL manually');

        expect(manualButton).toBeTruthy();

        await act(async () => {
            await manualButton!.props.onPress();
        });

        expect(promptSpy).toHaveBeenCalledWith(
            'modals.authenticateTerminal',
            'modals.pasteUrlFromTerminal',
            expect.objectContaining({
                cancelText: 'common.cancel',
                confirmText: 'common.authenticate',
                placeholder: 'connect.terminalUrlPlaceholder',
            }),
        );
        expect(connectWithUrlSpy).toHaveBeenCalledWith('happier://terminal?key=abc123');
    });
});
