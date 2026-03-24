import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const mockMachine = {
    id: 'machine-1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: {
        host: 'localhost',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/tmp/.happy',
        homeDir: '/tmp',
    },
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
} satisfies Machine;

let mockTerminalStatus: 'idle' | 'connecting' | 'connected' | 'error' | 'exited' = 'idle';
const onInputMock = vi.fn();
const clearTerminalMock = vi.fn();
const requestRestartMock = vi.fn();
const retryConnectMock = vi.fn();
const dismissDetectedUrlMock = vi.fn();

type EmbeddedTerminalPaneMockProps = Readonly<Record<string, unknown>>;
type ProviderAuthenticationTerminalPaneProps = Readonly<{
    providerId: 'claude';
    machineId: 'machine-1';
    machineHomeDir: '/Users/tester';
    loginLaunch: Readonly<{
        initialCommand: 'claude';
        initialInput: '/login\r';
    }>;
    onRequestClose: () => void;
}>;

const createTerminalSessionMock = () => ({
    status: mockTerminalStatus,
    error: null,
    detectedUrl: null,
    clearTerminal: clearTerminalMock,
    requestRestart: requestRestartMock,
    retryConnect: retryConnectMock,
    dismissDetectedUrl: dismissDetectedUrlMock,
    onInput: onInputMock,
    onResize: vi.fn(),
    onReady: vi.fn(),
});

const createTestProps = (): ProviderAuthenticationTerminalPaneProps => ({
    providerId: 'claude',
    machineId: 'machine-1',
    machineHomeDir: '/Users/tester',
    loginLaunch: {
        initialCommand: 'claude',
        initialInput: '/login\r',
    },
    onRequestClose: vi.fn(),
});

installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const storage = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return {
            ...storage,
            useMachine: (_machineId: string) => mockMachine,
        };
    },
});

vi.mock('@/components/terminal/embedded/EmbeddedTerminalPane', () => ({
    EmbeddedTerminalPane: (props: EmbeddedTerminalPaneMockProps) => React.createElement('EmbeddedTerminalPane', props),
}));

vi.mock('@/hooks/machine/useMachineTerminalSession', () => ({
    useMachineTerminalSession: () => createTerminalSessionMock(),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

const providerAuthenticationTerminalPaneModulePromise = import('./ProviderAuthenticationTerminalPane');

describe('ProviderAuthenticationTerminalPane', () => {
    beforeEach(() => {
        mockTerminalStatus = 'idle';
        onInputMock.mockReset();
        clearTerminalMock.mockReset();
        requestRestartMock.mockReset();
        retryConnectMock.mockReset();
        dismissDetectedUrlMock.mockReset();
    });

    it('re-sends provider initial input after a reconnect cycle', () => {
        return providerAuthenticationTerminalPaneModulePromise.then(async (module) => {
            const { ProviderAuthenticationTerminalPane } = module;
            const screen = await renderScreen(<ProviderAuthenticationTerminalPane {...createTestProps()} />);

            expect(onInputMock).not.toHaveBeenCalled();

            await act(async () => {
                mockTerminalStatus = 'connected';
                screen.tree.update(<ProviderAuthenticationTerminalPane {...createTestProps()} />);
            });

            expect(onInputMock).toHaveBeenCalledTimes(1);
            expect(onInputMock).toHaveBeenLastCalledWith('/login\r');

            await act(async () => {
                mockTerminalStatus = 'connecting';
                screen.tree.update(<ProviderAuthenticationTerminalPane {...createTestProps()} />);
            });

            await act(async () => {
                mockTerminalStatus = 'connected';
                screen.tree.update(<ProviderAuthenticationTerminalPane {...createTestProps()} />);
            });

            expect(onInputMock).toHaveBeenCalledTimes(2);
            expect(onInputMock).toHaveBeenLastCalledWith('/login\r');

            await screen.unmount();
        });
    });
});
