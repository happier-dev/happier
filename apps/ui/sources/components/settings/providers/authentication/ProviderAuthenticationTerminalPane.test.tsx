import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockTerminalStatus: 'idle' | 'connecting' | 'connected' | 'error' | 'exited' = 'idle';
const onInputMock = vi.fn();
const clearTerminalMock = vi.fn();
const requestRestartMock = vi.fn();
const retryConnectMock = vi.fn();
const dismissDetectedUrlMock = vi.fn();

vi.mock('@/components/terminal/embedded/EmbeddedTerminalPane', () => ({
    EmbeddedTerminalPane: (props: any) => React.createElement('EmbeddedTerminalPane', props),
}));

vi.mock('@/hooks/machine/useMachineTerminalSession', () => ({
    useMachineTerminalSession: () => ({
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
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useMachine: () => ({
        id: 'machine-1',
        metadata: {
            platform: 'darwin',
        },
    }),
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
        let ProviderAuthenticationTerminalPane: typeof import('./ProviderAuthenticationTerminalPane')['ProviderAuthenticationTerminalPane'];
        return providerAuthenticationTerminalPaneModulePromise.then((module) => {
            ProviderAuthenticationTerminalPane = module.ProviderAuthenticationTerminalPane;

        let tree: renderer.ReactTestRenderer;

            act(() => {
                tree = renderer.create(
                    React.createElement(ProviderAuthenticationTerminalPane, {
                        providerId: 'claude',
                        machineId: 'machine-1',
                        machineHomeDir: '/Users/tester',
                        loginLaunch: {
                            initialCommand: 'claude',
                            initialInput: '/login\r',
                        },
                        onRequestClose: vi.fn(),
                    }),
                );
            });

            expect(onInputMock).not.toHaveBeenCalled();

            act(() => {
                mockTerminalStatus = 'connected';
                tree!.update(
                    React.createElement(ProviderAuthenticationTerminalPane, {
                        providerId: 'claude',
                        machineId: 'machine-1',
                        machineHomeDir: '/Users/tester',
                        loginLaunch: {
                            initialCommand: 'claude',
                            initialInput: '/login\r',
                        },
                        onRequestClose: vi.fn(),
                    }),
                );
            });

            expect(onInputMock).toHaveBeenCalledTimes(1);
            expect(onInputMock).toHaveBeenLastCalledWith('/login\r');

            act(() => {
                mockTerminalStatus = 'connecting';
                tree!.update(
                    React.createElement(ProviderAuthenticationTerminalPane, {
                        providerId: 'claude',
                        machineId: 'machine-1',
                        machineHomeDir: '/Users/tester',
                        loginLaunch: {
                            initialCommand: 'claude',
                            initialInput: '/login\r',
                        },
                        onRequestClose: vi.fn(),
                    }),
                );
            });

            act(() => {
                mockTerminalStatus = 'connected';
                tree!.update(
                    React.createElement(ProviderAuthenticationTerminalPane, {
                        providerId: 'claude',
                        machineId: 'machine-1',
                        machineHomeDir: '/Users/tester',
                        loginLaunch: {
                            initialCommand: 'claude',
                            initialInput: '/login\r',
                        },
                        onRequestClose: vi.fn(),
                    }),
                );
            });

            expect(onInputMock).toHaveBeenCalledTimes(2);
            expect(onInputMock).toHaveBeenLastCalledWith('/login\r');
        });
    });
});
